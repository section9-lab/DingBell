import {defineTool} from '@flue/runtime/tool';
import * as v from 'valibot';
import {aiRunSchema,aiHandoffSchema,aiReceiptSchema,type AiRun,type AiHandoff} from './ai-state.ts';
import type {ControlScope} from './control-types.ts';
interface HandoffController {requestHandoff(scope:ControlScope,runId:string,input:AiHandoff):Promise<unknown>}
const receiptResult=v.object({outcome:v.literal('accepted'),receipt:aiReceiptSchema});
const refusal=v.object({outcome:v.picklist(['conflict','unavailable'])});
const output=v.strictObject({status:v.picklist(['committed','rejected','unconfirmed']),canSend:v.literal(false),sent:v.literal(false)});
/** The caller supplies the persisted admitted run, never model-selected authority. */
export function createHandoffTool(value:AiRun,controller:HandoffController){
 const run=v.parse(aiRunSchema,structuredClone(value)),request=controller.requestHandoff.bind(controller);
 return defineTool({name:'request_handoff',description:'Request human support when the customer asks for a person, evidence is missing, or a merchant decision is required. Reports whether this run committed a handoff. Does not send a customer message or promise a business outcome.',
  input:aiHandoffSchema,output,durable:true,timeoutMs:10000,
  async run({data,step,signal}){
   signal?.throwIfAborted();
   const status=await step.do('commit-handoff',async()=>{
    signal?.throwIfAborted();
    let result:unknown;try{result=await request(run.scope,run.request.runId,data);}catch{return 'unconfirmed' as const;}
    if(v.is(refusal,result))return 'rejected' as const;
    const parsed=v.safeParse(receiptResult,result);if(!parsed.success)return 'unconfirmed' as const;
    const receipt=parsed.output.receipt;
    return receipt.action==='request_handoff'&&receipt.origin==='agent'&&JSON.stringify(receipt.run)===JSON.stringify(run)&&JSON.stringify(receipt.input)===JSON.stringify(data)?'committed' as const:'unconfirmed' as const;
   });
   return {output:{status,canSend:false,sent:false},terminate:true};
  },
 });
}
