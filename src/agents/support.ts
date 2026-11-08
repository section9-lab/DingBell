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
import {createBashTool,createReadTool} from '../modules/conversations/knowledge-agent-tool.ts';
import {createProductInfoTool,createOrderInfoTool} from '../modules/conversations/fact-tool.ts';
import {createSendMessageTool} from '../modules/conversations/send-message-tool.ts';
import type {AiKnowledgeBindings} from '../modules/ai-runs/knowledge.ts';
import {discoverAiKnowledge,readAiKnowledgeFile} from '../modules/ai-runs/text-knowledge.ts';
import {prepareAiMessage} from '../modules/ai-runs/message-intent.ts';
import {recordAiProductFact,recordAiOrderFact} from '../modules/ai-runs/fact-evidence.ts';
import {SUPPORT_REPLY_V2} from '../shared/ai-versions.ts';
export const cloudflare=supportExtension;
setProvider(supportProvider());
export function Support(){
 const initial=useInitialData<{runId:string}>(),delivery=useDelivery(),state=currentSupportLedger().inspect();
 if(!state||state.closed||initial.runId!==state.run.id||delivery.kind!=='user'||delivery.body!==JSON.stringify(state.run.modelInput)||delivery.attachments?.length)throw new Error('SUPPORT_INPUT_MISMATCH');
 useModel(`${SUPPORT_PROVIDER}/${SUPPORT_MODEL}`,{thinkingLevel:'off',compaction:false});
 const env=getCloudflareContext().env as ControlBindings&AiKnowledgeBindings,controller=getConversationController(env,state.run.payload.run.scope.controllerId);
 const work=state.run.payload.run;
 if(work.schemaVersion===2)useTool(createClassificationTool(work,{recordAiClassification:(scope,id,input)=>controller.recordAiClassification(scope,id,input)}));
 else {
  useTool(createHandoffTool(work,{requestHandoff:(scope,id,input)=>controller.requestHandoff(scope,id,input)}));
  if(state.run.config.model.promptVersion===SUPPORT_REPLY_V2){
   const read=(scope:typeof work.scope,id:string)=>controller.readAiRun(scope,id);
   useTool(createBashTool(work,{run:(scope,id,command,signal)=>discoverAiKnowledge(env,read,scope,id,{command},signal)}));
   useTool(createReadTool(work,{read:(scope,id,input,signal)=>readAiKnowledgeFile(env,read,scope,id,input,signal)}));
   useTool(createProductInfoTool(work,{read:(scope,id)=>recordAiProductFact(env,scope,id)}));
   useTool(createOrderInfoTool(work,{read:(scope,id)=>recordAiOrderFact(env,scope,id)}));
   useTool(createSendMessageTool(work,{prepare:(scope,id,input)=>prepareAiMessage(env,read,scope,id,input),wakeAiReply:(scope,id)=>controller.wakeAiReply(scope,id),requestHandoff:(scope,id,input)=>controller.requestHandoff(scope,id,input)}));
  }
 }
 useResponseFinish(()=>({support:{canSend:false,sent:false}}));return (work.schemaVersion===2?intakeInstructions:supportInstructions)(state.run.config.model.promptVersion);
}
Support.agentName='Support';Support.durability={maxAttempts:1,timeoutMs:60000};Support.initialData=v.strictObject({runId:v.pipe(v.string(),v.uuid())});
