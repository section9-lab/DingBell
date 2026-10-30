import {defineTool} from '../../platform/core/tool.ts';
import * as v from 'valibot';
import {aiRunSchema,aiHandoffToolInputSchema,controlledAiHandoffSchema,aiReceiptSchema,type AiRun,type ControlledAiHandoff} from './ai-state.ts';
import type {ControlScope} from './control-types.ts';
interface HandoffController {requestHandoff(scope:ControlScope,runId:string,input:ControlledAiHandoff):Promise<unknown>}
const receiptResult=v.object({outcome:v.literal('accepted'),receipt:aiReceiptSchema});
const refusal=v.object({outcome:v.picklist(['conflict','unavailable'])});
const output=v.strictObject({status:v.picklist(['committed','rejected','unconfirmed']),canSend:v.literal(false),sent:v.literal(false)});
/** The caller supplies the persisted admitted run, never model-selected authority. */
export function createHandoffTool(value:AiRun,controller:HandoffController){
 const run=v.parse(aiRunSchema,structuredClone(value)),request=controller.requestHandoff.bind(controller);
 return defineTool({name:'request_handoff',description:'Request human support. neededInformation may contain only product_model, issue_description, desired_resolution, usage_context, or photo_or_video. Never request an order identifier, address, phone, email, identity document, credential, payment information, or arbitrary free-text field. This does not send a message or promise a business outcome.',
  input:aiHandoffToolInputSchema,output,durable:true,timeoutMs:10000,
  async run({data,step,signal}){
   signal?.throwIfAborted();const stored:ControlledAiHandoff=v.parse(controlledAiHandoffSchema,{...data,schemaVersion:2});
   const status=await step.do('commit-handoff',async()=>{
    signal?.throwIfAborted();
    let result:unknown;try{result=await request(run.scope,run.request.runId,stored);}catch{return 'unconfirmed' as const;}
    if(v.is(refusal,result))return 'rejected' as const;
    const parsed=v.safeParse(receiptResult,result);if(!parsed.success)return 'unconfirmed' as const;
    const receipt=parsed.output.receipt;
    return receipt.action==='request_handoff'&&receipt.origin==='agent'&&JSON.stringify(receipt.run)===JSON.stringify(run)&&JSON.stringify(receipt.input)===JSON.stringify(stored)?'committed' as const:'unconfirmed' as const;
   });
   return {output:{status,canSend:false as const,sent:false as const},terminate:true};
  },
 });
}
