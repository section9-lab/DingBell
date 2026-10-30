import * as v from 'valibot';
import { readControlAccess } from '../conversations/control-storage.ts';
import { replyBodySchema } from '../conversations/control-state.ts';
import { admitTranslationPreview,bindTranslationReceipt,freezeTranslationOutput,readTranslationRun,settleTranslationUsage } from './storage.ts';
import type { TranslationBindings } from './bindings.ts';
import type { TranslationActor,TranslationRun } from './types.ts';
import type { PreviewInspection,ReplyPreviewResult,ReplyPreviewView,TranslationRuntime,TranslationServiceDeps } from './api-types.ts';

type Target={conversationId:string;expectedMemberId:string};
type Input={requestId:string;source:string;sourceRevision:number};
type Query=Target&{requestId:string;storeId:string};
const scopeOf=(run:TranslationRun)=>({organizationId:run.organizationId,storeId:run.storeId,conversationId:run.conversationId});
type Presentation=Pick<ReplyPreviewView,'status'|'translation'|'reason'>;
const unknown=(reason='EXECUTION_UNCONFIRMED'):Presentation=>({status:'unconfirmed',translation:null,reason});
const unavailable=(reason:string):Presentation=>({status:'unavailable',translation:null,reason});
const count=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
const metadataSchema=v.strictObject({usageReported:v.boolean(),outputValid:v.boolean(),usage:v.nullable(v.strictObject({input:count,output:count,cacheRead:count,cacheWrite:count}))});
async function authorized(db:D1Database,actor:TranslationActor,target:Target,requestId:string){
  const access=await readControlAccess(db,actor,target.conversationId);
  if(!access||access.memberId!==target.expectedMemberId)return null;
  const query:Query={...target,requestId,storeId:access.storeId};
  return {query,run:await readTranslationRun(db,actor,query)};
}
async function runtime(env:TranslationBindings,deps:TranslationServiceDeps){
  return deps.translationRuntime??(await import('./runtime.ts')).createTranslationRuntime(env);
}
function matching(ledger:PreviewInspection,run:TranslationRun){
  return (['id','requestId','organizationId','storeId','conversationId','actorUserId','actorMemberId','source','sourceHash','sourceRevision','budgetId'] as const).every(key=>ledger.run[key]===run[key]);
}
async function present(db:D1Database,actor:TranslationActor,query:Query,value:Presentation):Promise<ReplyPreviewResult>{
  // Every response containing original text or a translation gets a final SQL
  // authorization check, including slow reads and lost-receipt recovery.
  const run=await readTranslationRun(db,actor,query);if(!run)return {outcome:'not_found'};
  return {outcome:'found',preview:{requestId:run.requestId,source:run.source,sourceRevision:run.sourceRevision,targetLanguage:'ru',
    status:value.status,translation:value.translation,reason:value.reason,usageStatus:run.settlement}};
}
async function observe(db:D1Database,actor:TranslationActor,query:Query,run:TranslationRun,native:TranslationRuntime,allowClose:boolean):Promise<ReplyPreviewResult>{
  if(run.settlement==='released')return present(db,actor,query,unavailable('EXECUTION_CLOSED'));
  if(!run.receipt)return present(db,actor,query,unknown('RECEIPT_UNCONFIRMED'));
  let result:Awaited<ReturnType<TranslationRuntime['read']>>;
  try{
    if((await native.lookup(run.id))?.uid!==run.receipt.uid)return present(db,actor,query,unknown('AUTHORITY_UNAVAILABLE'));
    result=await native.read(run.id,run.receipt);
    if((await native.lookup(run.id))?.uid!==run.receipt.uid)return present(db,actor,query,unknown('AUTHORITY_UNAVAILABLE'));
  }catch{return present(db,actor,query,unknown());}
  if(result.outcome==='pending')return present(db,actor,query,{status:'pending',translation:null,reason:null});
  if(result.outcome==='failed'){
    if(allowClose){
      try{const ledger=await native.inspect(run.id);if(ledger&&matching(ledger,run)&&ledger.http===0)await native.close(scopeOf(run),run.id);}
      catch{return present(db,actor,query,unknown());}
    }
    return present(db,actor,query,unavailable('EXECUTION_FAILED'));
  }
  const meta=result.metadata&&typeof result.metadata==='object'?(result.metadata as Record<string,unknown>).preview:null;
  const parsed=v.safeParse(metadataSchema,meta);
  let reason:string|null='USAGE_UNCONFIRMED';
  if(parsed.success&&parsed.output.usageReported&&parsed.output.usage){
    const usage=parsed.output.usage;
    if(usage.output>0&&usage.input+usage.cacheRead+usage.cacheWrite>0){
      try{await settleTranslationUsage(db,scopeOf(run),run.id,run.receipt,usage);reason=null;}
      catch{reason='SETTLEMENT_UNCONFIRMED';}
    }
  }
  if(!parsed.success||!parsed.output.outputValid||!v.is(replyBodySchema,result.text))return present(db,actor,query,unavailable('INVALID_OUTPUT'));
  try{await freezeTranslationOutput(db,scopeOf(run),run.id,run.receipt,result.text);}
  catch{return present(db,actor,query,unknown('OUTPUT_UNCONFIRMED'));}
  return present(db,actor,query,{status:'ready',translation:result.text,reason});
}
export async function submitReplyPreview(env:TranslationBindings,actor:TranslationActor,target:Target,input:Input,deps:TranslationServiceDeps={}):Promise<ReplyPreviewResult>{
  if(!env.DB)return {outcome:'rejected',code:'RUNTIME_UNAVAILABLE'};
  const access=await authorized(env.DB,actor,target,input.requestId);if(!access)return {outcome:'not_found'};
  let run=access.run;
  if(run){if(run.source!==input.source||run.sourceRevision!==input.sourceRevision)return {outcome:'conflict'};}
  else{
    if(env.TRANSLATION_ENABLED!=='true')return {outcome:'rejected',code:'TRANSLATION_DISABLED'};
    if((!env.FLUE_REPLY_PREVIEW_AGENT&&!env.AGENT_RUNTIME)||typeof env.NVAPI_KEY!=='string'||!env.NVAPI_KEY.trim())return {outcome:'rejected',code:'RUNTIME_UNAVAILABLE'};
    const admitted=await admitTranslationPreview(env.DB,actor,{...access.query,source:input.source,sourceRevision:input.sourceRevision},env);
    if(admitted.outcome==='not_found'||admitted.outcome==='conflict')return {outcome:admitted.outcome};
    if(!('run'in admitted))return {outcome:'rejected',code:admitted.outcome==='disabled'?'TRANSLATION_DISABLED':admitted.outcome==='budget_unavailable'?'BUDGET_UNAVAILABLE':'PRICING_UNAVAILABLE'};
    run=admitted.run;
  }
  const native=await runtime(env,deps);
  if(run.receipt||run.settlement==='released')return observe(env.DB,actor,access.query,run,native,true);
  try{
    const instance=await native.lookup(run.id);
    if(!instance&&run.providerRequestClaimedAt!==null)return present(env.DB,actor,access.query,unknown('AUTHORITY_UNAVAILABLE'));
    const ledger=await native.inspect(run.id);
    if(ledger){
      if(!matching(ledger,run))return present(env.DB,actor,access.query,unknown('AUTHORITY_UNAVAILABLE'));
      if(ledger.closed){await native.close(scopeOf(run),run.id);return present(env.DB,actor,access.query,unavailable('EXECUTION_CLOSED'));}
    }else{
      if(instance||run.providerRequestClaimedAt!==null)return present(env.DB,actor,access.query,unknown('AUTHORITY_UNAVAILABLE'));
      await native.prepare(scopeOf(run),run.id);
    }
    const receipt=await native.dispatch(run);
    await bindTranslationReceipt(env.DB,scopeOf(run),run.id,receipt);
  }catch{return present(env.DB,actor,access.query,unknown('RECEIPT_UNCONFIRMED'));}
  const saved=await readTranslationRun(env.DB,actor,access.query);if(!saved)return {outcome:'not_found'};
  return observe(env.DB,actor,access.query,saved,native,true);
}
export async function readReplyPreview(env:TranslationBindings,actor:TranslationActor,target:Target,requestId:string,deps:TranslationServiceDeps={}):Promise<ReplyPreviewResult>{
  if(!env.DB)return {outcome:'rejected',code:'RUNTIME_UNAVAILABLE'};
  const access=await authorized(env.DB,actor,target,requestId);if(!access?.run)return {outcome:'not_found'};
  return observe(env.DB,actor,access.query,access.run,await runtime(env,deps),false);
}
