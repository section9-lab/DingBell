import * as v from 'valibot';
import {aiScopeSchema} from '../conversations/ai-state.ts';
import {replyBodySchema} from '../conversations/control-state.ts';
import type {ControlScope} from '../conversations/control-types.ts';
import {currentPayload,readAiExecution,type AiRunReader} from './storage.ts';
import {reviewAiKnowledgeEvidence,type AiKnowledgeBindings} from './knowledge.ts';
import {knowledgeProfile} from '../knowledge/vectorize.ts';
const hash=v.pipe(v.string(),v.regex(/^[0-9a-f]{64}$/));
export const aiAnswerInputSchema=v.strictObject({body:replyBodySchema,citations:v.pipe(v.array(hash),v.minLength(1),v.maxLength(10),v.check(ids=>new Set(ids).size===ids.length))});
export type AiAnswerInput=v.InferOutput<typeof aiAnswerInputSchema>;
export const aiAnswerResultSchema=v.strictObject({status:v.picklist(['submitted','conflict','unavailable','unconfirmed']),canSend:v.literal(false),reviewRequired:v.literal(true)});
const result=(status:v.InferOutput<typeof aiAnswerResultSchema>['status'])=>({status,canSend:false as const,reviewRequired:true as const});
type Answer={body:string;citations:string;knowledgeEvidence:string;createdAt:number};
const row=(db:D1Database,id:string)=>db.prepare('SELECT body,citations,knowledge_evidence AS knowledgeEvidence,created_at AS createdAt FROM ai_answer WHERE run_id=?').bind(id).first<Answer>();
async function authority(env:AiKnowledgeBindings,read:AiRunReader,scope:ControlScope,id:string){
 if(!env.DB||env.AI_RECEPTION_ENABLED!=='true')return null;
 const execution=await readAiExecution(env.DB,scope,id);if(!execution||execution.closure||execution.config.model.promptVersion!=='support-answer-v1')return null;
 const query=await env.DB.prepare('SELECT evidence FROM ai_knowledge_query WHERE run_id=?').bind(id).first<{evidence:string|null}>();if(!query?.evidence)return null;
 const evidence=await reviewAiKnowledgeEvidence(env,read,scope,id,JSON.parse(query.evidence));if(!evidence?.chunks.length)return null;
 return {execution,evidence,rawEvidence:query.evidence};
}
/** Internal draft only: citation validity is not semantic verification or permission to contact a customer. */
export async function submitAiAnswer(env:AiKnowledgeBindings,read:AiRunReader,scope:ControlScope,id:string,value:unknown){
 let attempted=false;
 try{
  scope=v.parse(aiScopeSchema,scope);const input=v.parse(aiAnswerInputSchema,structuredClone(value)),c=await authority(env,read,scope,id);
  if(!c||!input.citations.every(key=>c.evidence.chunks.some(chunk=>chunk.chunkId===key)))return result('unavailable');
  const db=env.DB!,now=Date.now();if(env.AI_RECEPTION_ENABLED!=='true')return result('unavailable');
  // The insert observes the run, published revisions and source bodies in the same D1 statement.
  attempted=true;
  await db.prepare(`INSERT INTO ai_answer(run_id,body,citations,knowledge_evidence,created_at)
   SELECT e.id,?,?,q.evidence,? FROM ai_execution e JOIN ai_knowledge_query q ON q.run_id=e.id JOIN (SELECT ? AS value) plan
   WHERE e.id=? AND e.closure IS NULL AND e.payload=plan.value AND q.evidence=?
    AND CAST(unixepoch('subsecond')*1000 AS INTEGER)<json_extract(plan.value,'$.run.deadlineAt') AND ${currentPayload}
    AND NOT EXISTS (SELECT 1 FROM json_each(q.evidence,'$.chunks') wanted WHERE NOT EXISTS (
     SELECT 1 FROM knowledge_chunk k JOIN knowledge_document d ON d.id=k.document_id AND d.organization_id=k.organization_id AND d.active_revision=k.revision
     JOIN knowledge_revision r ON r.document_id=k.document_id AND r.organization_id=k.organization_id AND r.revision=k.revision
     WHERE k.organization_id=e.organization_id AND k.document_id=json_extract(wanted.value,'$.documentId') AND k.revision=json_extract(wanted.value,'$.revision')
      AND k.id=json_extract(wanted.value,'$.chunkId') AND k.body_hash=json_extract(wanted.value,'$.bodyHash') AND k.body=json_extract(wanted.value,'$.body')
      AND r.title=json_extract(wanted.value,'$.title') AND r.content_hash=json_extract(wanted.value,'$.contentHash') AND r.index_profile=? AND r.published_profile=?
      AND (d.store_id IS NULL OR d.store_id=e.store_id) AND (d.product_ref IS NULL OR d.product_ref=json_extract(q.scope,'$.productRef')) AND d.language=json_extract(q.scope,'$.language')))
   ON CONFLICT(run_id) DO NOTHING`).bind(input.body,JSON.stringify(input.citations),now,JSON.stringify(c.execution.payload),id,c.rawEvidence,knowledgeProfile.id,knowledgeProfile.id).run();
  const saved=await reviewAiAnswer(env,read,scope,id);if(!saved)return result('unavailable');
  return result(saved.body===input.body&&JSON.stringify(saved.citations)===JSON.stringify(input.citations)?'submitted':'conflict');
 }catch{return result(attempted?'unconfirmed':'unavailable');}
}
/** A fresh review of this draft is mandatory before any future sending workflow can consider it. */
export async function reviewAiAnswer(env:AiKnowledgeBindings,read:AiRunReader,scope:ControlScope,id:string){
 try{
  scope=v.parse(aiScopeSchema,scope);const c=await authority(env,read,scope,id);if(!c)return null;
  const saved=await row(env.DB!,id);if(!saved||saved.knowledgeEvidence!==c.rawEvidence)return null;
  const input=v.parse(aiAnswerInputSchema,{body:saved.body,citations:JSON.parse(saved.citations)});
  if(!input.citations.every(key=>c.evidence.chunks.some(chunk=>chunk.chunkId===key)))return null;
  if(!await reviewAiKnowledgeEvidence(env,read,scope,id,c.evidence))return null;
  return {...input,createdAt:saved.createdAt,canSend:false as const,reviewRequired:true as const};
 }catch{return null;}
}
