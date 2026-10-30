import { AgentRunError,getAgentInstance,init } from '@flue/runtime';
import { getAgentByName } from 'agents';
import { ReplyPreview } from '../../agents/reply-preview.ts';
import { previewInstance } from './policy.ts';
import type { TranslationBindings } from './bindings.ts';
import type { PreviewInspection,TranslationRuntime } from './api-types.ts';
import type { TranslationScope } from './types.ts';
interface PreviewStub {
  preparePreview(scope:TranslationScope,runId:string):Promise<void>;
  inspectPreview():Promise<PreviewInspection|null>;
  closeUnstartedPreview(scope:TranslationScope,runId:string):Promise<void>;
}
export function createTranslationRuntime(env:TranslationBindings):TranslationRuntime {
  if(!env.FLUE_REPLY_PREVIEW_AGENT)throw new Error('TRANSLATION_RUNTIME_UNAVAILABLE');
  const stub=async(id:string)=>await getAgentByName(env.FLUE_REPLY_PREVIEW_AGENT!,previewInstance(id)) as unknown as PreviewStub;
  return {
    lookup:id=>getAgentInstance(ReplyPreview,previewInstance(id)),
    inspect:async id=>(await stub(id)).inspectPreview(),
    prepare:async(scope,id)=>(await stub(id)).preparePreview(scope,id),
    close:async(scope,id)=>(await stub(id)).closeUnstartedPreview(scope,id),
    async dispatch(run){
      // Keep the entire original creating payload on every explicit retry. Flue
      // adopts its keyed receipt before enforcing the uid:null creation condition.
      const receipt=await init(ReplyPreview,{id:previewInstance(run.id),uid:null}).dispatch({message:run.source,initialData:{runId:run.id},idempotencyKey:run.id});
      return {submissionId:receipt.submissionId,uid:receipt.uid,acceptedAt:receipt.acceptedAt};
    },
    async read(id,receipt){
      try{
        const result=await init(ReplyPreview,{id:previewInstance(id)}).read(receipt,{signal:AbortSignal.timeout(500)});
        if(result.uid!==receipt.uid||result.submissionId!==receipt.submissionId)throw new Error('TRANSLATION_RESULT_MISMATCH');
        return {outcome:'completed',text:result.text,metadata:result.metadata};
      }catch(error){
        if(error instanceof DOMException&&['TimeoutError','AbortError'].includes(error.name))return {outcome:'pending'};
        if(error instanceof AgentRunError)return {outcome:'failed'};
        throw error;
      }
    },
  };
}
