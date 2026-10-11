import { nvidiaProvider } from '@earendil-works/pi-ai/providers/nvidia';
import type { Provider } from '@earendil-works/pi-ai';
import { getCloudflareContext,getDurableObjectIdentity } from '@flue/runtime/cloudflare';
import { previewFetch } from '../translations/transport.ts';
import { ReplyTestLedger } from './ledger.ts';
import { replyTestControl,type ReplyTestBindings } from './execution.ts';
import { claimReplyTestProviderRequest } from './storage.ts';
import { sendReplyTestRequest } from './provider-fetch.ts';
import { REPLY_TEST_MODEL,REPLY_TEST_PROVIDER,replyTestInstance,validateReplyTestConfig } from './policy.ts';
import { replyTestSampling } from './output.ts';
const base=nvidiaProvider(),catalogModel=base.getModels().find(model=>model.id===REPLY_TEST_MODEL);
if(!catalogModel||catalogModel.baseUrl!=='https://integrate.api.nvidia.com/v1')throw new Error('REPLY_TEST_MODEL_UNAVAILABLE');
export const replyTestModel={...catalogModel,provider:REPLY_TEST_PROVIDER};
export const currentReplyTestLedger=()=>new ReplyTestLedger(getCloudflareContext().storage.sql);
function active(){
  const context=getCloudflareContext(),ledger=currentReplyTestLedger(),state=ledger.inspect();
  if(context.env.REPLY_TEST_ENABLED!=='true'||!state||state.closed||getDurableObjectIdentity().name!==replyTestInstance(state.run.id))throw new Error('REPLY_TEST_DISABLED');
  validateReplyTestConfig(state.run.config,replyTestModel.contextWindow);return {context,ledger,run:state.run};
}
export function replyTestProvider():Provider<'openai-completions'>{
  return {...base,id:REPLY_TEST_PROVIDER,getModels:()=>[replyTestModel],auth:{apiKey:{name:'NVIDIA reply test secret',async resolve({signal}){
    signal.throwIfAborted();const key=active().context.env.NVAPI_KEY;
    if(typeof key!=='string'||!key.trim())throw new Error('REPLY_TEST_SECRET_UNAVAILABLE');return {auth:{apiKey:key},source:'Cloudflare reply test secret'};
  }}},stream(){throw new Error('REPLY_TEST_STREAM_UNSUPPORTED');},streamSimple(model,context,options){
    const current=active();if(model.id!==REPLY_TEST_MODEL||model.provider!==REPLY_TEST_PROVIDER||model.baseUrl!==replyTestModel.baseUrl)throw new Error('REPLY_TEST_MODEL_UNAVAILABLE');
    current.ledger.spend('generation');
    const transport=previewFetch({spend:()=>current.ledger.spend('http'),record:evidence=>current.ledger.record(evidence),claim:async()=>{
      const env=current.context.env as ReplyTestBindings;
      return env.REPLY_TEST_ENABLED==='true'&&!!env.DB&&await claimReplyTestProviderRequest(env.DB,replyTestControl(env),current.run.payload.context.scope,current.run.id);
    }},sendReplyTestRequest);
    return base.streamSimple(model,context,{...options,maxTokens:current.run.config.maxOutputTokens,maxRetries:0,timeoutMs:45_000,fetch:transport,temperature:1,
      samplingParams:replyTestSampling(current.run.config.modelConfigVersion),
      signal:options?.signal?AbortSignal.any([options.signal,AbortSignal.timeout(45_000)]):AbortSignal.timeout(45_000),
      onPayload(payload){
        const p=payload as Record<string,unknown>;
        // The native task declaration is present even without useTool. This simulation exposes no tools.
        if(p.model!==REPLY_TEST_MODEL||p.stream!==true||p.tool_choice!=='none'
          ||(p.tools!==undefined&&(!Array.isArray(p.tools)||p.tools.some(tool=>tool?.function?.name!=='task')))
          ||(p.max_tokens??p.max_completion_tokens)!==current.run.config.maxOutputTokens)throw new Error('REPLY_TEST_PAYLOAD_REJECTED');
        return {...p,tools:undefined};
      },
    });
  }};
}
