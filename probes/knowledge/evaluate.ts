import * as v from 'valibot';
import { knowledgeDraftSchema, knowledgeScopeSchema } from '../../src/shared/knowledge.ts';
import { knowledgeHash, prepareKnowledge } from '../../src/modules/knowledge/content.ts';
import { embedKnowledge, knowledgeProfile } from '../../src/modules/knowledge/vectorize.ts';
import { datasetVersion, evaluationCases, evaluationDocuments } from './cases.ts';

export async function prepareEvaluation() {
  const entries:{key:string;kind:'chunk'|'query';text:string;documentId:string|null}[]=[];
  const documents=[];
  for(const document of evaluationDocuments) {
    const prepared=await prepareKnowledge('synthetic-semantic-company',document.id,1,
      v.parse(knowledgeScopeSchema,document.scope),v.parse(knowledgeDraftSchema,document.draft));
    documents.push({id:document.id,language:document.language,title:document.draft.title,chunkKeys:prepared.chunks.map(chunk=>chunk.id)});
    for(const chunk of prepared.chunks)entries.push({key:chunk.id,kind:'chunk',text:chunk.body,documentId:document.id});
  }
  const cases=[];
  for(const item of evaluationCases) {
    const key=await knowledgeHash([datasetVersion,item.id,item.question]);
    cases.push({...item,key});entries.push({key,kind:'query',text:item.question,documentId:null});
  }
  const totalInputBytes=entries.reduce((sum,item)=>sum+new TextEncoder().encode(item.text).length,0);
  if(entries.length>128||totalInputBytes>64_000||entries.some(item=>new TextEncoder().encode(item.text).length>2400))throw new Error('KNOWLEDGE_EVAL_INPUT_LIMIT');
  const value={datasetVersion,model:knowledgeProfile.model,profile:knowledgeProfile.id,dimensions:knowledgeProfile.dimensions,
    topK:3,minimumScore:.7,totalInputBytes,documents,cases,entries};
  return {...value,datasetHash:await knowledgeHash(value)};
}
export type EvaluationPlan=Awaited<ReturnType<typeof prepareEvaluation>>;
const vector=v.pipe(v.array(v.pipe(v.number(),v.finite())),v.length(knowledgeProfile.dimensions),v.check(row=>row.some(value=>value!==0)));
const artifactSchema=v.strictObject({datasetHash:v.string(),profile:v.literal(knowledgeProfile.id),model:v.literal(knowledgeProfile.model),
  origin:v.picklist(['synthetic','workers-ai']),rows:v.pipe(v.array(v.strictObject({key:v.string(),values:vector})),v.minLength(1),v.maxLength(128))});
export type EmbeddingArtifact=v.InferOutput<typeof artifactSchema>;
function normalized(row:number[]) {
  const scale=Math.max(...row.map(Math.abs)),scaled=row.map(value=>value/scale),length=Math.hypot(...scaled);
  return scaled.map(value=>value/length);
}
export function evaluateEmbeddings(plan:EvaluationPlan,input:unknown) {
  const parsed=v.safeParse(artifactSchema,input);
  if(!parsed.success||parsed.output.datasetHash!==plan.datasetHash||parsed.output.rows.length!==plan.entries.length
    ||new Set(parsed.output.rows.map(row=>row.key)).size!==plan.entries.length
    ||parsed.output.rows.some(row=>!plan.entries.some(entry=>entry.key===row.key)))throw new Error('KNOWLEDGE_EVAL_ARTIFACT_INVALID');
  const data=parsed.output,vectors=new Map(data.rows.map(row=>[row.key,normalized(row.values)]));
  const cases=plan.cases.map(item=>{
    const query=vectors.get(item.key)!;
    const ranked=plan.documents.filter(document=>document.language===item.knowledgeLanguage).flatMap(document=>document.chunkKeys.map(key=>({
      documentId:document.id,chunkId:key,score:Math.max(-1,Math.min(1,query.reduce((sum,value,i)=>sum+value*vectors.get(key)![i],0))),
    }))).sort((a,b)=>b.score-a.score||(a.chunkId<b.chunkId?-1:a.chunkId>b.chunkId?1:0));
    const index=item.expectedDocumentId===null?-1:ranked.findIndex(row=>row.documentId===item.expectedDocumentId);
    return {...item,rank:index<0?null:index+1,expectedScore:index<0?null:ranked[index].score,matches:ranked.slice(0,plan.topK)};
  });
  function metrics(split:'calibration'|'holdout') {
    const selected=cases.filter(item=>item.split===split),positive=selected.filter(item=>item.expectedDocumentId!==null),negative=selected.filter(item=>item.expectedDocumentId===null);
    return {answerable:positive.length,hitAt1:positive.filter(item=>item.rank===1).length/positive.length,
      hitAt3:positive.filter(item=>item.rank!==null&&item.rank<=plan.topK).length/positive.length,
      mrrAt3:positive.reduce((sum,item)=>sum+(item.rank!==null&&item.rank<=plan.topK?1/item.rank:0),0)/positive.length,
      unanswerable:negative.length,unsupportedAboveThreshold:negative.filter(item=>item.matches.some(match=>match.score>=plan.minimumScore)).length,
      expectedBelowThreshold:positive.filter(item=>item.expectedScore===null||item.expectedScore<plan.minimumScore).length};
  }
  return {datasetHash:plan.datasetHash,profile:data.profile,model:data.model,origin:data.origin,answerQuality:'not_evaluated' as const,
    retrieval:'local_exact_cosine' as const,topK:plan.topK,minimumScore:plan.minimumScore,calibration:metrics('calibration'),holdout:metrics('holdout'),cases};
}
export type CaptureEvent={phase:'attempt'|'result'|'unknown';batch:number;keys:string[];at:string;elapsedMs?:number;rows?:EmbeddingArtifact['rows']};
export async function collectEmbeddings(ai:Ai,plan:EvaluationPlan,capture:(event:CaptureEvent)=>Promise<void>):Promise<EmbeddingArtifact> {
  const rows:EmbeddingArtifact['rows']=[];
  for(let offset=0;offset<plan.entries.length;offset+=16) {
    const batch=offset/16,entries=plan.entries.slice(offset,offset+16),keys=entries.map(entry=>entry.key),start=Date.now();
    await capture({phase:'attempt',batch,keys,at:new Date().toISOString()});
    let values:number[][];
    try { values=await embedKnowledge(ai,entries.map(entry=>entry.text)); }
    catch {await capture({phase:'unknown',batch,keys,at:new Date().toISOString(),elapsedMs:Date.now()-start});throw new Error('KNOWLEDGE_EVAL_COLLECTION_UNKNOWN');}
    const result=keys.map((key,index)=>({key,values:values[index]}));
    await capture({phase:'result',batch,keys,at:new Date().toISOString(),elapsedMs:Date.now()-start,rows:result});rows.push(...result);
  }
  return {datasetHash:plan.datasetHash,profile:knowledgeProfile.id,model:knowledgeProfile.model,origin:'workers-ai',rows};
}
