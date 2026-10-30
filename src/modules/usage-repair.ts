import * as v from 'valibot';
import type {ControlScope} from './conversations/control-types.ts';
import type {TranslationBindings} from './translations/bindings.ts';
import type {TranslationRuntime,PreviewInspection} from './translations/api-types.ts';
import type {TranslationRun,TranslationScope,TranslationUsage} from './translations/types.ts';
import {readTranslationForRepair,settleTranslationUsage} from './translations/storage.ts';
import type {ReplyTestBindings,ReplyTestInspection,ReplyTestRuntime} from './reply-tests/execution.ts';
import {readReplyTestForRepair,settleReplyTestUsage,type ReplyTestRun} from './reply-tests/storage.ts';

const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const time=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(8640000000000000-300000));
const token=v.pipe(v.string(),v.uuid());
const count=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
const usageSchema=v.strictObject({input:count,output:count,cacheRead:count,cacheWrite:count});
const metadataSchema=v.strictObject({usageReported:v.boolean(),outputValid:v.boolean(),usage:v.nullable(usageSchema)});
type TranslationClaim={kind:'translation';runId:string;scope:TranslationScope;token:string};
type ReplyTestClaim={kind:'reply-test';runId:string;scope:ControlScope;token:string};
export type UsageRepairClaim=TranslationClaim|ReplyTestClaim;
export type UsageRepairBindings=TranslationBindings&ReplyTestBindings;

type TranslationRow={runId:string;organizationId:string;storeId:string;conversationId:string};
type ReplyTestRow=TranslationRow&{controllerId:string};
function safeUsage(value:unknown):TranslationUsage|null{
 const parsed=v.safeParse(usageSchema,value);if(!parsed.success)return null;const usage=parsed.output;
 return usage.output>0&&usage.input+usage.cacheRead+usage.cacheWrite>0?usage:null;
}
function translationMatches(state:PreviewInspection,run:TranslationRun){
 return (['id','requestId','organizationId','storeId','conversationId','actorUserId','actorMemberId','source','sourceHash','sourceRevision','budgetId'] as const)
  .every(key=>state.run[key]===run[key]);
}
function replyTestMatches(state:ReplyTestInspection,run:ReplyTestRun){
 return state.run.id===run.id&&state.run.payloadHash===run.payloadHash&&state.run.requestId===run.requestId&&state.run.budgetId===run.budgetId
  &&JSON.stringify(state.run.config)===JSON.stringify(run.config);
}
export async function claimUsageRepairs(db:D1Database,now:number,limitPerKind=25):Promise<UsageRepairClaim[]>{
 v.parse(time,now);v.parse(v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(25)),limitPerKind);
 const translationToken=crypto.randomUUID(),replyToken=crypto.randomUUID(),due=now+60000;
 const [translations,tests]=await db.batch([
  db.prepare(`UPDATE reply_preview_run SET repair_due_at=?,repair_token=? WHERE id IN
   (SELECT id FROM reply_preview_run WHERE settlement='held' AND repair_due_at<=? ORDER BY repair_due_at,id LIMIT ?)
   RETURNING id AS runId,organization_id AS organizationId,store_id AS storeId,conversation_id AS conversationId`).bind(due,translationToken,now,limitPerKind),
  db.prepare(`UPDATE reply_test_run SET repair_due_at=?,repair_token=? WHERE id IN
   (SELECT id FROM reply_test_run WHERE settlement='held' AND repair_due_at<=? ORDER BY repair_due_at,id LIMIT ?)
   RETURNING id AS runId,organization_id AS organizationId,store_id AS storeId,conversation_id AS conversationId,json_extract(payload,'$.context.scope.controllerId') AS controllerId`).bind(due,replyToken,now,limitPerKind),
 ]);
 const a=(translations.results as TranslationRow[]).map(row=>v.parse(v.strictObject({kind:v.literal('translation'),runId:id,
  scope:v.strictObject({organizationId:id,storeId:id,conversationId:id}),token}),{kind:'translation',runId:row.runId,scope:{organizationId:row.organizationId,storeId:row.storeId,conversationId:row.conversationId},token:translationToken}));
 const b=(tests.results as ReplyTestRow[]).map(row=>v.parse(v.strictObject({kind:v.literal('reply-test'),runId:id,
  scope:v.strictObject({organizationId:id,storeId:id,conversationId:id,controllerId:id}),token}),{kind:'reply-test',runId:row.runId,scope:{organizationId:row.organizationId,storeId:row.storeId,conversationId:row.conversationId,controllerId:row.controllerId},token:replyToken}));
 return [...a,...b];
}
export async function finishUsageRepair(db:D1Database,claim:UsageRepairClaim){
 const now=Date.now();v.parse(time,now);const table=claim.kind==='translation'?'reply_preview_run':'reply_test_run';
 await db.prepare(`UPDATE ${table} SET repair_token=NULL,repair_due_at=CASE WHEN settlement='held' THEN ? ELSE NULL END WHERE id=? AND repair_token=?`)
  .bind(now+300000,claim.runId,claim.token).run();
}
async function reconcileTranslation(db:D1Database,claim:TranslationClaim,runtime:TranslationRuntime){
 const run=await readTranslationForRepair(db,claim.scope,claim.runId);if(!run||run.settlement!=='held')return;
 if(!run.receipt||(await runtime.lookup(run.id))?.uid!==run.receipt.uid)return;
 let result:Awaited<ReturnType<TranslationRuntime['read']>>;try{result=await runtime.read(run.id,run.receipt);}catch{return;}
 const state=await runtime.inspect(run.id);if(!state||!translationMatches(state,run)||(await runtime.lookup(run.id))?.uid!==run.receipt.uid)return;
 const evidenceUsage=state.evidence?.complete&&state.evidence.usageReported?safeUsage(state.evidence.usage):null;
 const meta=result.outcome==='completed'?v.safeParse(metadataSchema,result.metadata&&typeof result.metadata==='object'?(result.metadata as Record<string,unknown>).preview:null):null;
 const metadataUsage=meta?.success&&meta.output.usageReported?safeUsage(meta.output.usage):null,usage=evidenceUsage??metadataUsage;
 if(usage){await settleTranslationUsage(db,claim.scope,run.id,run.receipt,usage);return;}
 if(result.outcome==='failed'&&state.http===0)await runtime.close(claim.scope,run.id);
}
async function reconcileReplyTest(db:D1Database,claim:ReplyTestClaim,runtime:ReplyTestRuntime){
 const run=await readReplyTestForRepair(db,claim.scope,claim.runId);if(!run||run.settlement!=='held')return;
 if(!run.receipt||(await runtime.lookup(run.id))?.uid!==run.receipt.uid)return;
 let result:Awaited<ReturnType<ReplyTestRuntime['read']>>;try{result=await runtime.read(run.id,run.receipt);}catch{return;}
 const state=await runtime.inspect(run.id);if(!state||!replyTestMatches(state,run)||(await runtime.lookup(run.id))?.uid!==run.receipt.uid)return;
 const evidenceUsage=state.evidence?.complete&&state.evidence.usageReported?safeUsage(state.evidence.usage):null;
 const meta=result.outcome==='completed'?v.safeParse(metadataSchema,result.metadata&&typeof result.metadata==='object'?(result.metadata as Record<string,unknown>).replyTest:null):null;
 const metadataUsage=meta?.success&&meta.output.usageReported?safeUsage(meta.output.usage):null,usage=evidenceUsage??metadataUsage;
 if(usage){await settleReplyTestUsage(db,claim.scope,run.id,run.receipt,usage);return;}
 if(result.outcome==='failed'&&state.http===0)await runtime.close(claim.scope,run.id);
}
type Dependencies={translationRuntime?:TranslationRuntime;replyTestRuntime?:ReplyTestRuntime};
/** Persistent, actor-independent cost repair. It never dispatches or retries a provider request. */
export async function repairFinancialUsage(env:UsageRepairBindings,deps:Dependencies={}){
 if(!env.DB||(!env.FLUE_REPLY_PREVIEW_AGENT&&!env.FLUE_REPLY_TEST_AGENT&&!env.AGENT_RUNTIME))return;
 const claims=await claimUsageRepairs(env.DB,Date.now());
 const translation=(env.FLUE_REPLY_PREVIEW_AGENT||env.AGENT_RUNTIME)?(deps.translationRuntime??(await import('./translations/runtime.ts')).createTranslationRuntime(env)):null;
 const replyTest=(env.FLUE_REPLY_TEST_AGENT||env.AGENT_RUNTIME)?(deps.replyTestRuntime??(await import('./reply-tests/runtime.ts')).createReplyTestRuntime(env)):null;
 for(let offset=0;offset<claims.length;offset+=5)await Promise.allSettled(claims.slice(offset,offset+5).map(async claim=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([claim.kind==='translation'?(translation?reconcileTranslation(env.DB!,claim,translation):Promise.resolve()):(replyTest?reconcileReplyTest(env.DB!,claim,replyTest):Promise.resolve()),
   new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('USAGE_REPAIR_TIMEOUT')),3000);})]);}
  finally{clearTimeout(timer);await finishUsageRepair(env.DB!,claim);}
 }));
}
