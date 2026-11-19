import {defineTool} from '../../platform/core/tool.ts';
import {logEvent,logFailure} from '../../platform/log.ts';
import * as v from 'valibot';
import {aiIntakeRunSchema,aiClassificationSchema,aiIntakeReceiptSchema,type AiIntakeRun,type AiClassification} from './ai-intake.ts';
import type {ControlScope} from './control-types.ts';
interface ClassificationController {recordAiClassification(scope:ControlScope,runId:string,input:AiClassification):Promise<unknown>}
const receiptResult=v.object({outcome:v.literal('accepted'),receipt:aiIntakeReceiptSchema});
const refusal=v.object({outcome:v.picklist(['conflict','unavailable'])});
const output=v.strictObject({status:v.picklist(['committed','rejected','unconfirmed']),canSend:v.literal(false),sent:v.literal(false)});
/** Models routinely omit the boolean and the language; fill them instead of failing the call. */
const toolInput=v.strictObject({stage:v.picklist(['presale','order','aftersale','unknown']),
 language:v.optional(v.picklist(['ru','zh-CN','en','unknown']),'unknown'),
 customerRequestedHuman:v.optional(v.boolean(),false)});
export function createClassificationTool(value:AiIntakeRun,controller:ClassificationController){
 const run=v.parse(aiIntakeRunSchema,structuredClone(value));
 // A Workers RPC stub resolves every property access as a method name, so `.bind` itself becomes
 // an RPC call to "bind" and the receiver rejects it. Wrap the call explicitly instead.
 const request=(scope:ControlScope,runId:string,input:AiClassification)=>controller.recordAiClassification(scope,runId,input);
 return defineTool({name:'submit_classification',description:'Submit the customer message stage, language and whether a human was requested. Use unknown when unsure. The application selects a policy or hands off. This tool does not grant order access or send a customer message.',
  input:toolInput,output,durable:true,timeoutMs:10000,
  async run({data,step,signal}){
   signal?.throwIfAborted();
   const classification=v.parse(aiClassificationSchema,{stage:data.stage,language:data.language??'unknown',customerRequestedHuman:data.customerRequestedHuman??false});
   const status=await step.do('commit-classification',async()=>{
    signal?.throwIfAborted();
    let result:unknown;
    // A concurrent history ingest can briefly hide the canonical input; retry that transient case.
    for(let attempt=0;attempt<3;attempt++){
     try{result=await request(run.scope,run.request.runId,classification);}catch(error){logFailure('ai.classification.failed',error,{runId:run.request.runId});return 'unconfirmed' as const;}
     if(!v.is(refusal,result)||result.outcome!=='unavailable'||attempt===2)break;
     await new Promise(resolve=>setTimeout(resolve,300));
    }
    if(v.is(refusal,result))return 'rejected' as const;
    const parsed=v.safeParse(receiptResult,result);if(!parsed.success)return 'unconfirmed' as const;
    const receipt=parsed.output.receipt;
    return receipt.action==='ai_classification'&&receipt.origin==='agent'&&JSON.stringify(receipt.run)===JSON.stringify(run)&&JSON.stringify(receipt.classification)===JSON.stringify(classification)?'committed' as const:'unconfirmed' as const;
   });
   logEvent('ai.classification.submitted',{runId:run.request.runId,status,stage:classification.stage,language:classification.language});
   return {output:{status,canSend:false as const,sent:false as const},terminate:true};
  },
 });
}
