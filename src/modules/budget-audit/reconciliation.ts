import * as v from 'valibot';
import {readBudgetAuditForRepair} from './storage.ts';
import type {BudgetAuditKind} from '../../shared/budget-audit.ts';

const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const time=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(8640000000000000-900000));
const limitSchema=v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(50));
type Row={organizationId:string;kind:BudgetAuditKind;budgetId:string;consecutiveMismatches:number;consecutiveFailures:number};
export type BudgetReconciliationClaim=Row&{token:string};
const count=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
const retryDelay=(previous:number)=>Math.min(3600000,300000*2**Math.min(previous,4));

export async function claimBudgetReconciliations(db:D1Database,now:number,limit=25):Promise<BudgetReconciliationClaim[]>{
 v.parse(time,now);v.parse(limitSchema,limit);const token=crypto.randomUUID();
 const [result]=await db.batch([db.prepare(`UPDATE budget_reconciliation_state SET lease_token=?,next_due_at=?,updated_at=? WHERE rowid IN
  (SELECT rowid FROM budget_reconciliation_state WHERE next_due_at<=? ORDER BY next_due_at,organization_id,kind,budget_id LIMIT ?)
  RETURNING organization_id AS organizationId,kind,budget_id AS budgetId,consecutive_mismatches AS consecutiveMismatches,consecutive_failures AS consecutiveFailures`).bind(token,now+60000,now,now,limit)]);
 return (result.results as Row[]).map(row=>v.parse(v.strictObject({organizationId:id,kind:v.picklist(['ai','translation','reply-test']),budgetId:id,consecutiveMismatches:count,consecutiveFailures:count,token:v.pipe(v.string(),v.uuid())}),{...row,token}));
}
function payloadOf(value:NonNullable<Awaited<ReturnType<typeof readBudgetAuditForRepair>>>){
 const {companyId:_,at:__,canRelease:___,supplierCostsVerified:____,...financial}=value;
 return JSON.stringify({schemaVersion:1,...financial});
}
export async function finishBudgetReconciliation(db:D1Database,claim:BudgetReconciliationClaim,now:number){
 const audit=await readBudgetAuditForRepair(db,claim.organizationId,claim.kind,claim.budgetId);
 if(!audit)throw new Error('BUDGET_RECONCILIATION_TARGET_MISSING');
 const mismatch=audit.status==='mismatch',next=now+(mismatch?retryDelay(claim.consecutiveMismatches):900000),payload=payloadOf(audit);
 await db.prepare(`UPDATE budget_reconciliation_state SET status=?,payload=?,observed_at=?,next_due_at=?,lease_token=NULL,
  mismatch_since=CASE WHEN ? THEN COALESCE(mismatch_since,?) ELSE NULL END,
  consecutive_mismatches=CASE WHEN ? THEN CASE WHEN status='mismatch' THEN min(consecutive_mismatches+1,9007199254740991) ELSE 1 END ELSE 0 END,
  last_error_at=NULL,last_error_code=NULL,consecutive_failures=0,updated_at=?
  WHERE organization_id=? AND kind=? AND budget_id=? AND lease_token=?`).bind(audit.status,payload,now,next,mismatch?1:0,now,mismatch?1:0,now,claim.organizationId,claim.kind,claim.budgetId,claim.token).run();
}
export async function failBudgetReconciliation(db:D1Database,claim:BudgetReconciliationClaim,now:number){
 await db.prepare(`UPDATE budget_reconciliation_state SET lease_token=NULL,next_due_at=?,last_error_at=?,last_error_code='AUDIT_UNAVAILABLE',
  consecutive_failures=min(consecutive_failures+1,9007199254740991),updated_at=?
  WHERE organization_id=? AND kind=? AND budget_id=? AND lease_token=?`).bind(now+retryDelay(claim.consecutiveFailures),now,now,claim.organizationId,claim.kind,claim.budgetId,claim.token).run();
}
/** Arithmetic-only monitor. It cannot prepare, dispatch, settle or release supplier work. */
export async function reconcileBudgetLedgers(env:{DB?:D1Database}){
 if(!env.DB)return;const now=Date.now(),claims=await claimBudgetReconciliations(env.DB,now);
 for(let offset=0;offset<claims.length;offset+=5)await Promise.allSettled(claims.slice(offset,offset+5).map(async claim=>{
  try{await finishBudgetReconciliation(env.DB!,claim,Date.now());}catch{await failBudgetReconciliation(env.DB!,claim,Date.now());}
 }));
}
