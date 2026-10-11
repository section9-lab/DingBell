import * as v from 'valibot';
import { replyTestBudgetCommandSchema,type ReplyTestBudgetCommand,type ReplyTestBudgetView,type ReplyTestBudgetWorkspace } from '../../shared/reply-test-budget.ts';
import { budgetColumns,readReplyTestBudget,type ReplyTestBudget } from './storage.ts';
import type { ControlActor } from '../conversations/control-types.ts';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const actorSchema=v.strictObject({orgId:id,actorUserId:id,sessionId:id,expectedMemberId:v.optional(id)});
const cursorSchema=v.tuple([v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(8640000000000000)),id]);
const now="CAST(unixepoch('subsecond')*1000 AS INTEGER)";
const managerSQL=`SELECT actor.id AS memberId,caller.name FROM member actor JOIN user caller ON caller.id=actor.user_id JOIN session login ON login.user_id=caller.id
  WHERE actor.organization_id=? AND actor.user_id=? AND login.id=? AND login.expires_at>${now} AND caller.email_verified=1 AND actor.role IN ('owner','admin')
  AND (? IS NULL OR actor.id=?)`;
const values=(actor:ControlActor)=>[actor.orgId,actor.actorUserId,actor.sessionId,actor.expectedMemberId??null,actor.expectedMemberId??null];
const access=(db:D1Database,actor:ControlActor)=>db.prepare(managerSQL).bind(...values(actor)).first<{memberId:string;name:string}>();
type BudgetRow=Omit<ReplyTestBudget,'enabled'>&{enabled:number|boolean};
function view(b:BudgetRow):ReplyTestBudgetView{
  const available=BigInt(b.limitMicros)-BigInt(b.reservedMicros)-BigInt(b.spentMicros);
  const {organizationId,...value}=b;return {...value,enabled:b.enabled===true||b.enabled===1,remainingMicros:available>0n?Number(available):0,remainingRuns:b.maxRuns-b.admittedRuns};
}
type Receipt={id:string;action:'create'|'set_enabled';budgetId:string;revision:number;enabled:boolean};
type Change={outcome:'applied'|'existing';budget:ReplyTestBudgetView;command:Receipt}|{outcome:'not_found'|'conflict'|'changed'|'overlap'|'expired'};
type AuditRow={id:string;action:Receipt['action'];budgetId:string;revision:number;enabled:number;actorUserId:string;actorMemberId:string;payload:string};
const auditColumns='id,action,budget_id AS budgetId,revision,enabled,actor_user_id AS actorUserId,actor_member_id AS actorMemberId,payload';
async function replay(db:D1Database,actor:ControlActor,input:ReplyTestBudgetCommand):Promise<Change|null>{
  const row=await db.prepare(`SELECT ${auditColumns} FROM reply_test_budget_audit WHERE id=? AND organization_id=? AND EXISTS (${managerSQL})`).bind(input.id,actor.orgId,...values(actor)).first<AuditRow>();
  if(!row)return null;
  if(row.actorUserId!==actor.actorUserId||row.actorMemberId!==actor.expectedMemberId)return {outcome:'not_found'};
  if(row.payload!==JSON.stringify(input))return {outcome:'conflict'};
  const budget=await readReplyTestBudget(db,actor,row.budgetId);if(!budget||!await access(db,actor))return {outcome:'not_found'};
  return {outcome:'existing',budget:view(budget),command:{id:row.id,action:row.action,budgetId:row.budgetId,revision:row.revision,enabled:row.enabled===1}};
}
/** Public management commands. The audit and budget transition share one D1 transaction. */
export async function changeReplyTestBudget(db:D1Database,actor:ControlActor,value:unknown):Promise<Change>{
  actor=v.parse(actorSchema,{...actor});const input=v.parse(replyTestBudgetCommandSchema,structuredClone(value));
  if(!actor.expectedMemberId)return {outcome:'not_found'};
  const manager=await access(db,actor);if(!manager)return {outcome:'not_found'};
  const previous=await replay(db,actor,input);if(previous)return previous;
  if(input.action==='create'&&(input.endsAt<=Date.now()||input.startsAt<Math.floor(Date.now()/86400000)*86400000))return {outcome:'expired'};
  const target=input.action==='create'?input.id:input.budgetId,token=crypto.randomUUID();
  const mutation=input.action==='create'
    ?db.prepare(`INSERT INTO reply_test_budget(id,organization_id,starts_at,ends_at,limit_micros,max_runs,commit_token)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS (${managerSQL}) AND NOT EXISTS (SELECT 1 FROM reply_test_budget WHERE organization_id=? AND starts_at<? AND ends_at>?)
      AND NOT EXISTS (SELECT 1 FROM reply_test_budget_audit WHERE id=?) ON CONFLICT(id) DO NOTHING RETURNING id`)
      .bind(target,actor.orgId,input.startsAt,input.endsAt,input.limitMicros,input.maxRuns,token,...values(actor),actor.orgId,input.endsAt,input.startsAt,input.id)
    :db.prepare(`UPDATE reply_test_budget SET enabled=?,revision=revision+1,commit_token=? WHERE id=? AND organization_id=? AND revision=? AND revision<9007199254740991
      AND enabled<>? AND (?=0 OR ends_at>${now}) AND EXISTS (${managerSQL}) AND NOT EXISTS (SELECT 1 FROM reply_test_budget_audit WHERE id=?) RETURNING id`)
      .bind(Number(input.enabled),token,target,actor.orgId,input.expectedRevision,Number(input.enabled),Number(input.enabled),...values(actor),input.id);
  const result=await db.batch([mutation,
    db.prepare(`INSERT INTO reply_test_budget_audit(id,organization_id,budget_id,actor_user_id,actor_member_id,actor_name,action,payload,revision,enabled,created_at)
      SELECT ?,organization_id,id,?,?,?,?,?,revision,enabled,${now} FROM reply_test_budget WHERE id=? AND organization_id=? AND commit_token=?`)
      .bind(input.id,actor.actorUserId,manager.memberId,Array.from(manager.name).slice(0,256).join(''),input.action,JSON.stringify(input),target,actor.orgId,token),
    db.prepare('UPDATE reply_test_budget SET commit_token=NULL WHERE id=? AND organization_id=? AND commit_token=?').bind(target,actor.orgId,token),
  ]);
  const recorded=await replay(db,actor,input);if(recorded)return recorded.outcome==='existing'&&result[0].results.length===1?{...recorded,outcome:'applied'}:recorded;
  if(!await access(db,actor))return {outcome:'not_found'};
  if(input.action==='create'){
    if(await db.prepare('SELECT 1 FROM reply_test_budget WHERE organization_id=? AND starts_at<? AND ends_at>?').bind(actor.orgId,input.endsAt,input.startsAt).first())return {outcome:'overlap'};
    return {outcome:'conflict'};
  }
  const budget=await readReplyTestBudget(db,actor,target);return !budget?{outcome:'not_found'}:budget.endsAt<=Date.now()&&input.enabled?{outcome:'expired'}:{outcome:'changed'};
}
export async function readReplyTestBudgets(db:D1Database,actor:ControlActor,before?:string):Promise<Omit<ReplyTestBudgetWorkspace,'configuration'>|null>{
  actor=v.parse(actorSchema,{...actor});const manager=await access(db,actor);if(!manager)return null;actor={...actor,expectedMemberId:manager.memberId};
  const cursor=before===undefined?null:v.parse(cursorSchema,JSON.parse(before));if(before!==undefined&&JSON.stringify(cursor)!==before)throw new Error('INVALID_BUDGET_CURSOR');
  const at=Date.now(),queryDate=new Date(at).toISOString().slice(0,10);
  const results=await db.batch([
    db.prepare(`SELECT ${budgetColumns} FROM reply_test_budget WHERE organization_id=? AND starts_at<=? AND ends_at>? AND EXISTS (${managerSQL}) LIMIT 1`).bind(actor.orgId,at,at,...values(actor)),
    db.prepare(`SELECT ${budgetColumns} FROM reply_test_budget WHERE organization_id=? AND (? IS NULL OR starts_at<? OR (starts_at=? AND id<?)) AND EXISTS (${managerSQL}) ORDER BY starts_at DESC,id DESC LIMIT 21`)
      .bind(actor.orgId,cursor?.[0]??null,cursor?.[0]??null,cursor?.[0]??null,cursor?.[1]??null,...values(actor)),
    db.prepare(`SELECT id,action,budget_id AS budgetId,revision,enabled,actor_name AS actorName,created_at AS createdAt FROM reply_test_budget_audit WHERE organization_id=? AND EXISTS (${managerSQL}) ORDER BY created_at DESC,id DESC LIMIT 10`).bind(actor.orgId,...values(actor)),
    db.prepare(`SELECT count(*) AS queries,COALESCE(sum(reserved_micros),0) AS reservedMicros FROM reply_test_query WHERE organization_id=? AND quota_day=? AND EXISTS (${managerSQL})`).bind(actor.orgId,queryDate,...values(actor)),
  ]);
  if(!await access(db,actor))return null;
  const rows=results[1].results as unknown as BudgetRow[],budgets=rows.slice(0,20).map(view),last=budgets.at(-1);
  const totals=results[3].results[0] as unknown as ReplyTestBudgetWorkspace['queryToday'];
  return {companyId:actor.orgId,viewerMemberId:manager.memberId,at,currentBudget:results[0].results[0]?view(results[0].results[0] as unknown as BudgetRow):null,
    budgets,nextBefore:rows.length>20?JSON.stringify([last!.startsAt,last!.id]):null,
    events:(results[2].results as unknown as (Omit<ReplyTestBudgetWorkspace['events'][number],'enabled'>&{enabled:number})[]).map(e=>({...e,enabled:e.enabled===1})),
    queryToday:{queries:totals.queries,reservedMicros:totals.reservedMicros}};
}
