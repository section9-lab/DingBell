import {defineTool} from '@flue/runtime/tool';
import * as v from 'valibot';
import {aiRunSchema,type AiRun,type AiHandoff} from './ai-state.ts';
import {aiAnswerInputSchema,aiAnswerResultSchema,type AiAnswerInput} from '../ai-runs/answer.ts';
import type {ControlScope} from './control-types.ts';
import {createHandoffTool} from './handoff-tool.ts';
type Services={submit:(scope:ControlScope,id:string,input:AiAnswerInput)=>Promise<unknown>;requestHandoff:(scope:ControlScope,id:string,input:AiHandoff)=>Promise<unknown>};
const output=v.strictObject({...aiAnswerResultSchema.entries,handoff:v.picklist(['committed','rejected','unconfirmed']),sent:v.literal(false)});
export function createAnswerTool(value:AiRun,services:Services){
 const run=v.parse(aiRunSchema,structuredClone(value)),submit=services.submit.bind(services),handoff=createHandoffTool(run,services);
 return defineTool({name:'submit_answer',description:'Save one internal draft supported by chunk IDs returned by search_knowledge, then request human review. This is not approval or permission to send. Never claim a customer reply was sent. The application owns all scope and run identifiers.',
  input:aiAnswerInputSchema,output,durable:true,timeoutMs:20000,
  async run(context){
   const {data,step,signal}=context;signal?.throwIfAborted();
   const saved=await step.do('submit-answer',async()=>{
    signal?.throwIfAborted();try{return await submit({...run.scope},run.request.runId,v.parse(aiAnswerInputSchema,structuredClone(data)));}
    catch{return {status:'unconfirmed',canSend:false,reviewRequired:true};}
   });signal?.throwIfAborted();
   const parsed=v.safeParse(aiAnswerResultSchema,saved),status=parsed.success?parsed.output.status:'unconfirmed';
   const input:AiHandoff=status==='submitted'?{reason:'merchant_decision',summary:'A cited AI draft is saved for human review. No customer reply has been sent.',neededInformation:['Review the saved draft and its citations before deciding whether to reply.']}:
    {reason:'tool_failure',summary:'The AI draft could not be confirmed. Human review is required; no customer reply has been sent.',neededInformation:[]};
   const receipt=await handoff.run({...context,data:input});
   return {output:{status,reviewRequired:true,handoff:receipt.output.status,canSend:false,sent:false},terminate:true};
  },
 });
}
