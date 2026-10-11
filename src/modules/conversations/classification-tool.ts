import {defineTool} from '@flue/runtime/tool';
import * as v from 'valibot';
import {aiIntakeRunSchema,aiClassificationSchema,aiIntakeReceiptSchema,type AiIntakeRun,type AiClassification} from './ai-intake.ts';
import type {ControlScope} from './control-types.ts';
interface ClassificationController {recordAiClassification(scope:ControlScope,runId:string,input:AiClassification):Promise<unknown>}
const receiptResult=v.object({outcome:v.literal('accepted'),receipt:aiIntakeReceiptSchema});
const refusal=v.object({outcome:v.picklist(['conflict','unavailable'])});
const output=v.strictObject({status:v.picklist(['committed','rejected','unconfirmed']),canSend:v.literal(false),sent:v.literal(false)});
export function createClassificationTool(value:AiIntakeRun,controller:ClassificationController){
 const run=v.parse(aiIntakeRunSchema,structuredClone(value)),request=controller.recordAiClassification.bind(controller);
 return defineTool({name:'submit_classification',description:'Submit the customer message stage, language and whether a human was requested. Use unknown when unsure. The application selects a policy or hands off. This tool does not grant order access or send a customer message.',
  input:aiClassificationSchema,output,durable:true,timeoutMs:10000,
  async run({data,step,signal}){
   signal?.throwIfAborted();
   const status=await step.do('commit-classification',async()=>{
    signal?.throwIfAborted();
    let result:unknown;try{result=await request(run.scope,run.request.runId,data);}catch{return 'unconfirmed' as const;}
    if(v.is(refusal,result))return 'rejected' as const;
    const parsed=v.safeParse(receiptResult,result);if(!parsed.success)return 'unconfirmed' as const;
    const receipt=parsed.output.receipt;
    return receipt.action==='ai_classification'&&receipt.origin==='agent'&&JSON.stringify(receipt.run)===JSON.stringify(run)&&JSON.stringify(receipt.classification)===JSON.stringify(data)?'committed' as const:'unconfirmed' as const;
   });
   return {output:{status,canSend:false,sent:false},terminate:true};
  },
 });
}
