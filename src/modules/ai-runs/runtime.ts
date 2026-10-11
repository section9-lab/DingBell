import {AgentRunError,getAgentInstance,init} from '@flue/runtime';
import {getAgentByName} from 'agents';
import {Support} from '../../agents/support.ts';
import type {ControlScope} from '../conversations/control-types.ts';
import type {TranslationReceipt} from '../translations/types.ts';
import {bindAiExecutionReceipt,type AiExecution} from './storage.ts';
import {matchingSupport,type SupportBindings,type SupportRuntime} from './execution.ts';
import type {SupportInspection} from './ledger.ts';
interface Stub {prepareSupport(scope:ControlScope,id:string):Promise<void>;inspectSupport():Promise<SupportInspection|null>;cancelSupport(scope:ControlScope,id:string):Promise<void>;bindSupportReceipt(id:string,receipt:TranslationReceipt):Promise<void>;closeSupport(scope:ControlScope,id:string,outcome:'completed'|'failed'|'aborted'|null):Promise<void>}
async function stub(env:SupportBindings,run:AiExecution){if(!env.FLUE_SUPPORT_AGENT)throw new Error('SUPPORT_RUNTIME_UNAVAILABLE');return await getAgentByName(env.FLUE_SUPPORT_AGENT,run.instanceId) as unknown as Stub;}
/** Recover the original admission, including when execution outruns the caller saving its receipt. */
export async function dispatchSupport(env:SupportBindings,run:AiExecution,existingOnly=false):Promise<TranslationReceipt>{
 if(!env.DB)throw new Error('SUPPORT_UNAVAILABLE');
 const state=await(await stub(env,run)).inspectSupport();
 if(!state||!matchingSupport(state,run)||state.closed||(!existingOnly&&state.cancellation))throw new Error('SUPPORT_DISPATCH_UNAVAILABLE');
 if(existingOnly&&!(await getAgentInstance(Support,run.instanceId))?.uid)throw new Error('SUPPORT_AUTHORITY_MISSING');
 const value=await init(Support,{id:run.instanceId,uid:null}).dispatch({message:JSON.stringify(run.modelInput),initialData:{runId:run.id},idempotencyKey:run.dispatchKey});
 const receipt={submissionId:value.submissionId,uid:value.uid,acceptedAt:value.acceptedAt};
 if((await getAgentInstance(Support,run.instanceId))?.uid!==receipt.uid)throw new Error('SUPPORT_AUTHORITY_MISSING');
 await(await stub(env,run)).bindSupportReceipt(run.id,receipt);await bindAiExecutionReceipt(env.DB,run.payload.run.scope,run.id,receipt);return receipt;
}
export function createSupportRuntime(env:SupportBindings):SupportRuntime{
 const runtime:SupportRuntime={
  lookup:run=>getAgentInstance(Support,run.instanceId),inspect:async run=>(await stub(env,run)).inspectSupport(),prepare:async run=>(await stub(env,run)).prepareSupport(run.payload.run.scope,run.id),dispatch:run=>dispatchSupport(env,run),
  recover:run=>dispatchSupport(env,run,true),cancel:async run=>(await stub(env,run)).cancelSupport(run.payload.run.scope,run.id),
  async abort(run){
   const state=await runtime.inspect(run);
   if(!run.receipt||!state||!matchingSupport(state,run)||!state.cancellation||JSON.stringify(state.receipt)!==JSON.stringify(run.receipt)||(await runtime.lookup(run))?.uid!==run.receipt.uid)throw new Error('SUPPORT_ABORT_UNCONFIRMED');
   // Flue abort is instance-wide, not UID-conditional. Each business run owns a never-reused target.
   await init(Support,{id:run.instanceId}).abort();
  },
  async read(run){
   if(!run.receipt)throw new Error('SUPPORT_RECEIPT_MISSING');
   try{const result=await init(Support,{id:run.instanceId}).read(run.receipt,{signal:AbortSignal.timeout(500)});
    if(result.uid!==run.receipt.uid||result.submissionId!==run.receipt.submissionId)throw new Error('SUPPORT_RESULT_MISMATCH');return 'completed';
   }catch(error){
    if(error instanceof DOMException&&['AbortError','TimeoutError'].includes(error.name))return 'pending';
    if(error instanceof AgentRunError&&error.submissionId===run.receipt.submissionId)return error.outcome;throw error;
   }
  },
  async close(run){
   const instance=await runtime.lookup(run);
   if(!run.receipt){if(instance||run.generations.length)throw new Error('SUPPORT_CLOSURE_UNCONFIRMED');await(await stub(env,run)).closeSupport(run.payload.run.scope,run.id,null);return;}
   if(instance?.uid!==run.receipt.uid)throw new Error('SUPPORT_AUTHORITY_MISSING');
   const result=await runtime.read(run);if(result==='pending'||(await runtime.lookup(run))?.uid!==run.receipt.uid)throw new Error('SUPPORT_CLOSURE_UNCONFIRMED');
   await(await stub(env,run)).closeSupport(run.payload.run.scope,run.id,result);
  },
 };return runtime;
}
