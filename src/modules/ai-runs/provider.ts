import {nvidiaProvider} from '@earendil-works/pi-ai/providers/nvidia';
import type {Provider} from '@earendil-works/pi-ai';
import {getCloudflareContext,getDurableObjectIdentity} from '@flue/runtime/cloudflare';
import {previewFetch} from '../translations/transport.ts';
import {SupportLedger} from './ledger.ts';
import {aiRunReader,type SupportBindings} from './execution.ts';
import {claimAiGeneration,settleAiGeneration} from './storage.ts';
import {sendSupportRequest} from './provider-fetch.ts';
import {SUPPORT_MODEL,SUPPORT_PROVIDER,validateSupportConfig} from './policy.ts';
const base=nvidiaProvider(),catalogModel=base.getModels().find(m=>m.id===SUPPORT_MODEL);
if(!catalogModel||catalogModel.baseUrl!=='https://integrate.api.nvidia.com/v1')throw new Error('SUPPORT_MODEL_UNAVAILABLE');
export const supportModel={...catalogModel,provider:SUPPORT_PROVIDER};
export const currentSupportLedger=()=>new SupportLedger(getCloudflareContext().storage.sql);
function active(){
 const env=getCloudflareContext().env as SupportBindings,ledger=currentSupportLedger(),state=ledger.inspect();
 if(env.AI_RECEPTION_ENABLED!=='true'||!env.DB||!state||state.closed||state.cancellation||getDurableObjectIdentity().name!==state.run.instanceId||Date.now()>=state.run.payload.run.deadlineAt)throw new Error('SUPPORT_DISABLED');
 if(state.run.config.model.promptVersion==='support-reply-v1'&&(env.AI_OUTBOUND_ENABLED!=='true'||env.OUTBOUND_ENABLED!=='true'))throw new Error('SUPPORT_DISABLED');
 validateSupportConfig(state.run,supportModel.contextWindow);return {env,ledger,run:state.run};
}
export function supportProvider():Provider<'openai-completions'>{
 return {...base,id:SUPPORT_PROVIDER,getModels:()=>[supportModel],auth:{apiKey:{name:'NVIDIA support secret',async resolve({signal}){
  signal.throwIfAborted();const key=active().env.NVAPI_KEY;if(typeof key!=='string'||!key.trim())throw new Error('SUPPORT_SECRET_UNAVAILABLE');return {auth:{apiKey:key},source:'Cloudflare support secret'};
 }}},stream(){throw new Error('SUPPORT_STREAM_UNSUPPORTED');},streamSimple(model,context,options){
  const {env,ledger,run}=active();if(model.id!==SUPPORT_MODEL||model.provider!==SUPPORT_PROVIDER||model.baseUrl!==supportModel.baseUrl)throw new Error('SUPPORT_MODEL_UNAVAILABLE');
  const sequence=ledger.begin(),scope=run.payload.run.scope,allowedTools=run.payload.run.schemaVersion===2?['submit_classification']:run.config.model.promptVersion==='support-reply-v1'?['request_handoff','search_knowledge','prepare_reply']:run.config.model.promptVersion==='support-answer-v1'?['request_handoff','search_knowledge','submit_answer']:run.config.model.promptVersion==='support-knowledge-v1'?['request_handoff','search_knowledge']:['request_handoff'],timeout=Math.min(45000,run.payload.run.deadlineAt-Date.now());if(timeout<=0)throw new Error('SUPPORT_EXPIRED');
  const transport=previewFetch({spend:()=>ledger.spend(sequence),async claim(){
   const receipt=ledger.inspect()?.receipt??await(await import('./runtime.ts')).dispatchSupport(env,run,true);
   ledger.bindReceipt(receipt);
   const granted=await claimAiGeneration(env.DB!,aiRunReader(env),scope,run.id,sequence),current=ledger.inspect()!;return granted&&!current.closed&&!current.cancellation;
  },async record(evidence){
   ledger.record(sequence,evidence);const receipt=ledger.inspect()?.receipt;
   if(receipt&&evidence.complete&&evidence.usageReported&&evidence.usage)await settleAiGeneration(env.DB!,scope,run.id,sequence,receipt,evidence.usage);
  }},sendSupportRequest,{allowedTools});
  return base.streamSimple(model,context,{...options,maxTokens:run.config.model.maxOutputTokens,maxRetries:0,timeoutMs:timeout,fetch:async(input,init)=>{const result=await transport(input,init);ledger.deliver(sequence);return result;},temperature:1,
   signal:options?.signal?AbortSignal.any([options.signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout),
   onPayload(payload){
    const p=payload as Record<string,any>;
    if(p.model!==SUPPORT_MODEL||p.stream!==true||(p.max_tokens??p.max_completion_tokens)!==run.config.model.maxOutputTokens
     ||!Array.isArray(p.tools)||p.tools.some((t:any)=>![...allowedTools,'task'].includes(t?.function?.name)))throw new Error('SUPPORT_PAYLOAD_REJECTED');
    const tools=p.tools.filter((t:any)=>allowedTools.includes(t.function.name));if(tools.length!==allowedTools.length||new Set(tools.map((t:any)=>t.function.name)).size!==allowedTools.length)throw new Error('SUPPORT_PAYLOAD_REJECTED');
    return {...p,tools,tool_choice:'auto',parallel_tool_calls:false};
   },
  });
 }};
}
