import { nvidiaProvider } from '@earendil-works/pi-ai/providers/nvidia';
import type { Provider } from '@earendil-works/pi-ai';
import { getCloudflareContext,getDurableObjectIdentity } from '@flue/runtime/cloudflare';
import { PreviewLedger } from './ledger.ts';
import { previewFetch } from './transport.ts';
import { sendPreviewRequest } from './provider-fetch.ts';
import { claimTranslationProviderRequest } from './storage.ts';
import { PREVIEW_MODEL,previewInstance,validatePreviewRun } from './policy.ts';

export function currentPreviewLedger(){return new PreviewLedger(getCloudflareContext().storage.sql);}
const base=nvidiaProvider();
export const previewModel=base.getModels().find(model=>model.id===PREVIEW_MODEL);
if(!previewModel||previewModel.baseUrl!=='https://integrate.api.nvidia.com/v1')throw new Error('PREVIEW_MODEL_UNAVAILABLE');
function active(){
  const context=getCloudflareContext(),ledger=currentPreviewLedger(),state=ledger.inspect();
  if(context.env.TRANSLATION_ENABLED!=='true'||!state||state.closed||getDurableObjectIdentity().name!==previewInstance(state.run.id))throw new Error('PREVIEW_DISABLED');
  validatePreviewRun(state.run,previewModel!.contextWindow);return {context,ledger,run:state.run};
}
export function previewProvider():Provider<'openai-completions'>{
  return {...base,getModels:()=>[previewModel!],auth:{apiKey:{name:'NVIDIA translation secret',async resolve({signal}){
    signal.throwIfAborted();const {context}=active();const key=context.env.NVAPI_KEY;
    if(typeof key!=='string'||!key)throw new Error('PREVIEW_SECRET_UNAVAILABLE');return {auth:{apiKey:key},source:'Cloudflare translation secret'};
  }}},
  stream(){throw new Error('PREVIEW_STREAM_UNSUPPORTED');},
  streamSimple(model,context,options){
    const current=active();if(model.id!==PREVIEW_MODEL||model.baseUrl!==previewModel!.baseUrl)throw new Error('PREVIEW_MODEL_UNAVAILABLE');
    current.ledger.spend('generation');
    const transport=previewFetch({spend:()=>current.ledger.spend('http'),record:evidence=>current.ledger.record(evidence),claim:async()=>{
      if(current.context.env.TRANSLATION_ENABLED!=='true'||!current.context.env.DB)return false;
      return claimTranslationProviderRequest(current.context.env.DB as D1Database,{organizationId:current.run.organizationId,storeId:current.run.storeId,conversationId:current.run.conversationId},current.run.id);
    }},sendPreviewRequest);
    return base.streamSimple(model,context,{...options,maxTokens:current.run.config.maxOutputTokens,maxRetries:0,timeoutMs:45_000,fetch:transport,
      temperature:1,samplingParams:{tool_choice:'none',chat_template_kwargs:{enable_thinking:false}},
      signal:options?.signal?AbortSignal.any([options.signal,AbortSignal.timeout(45_000)]):AbortSignal.timeout(45_000),
      onPayload(payload){
        const p=payload as Record<string,unknown>;
        if(p.model!==PREVIEW_MODEL)throw new Error('PREVIEW_PAYLOAD_MODEL_REJECTED');
        if(p.stream!==true)throw new Error('PREVIEW_PAYLOAD_STREAM_REJECTED');
        // Flue 2.2.2 always declares its framework task tool, even without a
        // sandbox or useTool. This translator explicitly removes that one
        // declaration through the SDK's public payload hook; new tools fail closed.
        if(p.tool_choice!=='none'||(p.tools!==undefined&&(!Array.isArray(p.tools)||p.tools.some(tool=>tool?.function?.name!=='task'))))throw new Error('PREVIEW_PAYLOAD_TOOLS_REJECTED');
        if((p.max_tokens??p.max_completion_tokens)!==current.run.config.maxOutputTokens)throw new Error('PREVIEW_PAYLOAD_LIMIT_REJECTED');
        return {...p,tools:undefined};
      },
    });
  }};
}
