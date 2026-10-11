import * as v from 'valibot';
import {aiRunSchema,aiScopeSchema} from '../conversations/ai-state.ts';
import type {ControlScope} from '../conversations/control-types.ts';
import {knowledgeHash} from '../knowledge/content.ts';
import {knowledgeProfile} from '../knowledge/vectorize.ts';
import {aiAnswerInputSchema} from './answer.ts';
import {aiKnowledgeEvidenceSchema,resolvePublishedAiKnowledge,type AiKnowledgeBindings} from './knowledge.ts';
import {currentPayload,readAiExecution,type AiRunReader} from './storage.ts';

type Bindings=AiKnowledgeBindings & {AI_OUTBOUND_ENABLED?:string;OUTBOUND_ENABLED?:string};
type ReviewMode='live'|'completed';
type Saved={id:string;payloadHash:string;body:string;bodyHash:string;citations:string;knowledgeEvidence:string;platformStoreId:string;platformThreadId:string;credentialVersion:number;createdAt:number};
const enabled=(env:Bindings)=>!!env.DB&&env.AI_RECEPTION_ENABLED==='true'&&env.AI_OUTBOUND_ENABLED==='true'&&env.OUTBOUND_ENABLED==='true';
const now="CAST(unixepoch('subsecond')*1000 AS INTEGER)";
const result=(status:'prepared'|'conflict'|'unavailable'|'unconfirmed',intentId:string|null=null)=>({status,intentId,canSend:false as const,sent:false as const});
const from=`ai_execution e JOIN ai_knowledge_query q ON q.run_id=e.id
 JOIN store s ON s.id=e.store_id AND s.organization_id=e.organization_id
 JOIN conversation c ON c.id=e.conversation_id AND c.store_id=e.store_id AND c.organization_id=e.organization_id
 JOIN ai_budget b ON b.id=e.budget_id AND b.organization_id=e.organization_id JOIN (SELECT ? AS value) plan`;
// Reuse this predicate for the read and the insert; an earlier read is not a write-time grant.
const eligible=(mode:ReviewMode)=>`e.id=? AND e.payload=plan.value AND e.payload_hash=? AND q.evidence=?
 AND ${mode==='live'?'e.closure IS NULL':`e.closure=? AND e.receipt=? AND e.generations>0
  AND e.generations=(SELECT COUNT(*) FROM ai_generation WHERE run_id=e.id)
  AND NOT EXISTS (SELECT 1 FROM ai_generation WHERE run_id=e.id AND (usage IS NULL OR charged_micros IS NULL OR settled_at IS NULL))`}
 AND json_extract(e.config,'$.model.promptVersion')='support-reply-v1' AND ${currentPayload}
 AND s.outbound_enabled=1 AND s.status IN ('verified','partial','attention') AND s.platform='ozon'
 AND length(s.platform_store_id)>0 AND length(c.platform_thread_id)>0 AND s.credential_version>0
 AND length(s.credential_key_version)>0 AND length(s.credential_nonce)>0 AND length(s.credential_ciphertext)>0 AND s.expires_at>${now}
 AND (SELECT COUNT(DISTINCT json_extract(value,'$.code')) FROM json_each(s.capabilities)
  WHERE json_extract(value,'$.code') IN ('auth','reply') AND json_extract(value,'$.status')='available')=2
 AND b.enabled=1 AND b.starts_at<=${now} AND b.ends_at>${now} AND b.spent_micros<=b.limit_micros AND b.reserved_micros<=b.limit_micros-b.spent_micros
 AND json_extract(q.scope,'$.productRef') IS (SELECT CASE WHEN COUNT(DISTINCT alias.product_id)=1 THEN MIN(alias.product_id) END
  FROM message m JOIN product_sku alias ON alias.organization_id=m.organization_id AND alias.store_id=m.store_id AND alias.sku=m.sku
  WHERE m.id=json_extract(plan.value,'$.run.request.messageId') AND m.organization_id=e.organization_id AND m.store_id=e.store_id AND m.conversation_id=e.conversation_id)
 AND NOT EXISTS (SELECT 1 FROM json_each(q.evidence,'$.chunks') wanted WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_chunk k JOIN knowledge_document d ON d.id=k.document_id AND d.organization_id=k.organization_id AND d.active_revision=k.revision
  JOIN knowledge_revision r ON r.document_id=k.document_id AND r.organization_id=k.organization_id AND r.revision=k.revision
  WHERE k.organization_id=e.organization_id AND k.document_id=json_extract(wanted.value,'$.documentId') AND k.revision=json_extract(wanted.value,'$.revision')
   AND k.id=json_extract(wanted.value,'$.chunkId') AND k.body_hash=json_extract(wanted.value,'$.bodyHash') AND k.body=json_extract(wanted.value,'$.body')
   AND r.title=json_extract(wanted.value,'$.title') AND r.content_hash=json_extract(wanted.value,'$.contentHash') AND r.index_profile=? AND r.published_profile=?
   AND (d.store_id IS NULL OR d.store_id=e.store_id) AND (d.product_ref IS NULL OR d.product_ref=json_extract(q.scope,'$.productRef')) AND d.language=json_extract(q.scope,'$.language')))`;
type Channel={platformStoreId:string;platformThreadId:string;credentialVersion:number};
async function authority(env:Bindings,read:AiRunReader,scope:ControlScope,id:string,mode:ReviewMode='live'){
 if(!enabled(env))return null;
 const db=env.DB!,execution=await readAiExecution(db,scope,id);
 if(!execution||execution.config.model.promptVersion!=='support-reply-v1')return null;
 if(mode==='live'?execution.closure!==null:execution.closure?.kind!=='runtime_closed'||execution.closure.outcome!=='completed'
  ||execution.status!=='settled'||execution.remainingReservedMicros!==0||!execution.receipt||!execution.generations.length
  ||execution.generations.some(g=>g.usage===null||g.chargedMicros===null||g.settledAt===null))return null;
 const run=v.parse(aiRunSchema,execution.payload.run);
 const query=await db.prepare('SELECT evidence,scope,question_hash AS questionHash FROM ai_knowledge_query WHERE run_id=?').bind(id).first<{evidence:string|null;scope:string;questionHash:string}>();
 if(!query?.evidence)return null;
 const evidence=v.parse(aiKnowledgeEvidenceSchema,JSON.parse(query.evidence));
 if(!evidence.chunks.length||new Set(evidence.chunks.map(c=>c.chunkId)).size!==evidence.chunks.length||evidence.runId!==id||evidence.scope.storeId!==scope.storeId
  ||evidence.scope.language!==run.admission.language||JSON.stringify(evidence.scope)!==JSON.stringify(JSON.parse(query.scope))
  ||evidence.questionHash!==query.questionHash||evidence.questionHash!==await knowledgeHash(run.admission.question))return null;
 const payloadHash=await knowledgeHash({payload:execution.payload,config:execution.config});
 const bound=[JSON.stringify(execution.payload),id,payloadHash,query.evidence,
  ...(mode==='completed'?[JSON.stringify(execution.closure),JSON.stringify(execution.receipt)]:[]),knowledgeProfile.id,knowledgeProfile.id];
 const current=async()=>{
  if(!enabled(env)||Date.now()>=run.deadlineAt||JSON.stringify(await read({...scope},id))!==JSON.stringify(run))return null;
  return db.prepare(`SELECT s.platform_store_id AS platformStoreId,c.platform_thread_id AS platformThreadId,s.credential_version AS credentialVersion FROM ${from} WHERE ${eligible(mode)}`).bind(...bound).first<Channel>();
 };
 const channel=await current();if(!channel)return null;
 const resolved=await resolvePublishedAiKnowledge(db,scope.organizationId,evidence.scope,evidence.chunks);
 if(!resolved||resolved.some((chunk,i)=>JSON.stringify(chunk)!==JSON.stringify((({score,...source})=>source)(evidence.chunks[i]))))return null;
 if(JSON.stringify(await current())!==JSON.stringify(channel))return null;
 return {run,evidence,rawEvidence:query.evidence,payloadHash,bound,channel,current};
}
const row=(db:D1Database,id:string)=>db.prepare(`SELECT id,payload_hash AS payloadHash,body,body_hash AS bodyHash,citations,knowledge_evidence AS knowledgeEvidence,
 platform_store_id AS platformStoreId,platform_thread_id AS platformThreadId,credential_version AS credentialVersion,created_at AS createdAt FROM ai_reply_intent WHERE run_id=?`).bind(id).first<Saved>();
/** Immutable preparation only. This module cannot grant dispatch or impersonate a merchant member. */
export async function prepareAiReply(env:Bindings,read:AiRunReader,scope:ControlScope,id:string,value:unknown){
 let attempted=false;
 try{
  scope=v.parse(aiScopeSchema,scope);const input=v.parse(aiAnswerInputSchema,structuredClone(value)),c=await authority(env,read,scope,id);
  if(!c||!input.citations.every(key=>c.evidence.chunks.some(chunk=>chunk.chunkId===key)))return result('unavailable');
  const bodyHash=await knowledgeHash(input.body),intentId='ai-reply:'+id;
  if(!enabled(env))return result('unavailable');attempted=true;
  await env.DB!.prepare(`INSERT INTO ai_reply_intent(run_id,id,payload_hash,body,body_hash,citations,knowledge_evidence,platform_store_id,platform_thread_id,credential_version,created_at)
   SELECT e.id,?,e.payload_hash,?,?,?,q.evidence,s.platform_store_id,c.platform_thread_id,s.credential_version,${now} FROM ${from} WHERE ${eligible('live')}
    AND s.platform_store_id=? AND c.platform_thread_id=? AND s.credential_version=? ON CONFLICT(run_id) DO NOTHING`)
   .bind(intentId,input.body,bodyHash,JSON.stringify(input.citations),...c.bound,c.channel.platformStoreId,c.channel.platformThreadId,c.channel.credentialVersion).run();
  const saved=await reviewAiReply(env,read,scope,id);if(!saved)return result('unavailable');
  return result(saved.body===input.body&&JSON.stringify(saved.citations)===JSON.stringify(input.citations)?'prepared':'conflict',saved.id);
 }catch{return result(attempted?'unconfirmed':'unavailable',attempted?'ai-reply:'+id:null);}
}
async function review(env:Bindings,read:AiRunReader,scope:ControlScope,id:string,mode:ReviewMode){
 try{
  scope=v.parse(aiScopeSchema,scope);const c=await authority(env,read,scope,id,mode);if(!c)return null;
  const saved=await row(env.DB!,id);if(!saved||saved.id!=='ai-reply:'+id||saved.payloadHash!==c.payloadHash||saved.knowledgeEvidence!==c.rawEvidence
   ||saved.platformStoreId!==c.channel.platformStoreId||saved.platformThreadId!==c.channel.platformThreadId||saved.credentialVersion!==c.channel.credentialVersion)return null;
  const input=v.parse(aiAnswerInputSchema,{body:saved.body,citations:JSON.parse(saved.citations)});
  if(await knowledgeHash(input.body)!==saved.bodyHash||!input.citations.every(key=>c.evidence.chunks.some(chunk=>chunk.chunkId===key)))return null;
  if(JSON.stringify(await c.current())!==JSON.stringify(c.channel))return null;
  return {...input,id:saved.id,runId:id,run:c.run,origin:'ai' as const,actorUserId:null,actorMemberId:null,payloadHash:saved.payloadHash,bodyHash:saved.bodyHash,
   knowledgeEvidence:c.evidence,platformStoreId:saved.platformStoreId,platformThreadId:saved.platformThreadId,credentialVersion:saved.credentialVersion,createdAt:saved.createdAt,canSend:false as const};
 }catch{return null;}
}
/** Live-run eligibility only; closing the runtime never promotes a human-review draft. */
export function reviewAiReply(env:Bindings,read:AiRunReader,scope:ControlScope,id:string){
 return review(env,read,scope,id,'live');
}
/** A successful, fully settled runtime is necessary but does not replace the sender's final commit check. */
export function reviewCompletedAiReply(env:Bindings,read:AiRunReader,scope:ControlScope,id:string){
 return review(env,read,scope,id,'completed');
}
