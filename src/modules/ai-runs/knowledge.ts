import * as v from 'valibot';
import {aiRunSchema,aiScopeSchema} from '../conversations/ai-state.ts';
import type {ControlScope} from '../conversations/control-types.ts';
import {currentPayload,readAiExecution,type AiRunReader} from './storage.ts';
import {knowledgeHash} from '../knowledge/content.ts';
import {embedKnowledge,knowledgeProfile} from '../knowledge/vectorize.ts';
import {retrievePublishedKnowledge,retrievalScopeSchema,retrievalDocumentLimit,type RetrievalScope,type ResolvedKnowledge} from '../knowledge/retrieval.ts';
import {knowledgeCitationSchema,type KnowledgeCitationRequest} from '../../shared/knowledge.ts';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const amount=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
const hash=v.pipe(v.string(),v.regex(/^[0-9a-f]{64}$/));
export const aiKnowledgeQueryConfigSchema=v.strictObject({profile:v.literal(knowledgeProfile.id),priceVersion:id,
 maxInputTokens:v.pipe(amount,v.minValue(60000),v.maxValue(1000000)),inputMicrosPerMillion:amount});
export const aiKnowledgeChunkSchema=v.strictObject({...knowledgeCitationSchema.entries,body:v.pipe(v.string(),v.maxLength(8192)),title:v.pipe(v.string(),v.maxLength(160)),contentHash:hash,score:v.pipe(v.number(),v.finite())});
export const aiKnowledgeEvidenceSchema=v.strictObject({runId:v.pipe(v.string(),v.uuid()),scope:retrievalScopeSchema,questionHash:hash,chunks:v.pipe(v.array(aiKnowledgeChunkSchema),v.maxLength(10))});
export type AiKnowledgeEvidence=v.InferOutput<typeof aiKnowledgeEvidenceSchema>;
export type AiKnowledgeBindings={DB?:D1Database;AI_RECEPTION_ENABLED?:string;AI_OUTBOUND_ENABLED?:string;OUTBOUND_ENABLED?:string;AI_KNOWLEDGE_QUERY_CONFIG_JSON?:string;KNOWLEDGE_AI?:Ai;KNOWLEDGE_INDEX?:Vectorize};
type QueryRow={config:string;scope:string;questionHash:string;reservedMicros:number;vectors:string|null;evidence:string|null};
const now="CAST(unixepoch('subsecond')*1000 AS INTEGER)";
function fail():never{throw new Error('AI_KNOWLEDGE_UNAVAILABLE');}
function freezePrice(value:unknown){
 const config=v.parse(aiKnowledgeQueryConfigSchema,value),cost=(BigInt(config.maxInputTokens)*BigInt(config.inputMicrosPerMillion)+999999n)/1000000n;
 if(cost>BigInt(Number.MAX_SAFE_INTEGER))fail();return {config,cost:Number(cost)};
}
async function queryRow(db:D1Database,id:string){return db.prepare('SELECT config,scope,question_hash AS questionHash,reserved_micros AS reservedMicros,vectors,evidence FROM ai_knowledge_query WHERE run_id=?').bind(id).first<QueryRow>();}
async function context(env:AiKnowledgeBindings,read:AiRunReader,scope:ControlScope,runId:string){
 if(env.AI_RECEPTION_ENABLED!=='true'||!env.DB)fail();v.parse(aiScopeSchema,scope);v.parse(v.pipe(v.string(),v.uuid()),runId);
 const execution=await readAiExecution(env.DB,scope,runId);if(!execution||execution.closure||!['support-knowledge-v1','support-answer-v1','support-reply-v1'].includes(execution.config.model.promptVersion))fail();
 const enabled=()=>env.AI_RECEPTION_ENABLED==='true'&&(execution.config.model.promptVersion!=='support-reply-v1'||env.AI_OUTBOUND_ENABLED==='true'&&env.OUTBOUND_ENABLED==='true');
 const run=v.parse(aiRunSchema,execution.payload.run);
 const live=async()=>{
  if(!enabled()||Date.now()>=run.deadlineAt)fail();
  const current=await read({...scope},runId);if(JSON.stringify(current)!==JSON.stringify(run))fail();
  if(!await env.DB!.prepare(`SELECT 1 FROM ai_execution e JOIN (SELECT ? AS value) plan WHERE e.id=? AND e.closure IS NULL AND ${currentPayload}`).bind(JSON.stringify(execution.payload),runId).first())fail();
 };
 const source=async()=>{
  await live();
  const products=(await env.DB!.prepare(`SELECT DISTINCT alias.product_id AS id FROM message m JOIN product_sku alias ON alias.organization_id=m.organization_id AND alias.store_id=m.store_id AND alias.sku=m.sku
   WHERE m.id=? AND m.organization_id=? AND m.store_id=? AND m.conversation_id=? ORDER BY alias.product_id LIMIT 2`)
   .bind(run.request.messageId,scope.organizationId,scope.storeId,scope.conversationId).all<{id:string}>()).results;
  return v.parse(retrievalScopeSchema,{storeId:scope.storeId,productRef:products.length===1?products[0].id:null,language:run.admission.language});
 };
 const knowledgeScope=await source(),questionHash=await knowledgeHash(run.admission.question);
 const current=async()=>{if(JSON.stringify(await source())!==JSON.stringify(knowledgeScope))fail();};
 await current();return {execution,run,knowledgeScope,questionHash,current,enabled};
}
async function resolve(db:D1Database,orgId:string,scope:RetrievalScope,citations:KnowledgeCitationRequest['citations']){
 const query=db.prepare(`SELECT c.document_id AS documentId,c.revision,c.id AS chunkId,c.body_hash AS bodyHash,c.body,r.title,r.content_hash AS contentHash
  FROM json_each(?) wanted JOIN knowledge_chunk c ON c.organization_id=? AND c.id=json_extract(wanted.value,'$.chunkId')
   AND c.document_id=json_extract(wanted.value,'$.documentId') AND c.revision=json_extract(wanted.value,'$.revision') AND c.body_hash=json_extract(wanted.value,'$.bodyHash')
  JOIN knowledge_document d ON d.organization_id=c.organization_id AND d.id=c.document_id AND d.active_revision=c.revision
  JOIN knowledge_revision r ON r.organization_id=c.organization_id AND r.document_id=c.document_id AND r.revision=c.revision
  WHERE (d.store_id IS NULL OR d.store_id=?) AND (d.product_ref IS NULL OR d.product_ref=?) AND d.language=? AND r.index_profile=? AND r.published_profile=? ORDER BY CAST(wanted.key AS INTEGER)`)
  .bind(JSON.stringify(citations),orgId,scope.storeId,scope.productRef,scope.language,knowledgeProfile.id,knowledgeProfile.id);
 const first=(await query.all<ResolvedKnowledge>()).results;if(first.length!==citations.length)return null;
 for(const chunk of first)if(await knowledgeHash(chunk.body)!==chunk.bodyHash)return null;
 const confirmed=(await query.all<ResolvedKnowledge>()).results;return JSON.stringify(confirmed)===JSON.stringify(first)?confirmed:null;
}
export {resolve as resolvePublishedAiKnowledge};
async function validateEvidence(db:D1Database,c:Awaited<ReturnType<typeof context>>,value:unknown){
 const evidence=v.parse(aiKnowledgeEvidenceSchema,value);await c.current();
 if(evidence.runId!==c.run.request.runId||evidence.questionHash!==c.questionHash||JSON.stringify(evidence.scope)!==JSON.stringify(c.knowledgeScope))fail();
 const resolved=await resolve(db,c.run.scope.organizationId,c.knowledgeScope,evidence.chunks);if(!resolved||resolved.some((row,i)=>JSON.stringify(row)!==JSON.stringify((({score,...chunk})=>chunk)(evidence.chunks[i]))))return null;
 await c.current();return evidence;
}
/** Final reply submission must revalidate this persisted evidence; similarity is not proof that the text answers the question. */
export async function reviewAiKnowledgeEvidence(env:AiKnowledgeBindings,read:AiRunReader,scope:ControlScope,runId:string,value:unknown){
 try{const c=await context(env,read,scope,runId),row=await queryRow(env.DB!,runId);if(!row?.evidence||JSON.stringify(v.parse(aiKnowledgeEvidenceSchema,value))!==JSON.stringify(v.parse(aiKnowledgeEvidenceSchema,JSON.parse(row.evidence))))return null;return await validateEvidence(env.DB!,c,value);}catch{return null;}
}
export async function searchAiKnowledge(env:AiKnowledgeBindings,read:AiRunReader,scope:ControlScope,runId:string){
 const result=(status:'unavailable'|'unconfirmed'|'changed')=>({status,canSend:false as const,evidence:null});
 try{
  scope=v.parse(aiScopeSchema,scope);const c=await context(env,read,scope,runId),db=env.DB!;let row=await queryRow(db,runId);
  if(!row){
   if(!env.KNOWLEDGE_AI||!env.KNOWLEDGE_INDEX||!env.AI_KNOWLEDGE_QUERY_CONFIG_JSON||env.AI_KNOWLEDGE_QUERY_CONFIG_JSON.length>4096||new TextEncoder().encode(c.run.admission.question).length>2400)return result('unavailable');
   const price=freezePrice(JSON.parse(env.AI_KNOWLEDGE_QUERY_CONFIG_JSON)),token=crypto.randomUUID(),marker=[c.execution.budgetId,scope.organizationId,token];await c.current();
   const grant=await db.batch([
    db.prepare(`UPDATE ai_budget SET reserved_micros=reserved_micros+?,commit_token=? WHERE id=? AND organization_id=? AND enabled=1 AND starts_at<=${now} AND ends_at>${now}
     AND reserved_micros<=9007199254740991-? AND limit_micros-spent_micros-reserved_micros>=? AND NOT EXISTS(SELECT 1 FROM ai_knowledge_query WHERE run_id=?)
     AND EXISTS(SELECT 1 FROM ai_execution e JOIN (SELECT ? AS value) plan WHERE e.id=? AND e.budget_id=ai_budget.id AND e.organization_id=ai_budget.organization_id AND e.closure IS NULL AND ${currentPayload}) RETURNING id`)
     .bind(price.cost,token,c.execution.budgetId,scope.organizationId,price.cost,price.cost,runId,JSON.stringify(c.execution.payload),runId),
    db.prepare(`INSERT INTO ai_knowledge_query(run_id,config,scope,question_hash,reserved_micros,created_at) SELECT ?,?,?,?,?,${now} WHERE EXISTS(SELECT 1 FROM ai_budget WHERE id=? AND organization_id=? AND commit_token=?)`)
     .bind(runId,JSON.stringify(price.config),JSON.stringify(c.knowledgeScope),c.questionHash,price.cost,...marker),
    db.prepare('UPDATE ai_budget SET commit_token=NULL WHERE id=? AND organization_id=? AND commit_token=?').bind(...marker),
   ]);
   row=await queryRow(db,runId);if(!row)return result('unavailable');
   if(grant[0].results.length){
    // The row is the one-way provider permit. A lost response keeps its allowance reserved and never grants a second request.
    try{
     await c.current();const allowed=await db.prepare(`SELECT 1 FROM ai_execution e JOIN ai_budget b ON b.id=e.budget_id AND b.organization_id=e.organization_id JOIN (SELECT ? AS value) plan
      WHERE e.id=? AND e.closure IS NULL AND b.enabled=1 AND b.starts_at<=${now} AND b.ends_at>${now} AND b.limit_micros-b.spent_micros-b.reserved_micros>=0 AND ${currentPayload}`)
      .bind(JSON.stringify(c.execution.payload),runId).first();
     if(!allowed||!c.enabled())return result('unavailable');
     const [vector]=await embedKnowledge(env.KNOWLEDGE_AI,[c.run.admission.question]);await db.prepare('UPDATE ai_knowledge_query SET vectors=? WHERE run_id=? AND vectors IS NULL').bind(JSON.stringify(vector),runId).run();
    }
    catch{return result('unconfirmed');}
    row=await queryRow(db,runId);if(!row)return result('unconfirmed');
   }
  }
  const price=freezePrice(JSON.parse(row.config));if(row.reservedMicros!==price.cost||row.questionHash!==c.questionHash||JSON.stringify(v.parse(retrievalScopeSchema,JSON.parse(row.scope)))!==JSON.stringify(c.knowledgeScope))return result('changed');
  if(row.evidence){const evidence=await validateEvidence(db,c,JSON.parse(row.evidence));return evidence?{status:evidence.chunks.length?'found' as const:'empty' as const,canSend:false as const,evidence}:result('changed');}
  if(!row.vectors)return result('unconfirmed');if(!env.KNOWLEDGE_INDEX)return result('unavailable');
  const chunks=await retrievePublishedKnowledge(env.KNOWLEDGE_INDEX,scope.organizationId,c.knowledgeScope,JSON.parse(row.vectors),{
   snapshot:async()=>{
    await c.current();const revisions=(await db.prepare(`SELECT d.id AS documentId,d.version AS documentVersion,r.revision,r.content_hash AS contentHash,r.index_profile AS profile,r.published_profile AS publishedProfile
     FROM knowledge_document d JOIN knowledge_revision r ON r.organization_id=d.organization_id AND r.document_id=d.id AND r.revision=d.active_revision
     WHERE d.organization_id=? AND (d.store_id IS NULL OR d.store_id=?) AND (d.product_ref IS NULL OR d.product_ref=?) AND d.language=? ORDER BY d.id LIMIT ?`)
     .bind(scope.organizationId,c.knowledgeScope.storeId,c.knowledgeScope.productRef,c.knowledgeScope.language,retrievalDocumentLimit+1).all<{documentId:string;documentVersion:number;revision:number;contentHash:string;profile:string;publishedProfile:string}>()).results;
    if(revisions.length>retrievalDocumentLimit||revisions.some(r=>r.profile!==knowledgeProfile.id||r.publishedProfile!==knowledgeProfile.id))fail();
    return {authority:JSON.stringify([c.run.controlEpoch,c.knowledgeScope]),revisions:revisions.map(({profile,publishedProfile,...r})=>r)};
   },resolve:citations=>resolve(db,scope.organizationId,c.knowledgeScope,citations),
  });
  const evidence=v.parse(aiKnowledgeEvidenceSchema,{runId,scope:c.knowledgeScope,questionHash:c.questionHash,chunks});await c.current();
  await db.prepare('UPDATE ai_knowledge_query SET evidence=? WHERE run_id=? AND evidence IS NULL').bind(JSON.stringify(evidence),runId).run();
  row=await queryRow(db,runId);const confirmed=row?.evidence?await validateEvidence(db,c,JSON.parse(row.evidence)):null;
  return confirmed?{status:confirmed.chunks.length?'found' as const:'empty' as const,canSend:false as const,evidence:confirmed}:result('changed');
 }catch{return result('unavailable');}
}
