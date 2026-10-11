import { randomUUID } from 'node:crypto';
import { init,useModel } from '@flue/runtime';
import { sqlite,start } from '@flue/runtime/node';
import { previewFetch,type PreviewEvidence } from '../../src/modules/translations/transport.ts';
import { createNvidiaProvider } from '../nvidia/probe.ts';
import { replyTestSampling } from '../../src/modules/reply-tests/output.ts';
import { selectReplyQuality,type QualityCase,type QualityPlan,type QualityResult } from './evaluate.ts';
export type CaptureEvent={phase:'started'|'attempt';caseId:string;repeat:number;at:string;instanceId:string;datasetHash:string}|{phase:'result';result:QualityResult};
export async function runReplyQualityCase(options:{plan:QualityPlan;item:QualityCase;repeat:number;database:string;apiKey:string;origin:'synthetic'|'nvidia-api';capture:(event:CaptureEvent)=>Promise<void>;send?:typeof fetch}):Promise<QualityResult>{
  const {plan,item,repeat,capture}=options;selectReplyQuality(plan,[item.id],repeat);
  const samplingParams=replyTestSampling(plan.modelConfigVersion??'nvidia-reply-test-v1');
  if(plan.modelConfigVersion&&JSON.stringify(plan.samplingParams)!==JSON.stringify(samplingParams))throw new Error('REPLY_QUALITY_OUTPUT_CONSTRAINT_CHANGED');
  const instanceId=`quality-${item.id}-${repeat}-${randomUUID()}`,startedAt=new Date().toISOString(),began=Date.now();
  const event=(phase:'started'|'attempt')=>({phase,caseId:item.id,repeat,at:new Date().toISOString(),instanceId,datasetHash:plan.datasetHash});
  await capture(event('started'));
  let modelCalls=0,httpRequests=0,permits=0,evidence:PreviewEvidence|null=null,status:QualityResult['status']='unknown',output='',receipt:unknown=null;
  const httpStatuses:number[]=[],base=createNvidiaProvider(plan.model),providerId='dingbell-reply-quality';
  const transport=previewFetch({spend(){if(permits++!==0)throw new Error('REPLY_QUALITY_HTTP_LIMIT');},async claim(){await capture(event('attempt'));return true;},record(value){evidence=value;}},async(input,init)=>{
    httpRequests++;let response:Response;try{response=await (options.send??fetch)(input,init);}catch{throw new Error('REPLY_QUALITY_TRANSPORT_UNCONFIRMED');}httpStatuses.push(response.status);return response;
  });
  const provider={...base,id:providerId,getModels:()=>base.getModels().map(model=>({...model,provider:providerId})),auth:{apiKey:{name:'NVIDIA evaluation credential',async resolve(){return {auth:{apiKey:options.apiKey},source:'explicit quality trial'};}}},
    stream(){throw new Error('REPLY_QUALITY_STREAM_UNSUPPORTED');},streamSimple(model:Parameters<typeof base.streamSimple>[0],context:Parameters<typeof base.streamSimple>[1],settings:Parameters<typeof base.streamSimple>[2]){
      if(modelCalls!==0)throw new Error('REPLY_QUALITY_GENERATION_LIMIT');modelCalls++;
      return base.streamSimple(model,context,{...settings,maxTokens:plan.settings.maxOutputTokens,maxRetries:0,timeoutMs:45000,temperature:1,fetch:transport,
        samplingParams,signal:settings?.signal?AbortSignal.any([settings.signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000),
        onPayload(payload){const p=payload as Record<string,any>;if(p.model!==plan.model||p.stream!==true||p.tool_choice!=='none'||(p.tools!==undefined&&(!Array.isArray(p.tools)||p.tools.some((t:any)=>t?.function?.name!=='task'))))throw new Error('REPLY_QUALITY_PAYLOAD_INVALID');return {...p,tools:undefined};}});
    }};
  function QualityAgent(){useModel(`${providerId}/${plan.model}`,{thinkingLevel:'off',compaction:false});return plan.instructions;}
  QualityAgent.agentName='ReplyQualityEvaluation';QualityAgent.durability={maxAttempts:1,timeoutMs:60000};
  let runtime:Awaited<ReturnType<typeof start>>|undefined;
  try{runtime=await start({agents:[QualityAgent],db:sqlite(options.database),providers:[provider],env:{}});const handle=init(QualityAgent,{id:instanceId});
    const admitted=await handle.dispatch({message:JSON.stringify(item.input),idempotencyKey:`${plan.datasetHash}:${item.id}:${repeat}`});receipt=admitted;
    const result=await handle.read(admitted.submissionId,{signal:AbortSignal.timeout(55000)});output=result.text??'';
    const captured=evidence as PreviewEvidence|null;if(captured?.complete&&captured.output===output&&captured.finishReason==='stop'&&!captured.tools)status='completed';
  }catch{/* Errors may contain provider headers or credentials; preserve fixed status and separately captured SSE evidence only. */}
  finally{await runtime?.stop();}
  const result:QualityResult={caseId:item.id,repeat,datasetHash:plan.datasetHash,promptHash:plan.promptHash,model:plan.model,origin:options.origin,instanceId,receipt,startedAt,elapsedMs:Date.now()-began,httpRequests,modelCalls,status,output,evidence,httpStatuses};
  await capture({phase:'result',result});return result;
}
