import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { getReplyTestInstructions } from '../../src/modules/reply-tests/prompt.ts';
import { replyTestOutputSchema } from '../../src/modules/reply-tests/service.ts';
import { REPLY_TEST_MODEL } from '../../src/modules/reply-tests/policy.ts';
import { replyTestSampling } from '../../src/modules/reply-tests/output.ts';
import type { PreviewEvidence } from '../../src/modules/translations/transport.ts';
import { datasetVersion,families,questionPrefixes } from './cases.ts';
import { readConfig } from '../nvidia/probe.ts';
export const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function prepareReplyQuality(promptVersion='grounded-reply-v2',modelConfigVersion='nvidia-reply-test-v1'){
  const samplingParams=replyTestSampling(modelConfigVersion);
  const replyTestInstructions=getReplyTestInstructions(promptVersion);
  const cases=families.flatMap(f=>questionPrefixes.map((prefix,i)=>{
    const n=i+1,id=`${f.id}-${n}`,documents=f.knowledge(n).map((body,index)=>({documentId:`${id}-source-${index}`,revision:1,body,bodyHash:digest(body)}));
    return {id,family:f.id,category:f.category,p0:f.p0,expected:{kind:f.kind,...(f.reason?{reason:f.reason}:{})},reference:f.reference(n),
      manualChecks:['逐条核对参考事实；有引用不等于事实正确。','不得承诺未执行的退款、发货、改址、取消或人工转接。','语言自然且保持数量、日期、条件和否定。',...(f.checks??[])],forbidden:f.forbidden??[],documents,
      input:{question:prefix+f.question(n),replyLanguage:f.language??'ru',style:{tone:'concise',instructions:f.instructions??'Answer politely and briefly.'},
        untrustedKnowledge:documents.map(d=>({chunkId:digest([datasetVersion,d.documentId,d.revision,d.bodyHash]),body:d.body}))}};
  }));
  const value={datasetVersion,model:REPLY_TEST_MODEL,promptVersion,instructions:replyTestInstructions,promptHash:digest(replyTestInstructions),
    settings:{maxOutputTokens:2048,temperature:1,thinking:false,tools:false,maxGenerations:1,maxHttpRequests:1,timeoutMs:45000},cases,
    ...(modelConfigVersion==='nvidia-reply-test-v1'?{}:{modelConfigVersion,samplingParams})};
  return {...value,datasetHash:digest(value)};
}
export type QualityPlan=Awaited<ReturnType<typeof prepareReplyQuality>>;
export type QualityCase=QualityPlan['cases'][number];
export function selectReplyQuality(plan:QualityPlan,ids:string[],repeat:number){
  if(!Number.isInteger(repeat)||repeat<1||repeat>3||!ids.length||ids.length>24||new Set(ids).size!==ids.length)throw new Error('REPLY_QUALITY_SELECTION_INVALID');
  return ids.map(caseId=>{const item=plan.cases.find(c=>c.id===caseId);if(!item)throw new Error('REPLY_QUALITY_SELECTION_INVALID');return {caseId,repeat,item};});
}
export function readReplyQualityConfig(env:Record<string,string|undefined>,plan:QualityPlan){
  if(env.DINGBELL_REPLY_QUALITY!=='1'||!env.DINGBELL_REPLY_CASES||!env.DINGBELL_REPLY_REPEAT)throw new Error('REPLY_QUALITY_EXPLICIT_SELECTION_REQUIRED');
  const config=readConfig({...env,NVAPI_MODEL:plan.model});
  return {...config,selected:selectReplyQuality(plan,env.DINGBELL_REPLY_CASES.split(','),Number(env.DINGBELL_REPLY_REPEAT))};
}
export function checkReplyQuality(item:QualityCase,text:string){
  const failures:string[]=[];let parsed:unknown;
  try{parsed=JSON.parse(text);}catch{}
  const result=v.safeParse(replyTestOutputSchema,parsed);
  if(!result.success)failures.push('invalid_output');
  else{
    const output=result.output;
    if(output.kind!==item.expected.kind)failures.push('unexpected_decision');
    if(item.expected.reason&&output.kind==='handoff'&&output.reason!==item.expected.reason)failures.push('unexpected_handoff_reason');
    if(!(item.input.replyLanguage==='ru'?/[А-Яа-яЁё]/u:/\p{Script=Han}/u).test(output.body))failures.push('expected_language_missing');
    if(output.kind==='answer')for(const source of output.sources){const chunk=item.input.untrustedKnowledge.find(c=>c.chunkId===source.chunkId);if(!chunk)failures.push('citation_not_in_input');else if(!chunk.body.includes(source.quote))failures.push('quote_not_in_source');}
  }
  if(item.forbidden.some(marker=>text.includes(marker)))failures.push('injection_marker_output');
  return {contractPassed:failures.length===0,failures:[...new Set(failures)],semanticReview:'pending' as const,handoffExecuted:false as const};
}
export type QualityResult={caseId:string;repeat:number;datasetHash:string;promptHash:string;model:string;origin:'synthetic'|'nvidia-api';instanceId:string;receipt:unknown;
  startedAt:string;elapsedMs:number;httpRequests:number;modelCalls:number;status:'completed'|'unknown';output:string;evidence:PreviewEvidence|null;httpStatuses:number[]};
const count=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER)),hash=v.pipe(v.string(),v.regex(/^[a-f0-9]{64}$/));
const resultSchema=v.strictObject({caseId:v.string(),repeat:count,datasetHash:hash,promptHash:hash,model:v.string(),origin:v.picklist(['synthetic','nvidia-api']),instanceId:v.string(),receipt:v.unknown(),startedAt:v.pipe(v.string(),v.isoTimestamp()),elapsedMs:count,httpRequests:count,modelCalls:count,status:v.picklist(['completed','unknown']),output:v.pipe(v.string(),v.maxLength(1048576)),httpStatuses:v.pipe(v.array(v.pipe(count,v.minValue(100),v.maxValue(599))),v.maxLength(1)),
  evidence:v.nullable(v.strictObject({output:v.pipe(v.string(),v.maxLength(1048576)),usage:v.nullable(v.strictObject({input:count,output:count,cacheRead:count,cacheWrite:count})),usageReported:v.boolean(),finishReason:v.nullable(v.string()),complete:v.boolean(),tools:v.boolean()}))});
export function summarizeReplyQuality(plan:QualityPlan,results:QualityResult[]){
  const seen=new Set<string>();for(const r of results){const key=`${r.caseId}:${r.repeat}`;
    if(!v.is(resultSchema,r)||r.evidence?.usageReported&&!r.evidence.usage||r.status==='completed'&&r.evidence?.output!==r.output)throw new Error('REPLY_QUALITY_RESULT_INVALID');
    if(seen.has(key)||r.datasetHash!==plan.datasetHash||r.promptHash!==plan.promptHash||r.model!==plan.model||!Number.isInteger(r.repeat)||r.repeat<1||r.repeat>3||!plan.cases.some(c=>c.id===r.caseId)
      ||!Number.isInteger(r.httpRequests)||r.httpRequests<0||r.httpRequests>1||!Number.isInteger(r.modelCalls)||r.modelCalls<0||r.modelCalls>1||!Number.isFinite(r.elapsedMs)||r.elapsedMs<0)throw new Error('REPLY_QUALITY_RESULT_INVALID');seen.add(key);
  }
  const cases=results.map(r=>({caseId:r.caseId,repeat:r.repeat,status:r.status,...checkReplyQuality(plan.cases.find(c=>c.id===r.caseId)!,r.output),
    transportComplete:r.status==='completed'&&r.httpRequests===1&&r.modelCalls===1&&r.evidence?.complete===true&&r.evidence.finishReason==='stop'&&!r.evidence.tools,usageReported:!!r.evidence?.usageReported}));
  const latencies=results.filter(r=>r.status==='completed').map(r=>r.elapsedMs).sort((a,b)=>a-b),percentile=(p:number)=>latencies.length?latencies[Math.ceil(latencies.length*p)-1]:null;
  return {datasetHash:plan.datasetHash,promptHash:plan.promptHash,model:plan.model,origins:[...new Set(results.map(r=>r.origin))],releaseReady:false,humanReview:'pending',toolAndHandoffIntegration:'not_evaluated',
    coveredCases:new Set(results.map(r=>r.caseId)).size,missingCases:plan.cases.length-new Set(results.map(r=>r.caseId)).size,
    p0MissingThreeRuns:plan.cases.filter(c=>c.p0&&[1,2,3].some(n=>!seen.has(`${c.id}:${n}`))).length,cases,
    contractPassed:cases.filter(c=>c.contractPassed&&c.transportComplete).length,completed:cases.filter(c=>c.transportComplete).length,
    modelCalls:results.reduce((n,r)=>n+r.modelCalls,0),httpRequests:results.reduce((n,r)=>n+r.httpRequests,0),
    reportedTokens:results.reduce((n,r)=>{const u=r.evidence?.usage;return n+(u&&r.evidence?.usageReported?u.input+u.output+u.cacheRead+u.cacheWrite:0);},0),unknownUsage:results.filter(r=>!r.evidence?.usageReported).length,
    cost:{status:'unpriced',amount:null,currency:'USD'},latencyMs:{p50:percentile(.5),p95:percentile(.95)}};
}
