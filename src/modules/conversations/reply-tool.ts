import {defineTool} from '@flue/runtime/tool';
import * as v from 'valibot';
import {aiRunSchema,type AiRun,type AiHandoff} from './ai-state.ts';
import {aiAnswerInputSchema,type AiAnswerInput} from '../ai-runs/answer.ts';
import type {ControlScope} from './control-types.ts';
import {createHandoffTool} from './handoff-tool.ts';
type Services={prepare:(scope:ControlScope,id:string,input:AiAnswerInput)=>Promise<unknown>;wakeAiReply:(scope:ControlScope,id:string)=>Promise<void>;requestHandoff:(scope:ControlScope,id:string,input:AiHandoff)=>Promise<unknown>};
const status=v.picklist(['prepared','conflict','unavailable','unconfirmed']);
const outcome=v.strictObject({status,intentId:v.nullable(v.pipe(v.string(),v.maxLength(256))),canSend:v.literal(false),sent:v.literal(false)});
const output=v.strictObject({status,observation:v.picklist(['scheduled','unconfirmed','not_requested']),handoff:v.picklist(['none','committed','rejected','unconfirmed']),canSend:v.literal(false),sent:v.literal(false)});
export function createReplyTool(value:AiRun,services:Services){
 const run=v.parse(aiRunSchema,structuredClone(value)),prepare=services.prepare.bind(services),wake=services.wakeAiReply.bind(services),handoff=createHandoffTool(run,services);
 return defineTool({name:'prepare_reply',description:'Prepare one immutable customer reply using the supporting chunk IDs returned by search_knowledge. The application owns all scope, run and delivery authority. Successful preparation ends generation; the application separately verifies runtime completion and dispatch eligibility. This tool never sends a customer message or confirms delivery.',
  input:aiAnswerInputSchema,output,durable:true,timeoutMs:20000,
  async run(context){
   const {data,step,signal}=context;signal?.throwIfAborted();
   const saved=await step.do('prepare-reply',async()=>{
    signal?.throwIfAborted();try{return await prepare({...run.scope},run.request.runId,v.parse(aiAnswerInputSchema,structuredClone(data)));}
    catch{return {status:'unconfirmed',intentId:null,canSend:false,sent:false};}
   });signal?.throwIfAborted();
   const parsed=v.safeParse(outcome,saved),status=parsed.success&&(parsed.output.status!=='prepared'||parsed.output.intentId==='ai-reply:'+run.request.runId)?parsed.output.status:'unconfirmed';
   if(status==='prepared'){
    // Waking a bounded observer is idempotent and grants no send authority; replay may retry a lost wake.
    let observation:'scheduled'|'unconfirmed'='unconfirmed';try{await wake({...run.scope},run.request.runId);observation='scheduled';}catch{}
    signal?.throwIfAborted();return {output:{status,observation,handoff:'none' as const,canSend:false as const,sent:false as const},terminate:true};
   }
   const input:AiHandoff={schemaVersion:2,reason:'tool_failure',neededInformation:[]};
   const receipt=await handoff.run({...context,data:input});
   return {output:{status,observation:'not_requested' as const,handoff:receipt.output.status,canSend:false as const,sent:false as const},terminate:true};
  },
 });
}
