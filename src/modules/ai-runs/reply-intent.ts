import * as v from 'valibot';
import {aiRunSchema,aiScopeSchema} from '../conversations/ai-state.ts';
import type {ControlScope} from '../conversations/control-types.ts';
import {knowledgeHash} from '../knowledge/content.ts';
import {resolveTextKnowledgeCitations} from '../knowledge/text-profile.ts';
import {knowledgeTextProfile,textPublicationSQL} from '../knowledge/text-profile-id.ts';
import {aiAnswerInputSchema} from '../conversations/reply-tool.ts';
import {aiKnowledgeEvidenceSchema,type AiKnowledgeBindings} from './knowledge.ts';
import {readRunKnowledgeEvidence} from './text-knowledge.ts';
import {currentPayload,readAiExecution,type AiRunReader} from './storage.ts';

type Bindings=AiKnowledgeBindings & {AI_OUTBOUND_ENABLED?:string;OUTBOUND_ENABLED?:string};
type ReviewMode='live'|'completed';
const enabled=(env:Bindings)=>!!env.DB&&env.AI_OUTBOUND_ENABLED==='true'&&env.OUTBOUND_ENABLED==='true';
const now="CAST(unixepoch('subsecond')*1000 AS INTEGER)";
const result=(status:'prepared'|'conflict'|'unavailable'|'unconfirmed',intentId:string|null=null)=>({status,intentId,canSend:false as const,sent:false as const});
const from=`ai_execution e
 JOIN store s ON s.id=e.store_id AND s.organization_id=e.organization_id
 JOIN conversation c ON c.id=e.conversation_id AND c.store_id=e.store_id AND c.organization_id=e.organization_id
 JOIN ai_budget b ON b.id=e.budget_id AND b.organization_id=e.organization_id JOIN (SELECT ? AS value) plan`;
// Reuse this predicate for the read and the insert; an earlier read is not a write-time grant.
const eligible=(mode:ReviewMode)=>`e.id=? AND e.payload=plan.value AND e.payload_hash=?
 AND ${mode==='live'?'e.closure IS NULL':`e.closure=? AND e.receipt=? AND e.generations>0
  AND e.generations=(SELECT COUNT(*) FROM ai_generation WHERE run_id=e.id)
  AND NOT EXISTS (SELECT 1 FROM ai_generation WHERE run_id=e.id AND (usage IS NULL OR charged_micros IS NULL OR settled_at IS NULL))`}
 AND json_extract(e.config,'$.model.promptVersion')='support-reply-v1' AND ${currentPayload}
 AND s.outbound_enabled=1 AND s.status IN ('verified','partial','attention') AND s.platform='ozon'
 AND length(s.platform_store_id)>0 AND length(c.platform_thread_id)>0 AND s.credential_version>0
 AND length(s.credential_key_version)>0 AND length(s.credential_nonce)>0 AND length(s.credential_ciphertext)>0 AND s.expires_at>${now}
 AND EXISTS (SELECT 1 FROM json_each(s.capabilities)
  WHERE json_extract(value,'$.code')='auth' AND json_extract(value,'$.status')='available')
 AND b.enabled=1 AND b.starts_at<=${now} AND b.ends_at>${now} AND b.spent_micros<=b.limit_micros AND b.reserved_micros<=b.limit_micros-b.spent_micros
 AND ? IS (SELECT CASE WHEN COUNT(DISTINCT alias.product_id)=1 THEN MIN(alias.product_id) END
  FROM message m JOIN product_sku alias ON alias.organization_id=m.organization_id AND alias.store_id=m.store_id AND alias.sku=m.sku
  WHERE m.id=json_extract(plan.value,'$.run.request.messageId') AND m.organization_id=e.organization_id AND m.store_id=e.store_id AND m.conversation_id=e.conversation_id)
 AND (EXISTS (SELECT 1 FROM ai_knowledge_evidence WHERE run_id=e.id AND chunks=? AND scope=? AND question_hash=?))
 AND NOT EXISTS (SELECT 1 FROM json_each(?,'$.chunks') wanted WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_chunk k JOIN knowledge_document d ON d.id=k.document_id AND d.organization_id=k.organization_id AND d.active_revision=k.revision
  JOIN knowledge_revision r ON r.document_id=k.document_id AND r.organization_id=k.organization_id AND r.revision=k.revision
  WHERE k.organization_id=e.organization_id AND k.document_id=json_extract(wanted.value,'$.documentId') AND k.revision=json_extract(wanted.value,'$.revision')
   AND k.id=json_extract(wanted.value,'$.chunkId') AND k.body_hash=json_extract(wanted.value,'$.bodyHash') AND k.body=json_extract(wanted.value,'$.body')
   AND r.title=json_extract(wanted.value,'$.title') AND r.content_hash=json_extract(wanted.value,'$.contentHash') AND ${textPublicationSQL('r')}
   AND (d.store_id IS NULL OR d.store_id=e.store_id) AND (d.product_ref IS NULL OR d.product_ref=?) AND d.language=?))`;
type Channel={platformStoreId:string;platformThreadId:string;credentialVersion:number};
async function authority(env:Bindings,read:AiRunReader,scope:ControlScope,id:string,mode:ReviewMode='live'){
 if(!enabled(env))return null;
 const db=env.DB!,execution=await readAiExecution(db,scope,id);
 if(!execution||execution.config.model.promptVersion!=='support-reply-v1')return null;
 if(mode==='live'?execution.closure!==null:execution.closure?.kind!=='runtime_closed'||execution.closure.outcome!=='completed'
  ||execution.status!=='settled'||execution.remainingReservedMicros!==0||!execution.receipt||!execution.generations.length
  ||execution.generations.some(g=>g.usage===null||g.chargedMicros===null||g.settledAt===null))return null;
 const run=v.parse(aiRunSchema,execution.payload.run);
 const saved=await readRunKnowledgeEvidence(db,id);if(!saved)return null;
 const evidence=v.parse(aiKnowledgeEvidenceSchema,{runId:id,scope:saved.scope,questionHash:saved.questionHash,chunks:JSON.parse(saved.raw)});
 if(!evidence.chunks.length||new Set(evidence.chunks.map(c=>c.chunkId)).size!==evidence.chunks.length||evidence.runId!==id||evidence.scope.storeId!==scope.storeId
  ||evidence.scope.language!==run.admission.language||JSON.stringify(evidence.scope)!==JSON.stringify(saved.scope)
  ||evidence.questionHash!==saved.questionHash||evidence.questionHash!==await knowledgeHash(run.admission.question))return null;
 const payloadHash=await knowledgeHash({payload:execution.payload,config:execution.config});
 const bound=[JSON.stringify(execution.payload),id,payloadHash,
  ...(mode==='completed'?[JSON.stringify(execution.closure),JSON.stringify(execution.receipt)]:[]),
  evidence.scope.productRef,saved.raw,JSON.stringify(evidence.scope),saved.questionHash,saved.raw,
  knowledgeTextProfile.id,evidence.scope.productRef,evidence.scope.language];
 const current=async()=>{
  if(!enabled(env)||Date.now()>=run.deadlineAt||JSON.stringify(await read({...scope},id))!==JSON.stringify(run))return null;
  return db.prepare(`SELECT s.platform_store_id AS platformStoreId,c.platform_thread_id AS platformThreadId,s.credential_version AS credentialVersion FROM ${from} WHERE ${eligible(mode)}`).bind(...bound).first<Channel>();
 };
 const channel=await current();if(!channel)return null;
 const resolved=await resolveTextKnowledgeCitations(db,scope.organizationId,evidence.scope,evidence.chunks);
 if(!resolved||resolved.some((chunk,i)=>JSON.stringify(chunk)!==JSON.stringify((({score,...source})=>source)(evidence.chunks[i]))))return null;
 if(JSON.stringify(await current())!==JSON.stringify(channel))return null;
 return {run,evidence,rawEvidence:saved.raw,payloadHash,bound,channel,current};
}
const row=(db:D1Database,id:string)=>db.prepare(`SELECT reply FROM ai_execution WHERE id=?`).bind(id).first<{reply:string|null}>();
/** Immutable preparation only. This module cannot grant dispatch or impersonate a merchant member. */
export async function prepareAiReply(env:Bindings,read:AiRunReader,scope:ControlScope,id:string,value:unknown){
 let attempted=false;
 try{
  scope=v.parse(aiScopeSchema,scope);const input=v.parse(aiAnswerInputSchema,structuredClone(value)),c=await authority(env,read,scope,id);
  if(!c||!input.citations.every(key=>c.evidence.chunks.some(chunk=>chunk.chunkId===key)))return result('unavailable');
  const bodyHash=await knowledgeHash(input.body),intentId='ai-reply:'+id;
  if(!enabled(env))return result('unavailable');attempted=true;
  const reply=JSON.stringify({id:intentId,body:input.body,bodyHash,citations:input.citations,knowledgeEvidence:JSON.parse(c.rawEvidence),
   platformStoreId:c.channel.platformStoreId,platformThreadId:c.channel.platformThreadId,credentialVersion:c.channel.credentialVersion});
  // Write the frozen reply onto the execution record itself. The reply column only records the
  // first write (reply IS NULL); every later read re-verifies authority via review(), so a stale
  // write from a commit-time race can never be dispatched.
  await env.DB!.prepare(`UPDATE ai_execution SET reply=? WHERE id=? AND payload_hash=? AND reply IS NULL`).bind(reply,id,c.payloadHash).run();
  const saved=await reviewAiReply(env,read,scope,id);if(!saved)return result('unavailable');
  return result(saved.body===input.body&&JSON.stringify(saved.citations)===JSON.stringify(input.citations)?'prepared':'conflict',saved.id);
 }catch{return result(attempted?'unconfirmed':'unavailable',attempted?'ai-reply:'+id:null);}
}
async function review(env:Bindings,read:AiRunReader,scope:ControlScope,id:string,mode:ReviewMode){
 try{
  scope=v.parse(aiScopeSchema,scope);const c=await authority(env,read,scope,id,mode);if(!c)return null;
  const savedRow=await row(env.DB!,id);if(!savedRow?.reply)return null;
  const saved:v.InferOutput<typeof aiAnswerInputSchema>&{id:string;bodyHash:string;knowledgeEvidence:unknown;platformStoreId:string;platformThreadId:string;credentialVersion:number}=JSON.parse(savedRow.reply);
  if(saved.id!=='ai-reply:'+id||saved.platformStoreId!==c.channel.platformStoreId||saved.platformThreadId!==c.channel.platformThreadId||saved.credentialVersion!==c.channel.credentialVersion)return null;
  const input=v.parse(aiAnswerInputSchema,{body:saved.body,citations:saved.citations});
  if(await knowledgeHash(input.body)!==saved.bodyHash||!input.citations.every(key=>c.evidence.chunks.some(chunk=>chunk.chunkId===key)))return null;
  if(JSON.stringify(await c.current())!==JSON.stringify(c.channel))return null;
  return {...input,id:saved.id,runId:id,run:c.run,origin:'ai' as const,actorUserId:null,actorMemberId:null,payloadHash:c.payloadHash,bodyHash:saved.bodyHash,
   knowledgeEvidence:c.evidence,platformStoreId:saved.platformStoreId,platformThreadId:saved.platformThreadId,credentialVersion:saved.credentialVersion,createdAt:0,canSend:false as const};
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
