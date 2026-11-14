import { NOW_MS, sqlManagesCompany } from '../../platform/database/sql.ts';
import * as v from 'valibot';
import {budgetAuditIdSchema,budgetAuditKindSchema,companyBudgetAuditSchema,companyBudgetReconciliationSummarySchema,type BudgetAuditKind,type CompanyBudgetAudit,type CompanyBudgetReconciliationSummary} from '../../shared/budget-audit.ts';
import type {ControlActor} from '../conversations/control-types.ts';

const actorSchema=v.strictObject({orgId:budgetAuditIdSchema,actorUserId:budgetAuditIdSchema,sessionId:budgetAuditIdSchema,expectedMemberId:v.optional(budgetAuditIdSchema)});
const now = NOW_MS;
const manager=`SELECT actor.id AS memberId FROM member actor JOIN user caller ON caller.id=actor.user_id JOIN session login ON login.user_id=caller.id
  WHERE actor.organization_id=? AND actor.user_id=? AND login.id=? AND login.expires_at>${now} AND caller.email_verified=1 AND ${sqlManagesCompany('actor.role')}
  AND (? IS NULL OR actor.id=?)`;
const values=(actor:ControlActor)=>[actor.orgId,actor.actorUserId,actor.sessionId,actor.expectedMemberId??null,actor.expectedMemberId??null];
const access=(db:D1Database,actor:ControlActor)=>db.prepare(manager).bind(...values(actor)).first<{memberId:string}>();

// Table identifiers come exclusively from this closed mapping, never request text.
const ledgers={
  ai:{budget:'ai_budget',counts:true,entries:`SELECT
    (CASE WHEN r.closure IS NULL THEN (r.max_generations-r.generations)*r.per_generation_micros ELSE 0 END)
      +sum(CASE WHEN g.run_id IS NOT NULL AND g.usage IS NULL THEN r.per_generation_micros ELSE 0 END) AS reserved,
    COALESCE(sum(g.charged_micros),0) AS spent,1 AS admitted,0 AS embedding,0 AS correlated,
    CASE WHEN count(g.run_id)<>r.generations OR COALESCE(max(g.sequence),0)<>r.generations THEN 1 ELSE 0 END AS invalid
    FROM selected b JOIN ai_execution r ON r.budget_id=b.id AND r.organization_id=b.organization_id
    LEFT JOIN ai_generation g ON g.run_id=r.id GROUP BY r.id`},
} as const;
type AuditRow={at:number;reserved:string;spent:string;admitted:string|null;expectedReserved:string;expectedSpent:string;expectedAdmitted:string|null;embedding:string;correlated:string;invalid:number;commitToken:string|null};
type MonitoringRow={status:'balanced'|'mismatch'|null;observedAt:number|null;nextDueAt:number;mismatchSince:number|null;consecutiveMismatches:number;lastErrorAt:number|null;lastErrorCode:'AUDIT_UNAVAILABLE'|null;consecutiveFailures:number};
type SummaryRow={at:number;tracked:number;pending:number;balanced:number;mismatch:number;unavailable:number;alerting:number};
type AlertRow=MonitoringRow&{kind:BudgetAuditKind;budgetId:string};
const delta=(recorded:string,expected:string)=>(BigInt(recorded)-BigInt(expected)).toString();
async function totals(db:D1Database,organizationId:string,kind:BudgetAuditKind,budgetId:string,authorization:unknown[]|null){
 const ledger=ledgers[kind],guard=authorization?` AND EXISTS (${manager})`:'';
 // Counters and source records share one SQLite statement snapshot. SUM stays integer; TEXT avoids JS precision loss.
 return db.prepare(`WITH selected AS (
   SELECT id,organization_id,reserved_micros,spent_micros,${ledger.counts?'admitted_runs':'NULL AS admitted_runs'},commit_token
   FROM ${ledger.budget} WHERE id=? AND organization_id=?${guard}
  ), entries AS (${ledger.entries}), totals AS (
   SELECT COALESCE(sum(reserved),0) AS reserved,COALESCE(sum(spent),0) AS spent,COALESCE(sum(admitted),0) AS admitted,
    COALESCE(sum(embedding),0) AS embedding,COALESCE(sum(correlated),0) AS correlated,COALESCE(sum(invalid),0) AS invalid FROM entries
  ) SELECT ${now} AS at,CAST(b.reserved_micros AS TEXT) AS reserved,CAST(b.spent_micros AS TEXT) AS spent,
   CAST(b.admitted_runs AS TEXT) AS admitted,CAST(t.reserved AS TEXT) AS expectedReserved,CAST(t.spent AS TEXT) AS expectedSpent,
   ${ledger.counts?'CAST(t.admitted AS TEXT)':'NULL'} AS expectedAdmitted,CAST(t.embedding AS TEXT) AS embedding,
   CAST(t.correlated AS TEXT) AS correlated,t.invalid,b.commit_token AS commitToken FROM selected b CROSS JOIN totals t`)
  .bind(budgetId,organizationId,...(authorization??[])).first<AuditRow>();
}
function snapshot(companyId:string,kind:BudgetAuditKind,budgetId:string,row:AuditRow){
 const difference={reservedMicros:delta(row.reserved,row.expectedReserved),spentMicros:delta(row.spent,row.expectedSpent),admittedRuns:row.admitted===null?null:delta(row.admitted,row.expectedAdmitted!)};
 return {companyId,kind,budgetId,at:row.at,status:Object.values(difference).every(value=>value===null||value==='0')&&row.invalid===0&&row.commitToken===null?'balanced' as const:'mismatch' as const,
  recorded:{reservedMicros:row.reserved,spentMicros:row.spent,admittedRuns:row.admitted},expected:{reservedMicros:row.expectedReserved,spentMicros:row.expectedSpent,admittedRuns:row.expectedAdmitted},difference,
  embeddingReservedMicros:row.embedding,embeddingCorrelatedMicros:row.correlated,embeddingUncorrelatedMicros:(BigInt(row.embedding)-BigInt(row.correlated)).toString(),invalidExecutions:row.invalid,
  canRelease:false as const,supplierCostsVerified:false as const};
}
/** Internal scheduler boundary. This computes arithmetic only and grants no read, release or dispatch authority. */
export async function readBudgetAuditForRepair(db:D1Database,organizationId:string,kind:BudgetAuditKind,budgetId:string){
 organizationId=v.parse(budgetAuditIdSchema,organizationId);kind=v.parse(budgetAuditKindSchema,kind);budgetId=v.parse(budgetAuditIdSchema,budgetId);
 const row=await totals(db,organizationId,kind,budgetId,null);return row?snapshot(organizationId,kind,budgetId,row):null;
}
/** Read-only arithmetic audit. Balanced totals are neither supplier invoices nor release/dispatch authorization. */
export async function readCompanyBudgetAudit(db:D1Database,actor:ControlActor,kind:BudgetAuditKind,budgetId:string):Promise<CompanyBudgetAudit|null>{
 actor=v.parse(actorSchema,{...actor});kind=v.parse(budgetAuditKindSchema,kind);budgetId=v.parse(budgetAuditIdSchema,budgetId);
 const viewer=await access(db,actor);if(!viewer)return null;actor={...actor,expectedMemberId:viewer.memberId};
 const row=await totals(db,actor.orgId,kind,budgetId,values(actor));if(!row)return null;
 const monitoring=await db.prepare(`SELECT status,observed_at AS observedAt,next_due_at AS nextDueAt,mismatch_since AS mismatchSince,
  consecutive_mismatches AS consecutiveMismatches,last_error_at AS lastErrorAt,last_error_code AS lastErrorCode,consecutive_failures AS consecutiveFailures
  FROM budget_reconciliation_state WHERE organization_id=? AND kind=? AND budget_id=?`).bind(actor.orgId,kind,budgetId).first<MonitoringRow>();
 if(!await access(db,actor))return null;
 return v.parse(companyBudgetAuditSchema,{...snapshot(actor.orgId,kind,budgetId,row),viewerMemberId:viewer.memberId,monitoring:monitoring??null});
}

export async function readCompanyBudgetReconciliationSummary(db:D1Database,actor:ControlActor):Promise<CompanyBudgetReconciliationSummary|null>{
 actor=v.parse(actorSchema,{...actor});const viewer=await access(db,actor);if(!viewer)return null;actor={...actor,expectedMemberId:viewer.memberId};
 const authorization=values(actor),where=`organization_id=? AND EXISTS (${manager})`;
 const [summaryResult,itemsResult]=await db.batch([
  db.prepare(`SELECT ${now} AS at,count(*) AS tracked,COALESCE(sum(status IS NULL),0) AS pending,COALESCE(sum(status='balanced'),0) AS balanced,
   COALESCE(sum(status='mismatch'),0) AS mismatch,COALESCE(sum(consecutive_failures>0),0) AS unavailable,
   COALESCE(sum(status='mismatch' OR consecutive_failures>0),0) AS alerting FROM budget_reconciliation_state WHERE ${where}`).bind(actor.orgId,...authorization),
  db.prepare(`SELECT kind,budget_id AS budgetId,status,observed_at AS observedAt,next_due_at AS nextDueAt,mismatch_since AS mismatchSince,
   consecutive_mismatches AS consecutiveMismatches,last_error_at AS lastErrorAt,last_error_code AS lastErrorCode,consecutive_failures AS consecutiveFailures
   FROM budget_reconciliation_state WHERE ${where} AND (status IS NULL OR status='mismatch' OR consecutive_failures>0)
   ORDER BY (consecutive_failures>0) DESC,(status='mismatch') DESC,COALESCE(last_error_at,mismatch_since,next_due_at) ASC,kind,budget_id LIMIT 51`).bind(actor.orgId,...authorization),
 ]);
 if(!await access(db,actor))return null;
 const row=(summaryResult.results as SummaryRow[])[0];if(!row)return null;const all=itemsResult.results as AlertRow[];
 return v.parse(companyBudgetReconciliationSummarySchema,{companyId:actor.orgId,viewerMemberId:viewer.memberId,at:row.at,
  totals:{tracked:row.tracked,pending:row.pending,balanced:row.balanced,mismatch:row.mismatch,unavailable:row.unavailable,alerting:row.alerting},items:all.slice(0,50),truncated:all.length>50});
}
