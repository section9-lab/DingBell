'use agent';
import {setProvider,useModel,useInitialData,useDelivery,useTool,useResponseFinish} from '@flue/runtime';
import {getCloudflareContext} from '@flue/runtime/cloudflare';
import * as v from 'valibot';
import {supportExtension} from '../modules/ai-runs/extension.ts';
import {currentSupportLedger,supportProvider} from '../modules/ai-runs/provider.ts';
import {SUPPORT_MODEL,SUPPORT_PROVIDER,supportInstructions,intakeInstructions} from '../modules/ai-runs/policy.ts';
import {getConversationController,type ControlBindings} from '../modules/conversations/control-bindings.ts';
import {createHandoffTool} from '../modules/conversations/handoff-tool.ts';
import {createClassificationTool} from '../modules/conversations/classification-tool.ts';
import {createKnowledgeTool} from '../modules/conversations/knowledge-tool.ts';
import {searchAiKnowledge,reviewAiKnowledgeEvidence} from '../modules/ai-runs/knowledge.ts';
import {createAnswerTool} from '../modules/conversations/answer-tool.ts';
import {submitAiAnswer} from '../modules/ai-runs/answer.ts';
import {createReplyTool} from '../modules/conversations/reply-tool.ts';
import {prepareAiReply} from '../modules/ai-runs/reply-intent.ts';
export const cloudflare=supportExtension;
setProvider(supportProvider());
export function Support(){
 const initial=useInitialData<{runId:string}>(),delivery=useDelivery(),state=currentSupportLedger().inspect();
 if(!state||state.closed||initial.runId!==state.run.id||delivery.kind!=='user'||delivery.body!==JSON.stringify(state.run.modelInput)||delivery.attachments?.length)throw new Error('SUPPORT_INPUT_MISMATCH');
 useModel(`${SUPPORT_PROVIDER}/${SUPPORT_MODEL}`,{thinkingLevel:'off',compaction:false});
 const env=getCloudflareContext().env as ControlBindings,controller=getConversationController(env,state.run.payload.run.scope.controllerId);
 const work=state.run.payload.run;
 if(work.schemaVersion===2)useTool(createClassificationTool(work,{recordAiClassification:(scope,id,input)=>controller.recordAiClassification(scope,id,input)}));
 else {
  useTool(createHandoffTool(work,{requestHandoff:(scope,id,input)=>controller.requestHandoff(scope,id,input)}));
  if(['support-knowledge-v1','support-answer-v1','support-reply-v1'].includes(state.run.config.model.promptVersion)){
   const read=(scope:typeof work.scope,id:string)=>controller.readAiRun(scope,id);
   useTool(createKnowledgeTool(work,{search:(scope,id)=>searchAiKnowledge(env,read,scope,id),review:(scope,id,evidence)=>reviewAiKnowledgeEvidence(env,read,scope,id,evidence)}));
   if(state.run.config.model.promptVersion==='support-answer-v1')useTool(createAnswerTool(work,{submit:(scope,id,input)=>submitAiAnswer(env,read,scope,id,input),requestHandoff:(scope,id,input)=>controller.requestHandoff(scope,id,input)}));
   if(state.run.config.model.promptVersion==='support-reply-v1')useTool(createReplyTool(work,{prepare:(scope,id,input)=>prepareAiReply(env,read,scope,id,input),wakeAiReply:(scope,id)=>controller.wakeAiReply(scope,id),requestHandoff:(scope,id,input)=>controller.requestHandoff(scope,id,input)}));
  }
 }
 useResponseFinish(()=>({support:{canSend:false,sent:false}}));return (work.schemaVersion===2?intakeInstructions:supportInstructions)(state.run.config.model.promptVersion);
}
Support.agentName='Support';Support.durability={maxAttempts:1,timeoutMs:60000};Support.initialData=v.strictObject({runId:v.pipe(v.string(),v.uuid())});
