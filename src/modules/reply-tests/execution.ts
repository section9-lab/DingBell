import * as v from 'valibot';
import type { Agent } from 'agents';
import { getConversationController,type ControlBindings } from '../conversations/control-bindings.ts';
import type { ControlActor,ControlScope } from '../conversations/control-types.ts';
import type { TranslationReceipt } from '../translations/types.ts';
import type { PreviewEvidence } from '../translations/transport.ts';
import { bindReplyTestReceipt,readReplyTestRun,settleReplyTestUsage,type ReplyTestRun } from './storage.ts';
import { reviewReplyTest,type ReplyTestControlReader } from './service.ts';

export interface ReplyTestBindings extends ControlBindings {REPLY_TEST_ENABLED?:string;NVAPI_KEY?:string;FLUE_REPLY_TEST_AGENT?:DurableObjectNamespace<Agent>}
export interface ReplyTestInspection {run:ReplyTestRun;generation:number;http:number;closed:boolean;evidence:PreviewEvidence|null}
export interface ReplyTestRuntime {
  lookup(id:string):Promise<{uid?:string}|null>;
  prepare(scope:ControlScope,id:string):Promise<void>;
  inspect(id:string):Promise<ReplyTestInspection|null>;
  dispatch(run:ReplyTestRun):Promise<TranslationReceipt>;
  read(id:string,receipt:TranslationReceipt):Promise<{outcome:'completed';text:string;metadata:unknown}|{outcome:'pending'}|{outcome:'failed'}>;
  close(scope:ControlScope,id:string):Promise<void>;
}
type Target={requestId:string;memberId:string};
type Review=Awaited<ReturnType<typeof reviewReplyTest>>;
type View={status:'review_required'|'pending'|'unconfirmed'|'unavailable';review:Review|null;reason:string|null};
export type ReplyTestResult={outcome:'not_found'}|({outcome:'found';requestId:string;usageStatus:ReplyTestRun['settlement']}&View);
type Dependencies={control?:ReplyTestControlReader;runtime?:ReplyTestRuntime};
const count=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
const metadataSchema=v.strictObject({usageReported:v.boolean(),outputValid:v.boolean(),usage:v.nullable(v.strictObject({input:count,output:count,cacheRead:count,cacheWrite:count}))});
const unknown=(reason='EXECUTION_UNCONFIRMED'):View=>({status:'unconfirmed',review:null,reason});
const unavailable=(reason:string):View=>({status:'unavailable',review:null,reason});
const matching=(state:ReplyTestInspection,run:ReplyTestRun)=>state.run.id===run.id&&state.run.payloadHash===run.payloadHash&&state.run.requestId===run.requestId
  &&state.run.budgetId===run.budgetId&&JSON.stringify(state.run.config)===JSON.stringify(run.config);
export const replyTestControl=(env:ControlBindings):ReplyTestControlReader=>(scope,actor)=>getConversationController(env,scope.controllerId).read(scope,actor);
async function native(env:ReplyTestBindings,deps:Dependencies){return deps.runtime??(await import('./runtime.ts')).createReplyTestRuntime(env);}
async function present(db:D1Database,actor:ControlActor,target:Target,value:View):Promise<ReplyTestResult>{
  const current=await readReplyTestRun(db,actor,target.requestId,target.memberId);
  return current?{outcome:'found',requestId:current.requestId,usageStatus:current.settlement,...value}:{outcome:'not_found'};
}
async function observe(db:D1Database,actor:ControlActor,target:Target,run:ReplyTestRun,runtime:ReplyTestRuntime,control:ReplyTestControlReader):Promise<ReplyTestResult>{
  if(run.settlement==='released')return present(db,actor,target,unavailable('EXECUTION_CLOSED'));
  if(!run.receipt)return present(db,actor,target,unknown('RECEIPT_UNCONFIRMED'));
  let result:Awaited<ReturnType<ReplyTestRuntime['read']>>;
  try{
    if((await runtime.lookup(run.id))?.uid!==run.receipt.uid)return present(db,actor,target,unknown('AUTHORITY_UNAVAILABLE'));
    result=await runtime.read(run.id,run.receipt);
    if((await runtime.lookup(run.id))?.uid!==run.receipt.uid)return present(db,actor,target,unknown('AUTHORITY_UNAVAILABLE'));
  }catch{return present(db,actor,target,unknown());}
  if(result.outcome==='pending')return present(db,actor,target,{status:'pending',review:null,reason:null});
  if(result.outcome==='failed'){
    try{
      const state=await runtime.inspect(run.id);
      if(state&&matching(state,run)){
        if(state.http===0)await runtime.close(run.payload.context.scope,run.id);
        else if(state.evidence?.complete&&state.evidence.usageReported&&state.evidence.usage)
          await settleReplyTestUsage(db,run.payload.context.scope,run.id,run.receipt,state.evidence.usage);
      }
    }catch{return present(db,actor,target,unknown());}
    return present(db,actor,target,unavailable('EXECUTION_FAILED'));
  }
  const meta=v.safeParse(metadataSchema,result.metadata&&typeof result.metadata==='object'?(result.metadata as Record<string,unknown>).replyTest:null);
  let reason:string|null='USAGE_UNCONFIRMED';
  if(meta.success&&meta.output.usageReported&&meta.output.usage&&meta.output.usage.output>0
    &&meta.output.usage.input+meta.output.usage.cacheRead+meta.output.usage.cacheWrite>0){
    try{await settleReplyTestUsage(db,run.payload.context.scope,run.id,run.receipt,meta.output.usage);reason=null;}
    catch{reason='SETTLEMENT_UNCONFIRMED';}
  }
  if(!meta.success||!meta.output.outputValid)return present(db,actor,target,unavailable('INVALID_OUTPUT'));
  let candidate:unknown;try{candidate=JSON.parse(result.text);}catch{return present(db,actor,target,unavailable('INVALID_OUTPUT'));}
  try{
    const review=await reviewReplyTest(db,control,actor,run.payload.context,run.payload.evidence,candidate);
    return present(db,actor,target,{status:'review_required',review,reason});
  }catch(error){
    if(error instanceof Error&&error.message.startsWith('REPLY_TEST_'))return present(db,actor,target,unavailable(error.message));
    throw error;
  }
}
/** Internal service: the run was already prepared and reserved by trusted server code. No browser-supplied context, tools or outgoing messages. */
export async function executeReplyTest(env:ReplyTestBindings,actor:ControlActor,target:Target,deps:Dependencies={}):Promise<ReplyTestResult>{
  if(!env.DB)return {outcome:'not_found'};
  const run=await readReplyTestRun(env.DB,actor,target.requestId,target.memberId);if(!run)return {outcome:'not_found'};
  const runtime=await native(env,deps),control=deps.control??replyTestControl(env);
  if(run.receipt||run.settlement==='released')return observe(env.DB,actor,target,run,runtime,control);
  try{
    const instance=await runtime.lookup(run.id),state=await runtime.inspect(run.id);
    if(state){
      if(!matching(state,run))return present(env.DB,actor,target,unknown('AUTHORITY_UNAVAILABLE'));
      if(state.closed){await runtime.close(run.payload.context.scope,run.id);return present(env.DB,actor,target,unavailable('EXECUTION_CLOSED'));}
    }else{
      if(instance||run.providerRequestClaimedAt!==null)return present(env.DB,actor,target,unknown('AUTHORITY_UNAVAILABLE'));
      if(env.REPLY_TEST_ENABLED!=='true')return present(env.DB,actor,target,unavailable('REPLY_TEST_DISABLED'));
      await runtime.prepare(run.payload.context.scope,run.id);
    }
    if(!instance&&(env.REPLY_TEST_ENABLED!=='true'||run.providerRequestClaimedAt!==null))return present(env.DB,actor,target,unknown('AUTHORITY_UNAVAILABLE'));
    const receipt=await runtime.dispatch(run);await bindReplyTestReceipt(env.DB,run.payload.context.scope,run.id,receipt);
  }catch{return present(env.DB,actor,target,unknown('RECEIPT_UNCONFIRMED'));}
  const saved=await readReplyTestRun(env.DB,actor,target.requestId,target.memberId);if(!saved)return {outcome:'not_found'};
  return observe(env.DB,actor,target,saved,runtime,control);
}
export async function readExecutedReplyTest(env:ReplyTestBindings,actor:ControlActor,target:Target,deps:Dependencies={}):Promise<ReplyTestResult>{
  if(!env.DB)return {outcome:'not_found'};
  const run=await readReplyTestRun(env.DB,actor,target.requestId,target.memberId);if(!run)return {outcome:'not_found'};
  return observe(env.DB,actor,target,run,await native(env,deps),deps.control??replyTestControl(env));
}
