import * as v from 'valibot';
import type {TranslationBindings} from './translations/bindings.ts';
import type {TranslationRuntime,PreviewInspection} from './translations/api-types.ts';
import type {TranslationRun,TranslationScope,TranslationUsage} from './translations/types.ts';
import {readTranslationForRepair,settleTranslationUsage} from './translations/storage.ts';

const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const time=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(8640000000000000-300000));
const token=v.pipe(v.string(),v.uuid());
const count=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
const usageSchema=v.strictObject({input:count,output:count,cacheRead:count,cacheWrite:count});
const metadataSchema=v.strictObject({usageReported:v.boolean(),outputValid:v.boolean(),usage:v.nullable(usageSchema)});
type TranslationClaim={kind:'translation';runId:string;scope:TranslationScope;token:string};
export type UsageRepairClaim=TranslationClaim;
export type UsageRepairBindings=TranslationBindings;

type TranslationRow={runId:string;organizationId:string;storeId:string;conversationId:string};
function safeUsage(value:unknown):TranslationUsage|null{
 const parsed=v.safeParse(usageSchema,value);if(!parsed.success)return null;const usage=parsed.output;
 return usage.output>0&&usage.input+usage.cacheRead+usage.cacheWrite>0?usage:null;
}
function translationMatches(state:PreviewInspection,run:TranslationRun){
 return (['id','requestId','organizationId','storeId','conversationId','actorUserId','actorMemberId','source','sourceHash','sourceRevision','budgetId'] as const)
  .every(key=>state.run[key]===run[key]);
}
export async function claimUsageRepairs(db:D1Database,now:number,limitPerKind=25):Promise<UsageRepairClaim[]>{
 v.parse(time,now);v.parse(v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(25)),limitPerKind);
 const translationToken=crypto.randomUUID(),due=now+60000;
 const translations=await db.prepare(`UPDATE reply_preview_run SET repair_due_at=?,repair_token=? WHERE id IN
   (SELECT id FROM reply_preview_run WHERE settlement='held' AND repair_due_at<=? ORDER BY repair_due_at,id LIMIT ?)
   RETURNING id AS runId,organization_id AS organizationId,store_id AS storeId,conversation_id AS conversationId`).bind(due,translationToken,now,limitPerKind).all<TranslationRow>();
 const a=translations.results.map(row=>v.parse(v.strictObject({kind:v.literal('translation'),runId:id,
  scope:v.strictObject({organizationId:id,storeId:id,conversationId:id}),token}),{kind:'translation',runId:row.runId,scope:{organizationId:row.organizationId,storeId:row.storeId,conversationId:row.conversationId},token:translationToken}));
 return [...a];
}
export async function finishUsageRepair(db:D1Database,claim:UsageRepairClaim){
 const now=Date.now();v.parse(time,now);const table='reply_preview_run';
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
type Dependencies={translationRuntime?:TranslationRuntime};
/** Persistent, actor-independent cost repair. It never dispatches or retries a provider request. */
export async function repairFinancialUsage(env:UsageRepairBindings,deps:Dependencies={}){
 if(!env.DB||(!env.FLUE_REPLY_PREVIEW_AGENT&&!env.AGENT_RUNTIME))return;
 const claims=await claimUsageRepairs(env.DB,Date.now());
 const translation=(env.FLUE_REPLY_PREVIEW_AGENT||env.AGENT_RUNTIME)?(deps.translationRuntime??(await import('./translations/runtime.ts')).createTranslationRuntime(env)):null;
 for(let offset=0;offset<claims.length;offset+=5)await Promise.allSettled(claims.slice(offset,offset+5).map(async claim=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([translation?reconcileTranslation(env.DB!,claim,translation):Promise.resolve(),
   new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('USAGE_REPAIR_TIMEOUT')),3000);})]);}
  finally{clearTimeout(timer);await finishUsageRepair(env.DB!,claim);}
 }));
}
