import * as v from 'valibot';
import { nvidiaProvider } from '@earendil-works/pi-ai/providers/nvidia';
import type { ControlActor } from '../conversations/control-types.ts';
import { knowledgeAccess,knowledgeActorValues } from '../knowledge/storage.ts';
import { knowledgeHash } from '../knowledge/content.ts';
import { embedKnowledge,knowledgeProfile } from '../knowledge/vectorize.ts';
import { estimateTranslationReservation,freezeTranslationConfig } from '../translations/config.ts';
import type { TranslationConfig } from '../translations/types.ts';
import { REPLY_TEST_MODEL,validateReplyTestConfig } from './policy.ts';
import { currentReplyTestPayloadGuard } from './storage.ts';
import { assertCurrentReplyTest,replyTestModelInput,retrieveReplyTestKnowledge,type ReplyTestContext,type ReplyTestControlReader,type ReplyTestEvidence } from './service.ts';

const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const amount=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
export const replyTestQueryConfigSchema=v.strictObject({profile:v.literal(knowledgeProfile.id),priceVersion:id,
  // Conservative full-window allowance, not an estimate derived from character count or a free-tier promise.
  maxInputTokens:v.pipe(amount,v.minValue(60000),v.maxValue(1000000)),inputMicrosPerMillion:amount,dailyLimitMicros:amount,maxQueries:v.pipe(amount,v.minValue(1),v.maxValue(1000000))});
type QueryConfig=v.InferOutput<typeof replyTestQueryConfigSchema>;
type Payload={context:ReplyTestContext;answerConfig:TranslationConfig;queryConfig:QueryConfig};
export interface ReplyTestQuery {id:string;organizationId:string;storeId:string;conversationId:string;requestId:string;actorUserId:string;actorMemberId:string;budgetId:string;
  payload:Payload;payloadHash:string;reservedMicros:number;quotaDay:string;createdAt:number;attemptedAt:number|null;vectors:number[]|null;evidence:ReplyTestEvidence|null;errorCode:string|null}
type Row=Omit<ReplyTestQuery,'payload'|'vectors'|'evidence'>&{payload:string;vectors:string|null;evidence:string|null};
type Input={requestId:string;budgetId:string;context:ReplyTestContext;answerConfig:unknown;queryConfig:unknown};
type Admission={outcome:'admitted'|'existing';query:ReplyTestQuery}|{outcome:'not_found'|'conflict'|'pricing_unavailable'|'budget_unavailable'|'query_limit'};
export type ReplyTestQueryEnvironment={DB:D1Database;KNOWLEDGE_AI?:Ai;KNOWLEDGE_INDEX?:Vectorize;REPLY_TEST_ENABLED?:string};
export type QueryResult={outcome:'retrieved';query:ReplyTestQuery}|{outcome:'not_found'|'disabled'|'unconfirmed'|'index_unavailable'|'changed'|'unavailable'};
const now="CAST(unixepoch('subsecond')*1000 AS INTEGER)";
const columns=`q.id,q.organization_id AS organizationId,q.store_id AS storeId,q.conversation_id AS conversationId,q.request_id AS requestId,
  q.actor_user_id AS actorUserId,q.actor_member_id AS actorMemberId,q.budget_id AS budgetId,q.payload,q.payload_hash AS payloadHash,q.reserved_micros AS reservedMicros,
  q.quota_day AS quotaDay,q.created_at AS createdAt,q.attempted_at AS attemptedAt,q.vectors,q.evidence,q.error_code AS errorCode`;
const answerWindow=nvidiaProvider().getModels().find(model=>model.id===REPLY_TEST_MODEL)?.contextWindow;
export function replyTestPricing(answer:unknown,query:unknown){
  const answerConfig=freezeTranslationConfig(answer),queryConfig=v.parse(replyTestQueryConfigSchema,query);
  if(!answerWindow)throw new Error('REPLY_TEST_MODEL_UNAVAILABLE');validateReplyTestConfig(answerConfig,answerWindow);
  const ceiling=(BigInt(queryConfig.maxInputTokens)*BigInt(queryConfig.inputMicrosPerMillion)+999999n)/1000000n;
  if(ceiling>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('REPLY_TEST_QUERY_PRICE_OVERFLOW');
  return {answerConfig,queryConfig,reservedMicros:Number(ceiling)};
}
async function decode(row:Row):Promise<ReplyTestQuery>{
  const payload=JSON.parse(row.payload) as Payload,checked=replyTestPricing(payload.answerConfig,payload.queryConfig),c=payload.context;
  if(await knowledgeHash(payload)!==row.payloadHash||checked.reservedMicros!==row.reservedMicros||c.runId!==row.id||c.actor.orgId!==row.organizationId
    ||c.scope.storeId!==row.storeId||c.scope.conversationId!==row.conversationId||c.actor.actorUserId!==row.actorUserId||c.actor.memberId!==row.actorMemberId)throw new Error('REPLY_TEST_QUERY_INVALID');
  const vectors=row.vectors===null?null:JSON.parse(row.vectors);
  if(vectors!==null&&(!Array.isArray(vectors)||vectors.length!==1024||!vectors.every(x=>typeof x==='number'&&Number.isFinite(x))||!vectors.some(x=>x!==0)))throw new Error('REPLY_TEST_QUERY_INVALID');
  return {...row,payload,vectors,evidence:row.evidence===null?null:JSON.parse(row.evidence)};
}
function authorized(db:D1Database,actor:ControlActor,requestId:string,memberId:string){
  for(const value of [actor.orgId,actor.actorUserId,actor.sessionId,requestId,memberId])v.parse(id,value);
  return db.prepare(`SELECT ${columns} FROM reply_test_query q WHERE q.organization_id=? AND q.request_id=? AND q.actor_user_id=? AND q.actor_member_id=?
    AND EXISTS (${knowledgeAccess}) AND EXISTS (SELECT 1 FROM member WHERE id=q.actor_member_id AND organization_id=q.organization_id AND user_id=q.actor_user_id)`)
    .bind(actor.orgId,requestId,actor.actorUserId,memberId,...knowledgeActorValues(actor));
}
export async function readReplyTestQuery(db:D1Database,actor:ControlActor,requestId:string,memberId:string){
  const query=authorized(db,actor,requestId,memberId),row=await query.first<Row>();if(!row)return null;
  const result=await decode(row);return await query.first()?result:null;
}
async function replay(db:D1Database,actor:ControlActor,input:Input):Promise<Admission|null>{
  if(!await db.prepare('SELECT 1 FROM reply_test_query WHERE organization_id=? AND request_id=?').bind(actor.orgId,input.requestId).first())return null;
  const query=await readReplyTestQuery(db,actor,input.requestId,input.context.actor.memberId);if(!query)return {outcome:'not_found'};
  return query.budgetId===input.budgetId&&JSON.stringify(query.payload.context)===JSON.stringify(input.context)?{outcome:'existing',query}:{outcome:'conflict'};
}
const budgetGuard=`EXISTS (SELECT 1 FROM reply_test_budget b WHERE b.id=? AND b.organization_id=? AND b.enabled=1 AND b.starts_at<=${now} AND b.ends_at>${now}
  AND b.admitted_runs<b.max_runs AND b.limit_micros-b.spent_micros-b.reserved_micros>=?)`;
export async function admitReplyTestQuery(db:D1Database,control:ReplyTestControlReader,actor:ControlActor,input:Input):Promise<Admission>{
  actor={...actor};input=structuredClone(input);v.parse(v.pipe(id,v.uuid()),input.requestId);v.parse(id,input.budgetId);
  const previous=await replay(db,actor,input);if(previous)return previous;
  let checked:ReturnType<typeof replyTestPricing>;
  try{checked=replyTestPricing(input.answerConfig,input.queryConfig);}catch{return {outcome:'pricing_unavailable'};}
  await assertCurrentReplyTest(db,control,actor,input.context);
  const answerAmount=estimateTranslationReservation(checked.answerConfig),budgetValues=[input.budgetId,actor.orgId,answerAmount];
  if(!await db.prepare(`SELECT 1 WHERE ${budgetGuard}`).bind(...budgetValues).first())return {outcome:'budget_unavailable'};
  const payload:Payload={context:input.context,answerConfig:checked.answerConfig,queryConfig:checked.queryConfig},encoded=JSON.stringify(payload),hash=await knowledgeHash(payload);
  if(new TextEncoder().encode(encoded).length>98304)throw new RangeError('REPLY_TEST_INPUT_LIMIT');
  const c=input.context,token=crypto.randomUUID(),{reservedMicros,queryConfig}=checked;
  const rows=await db.batch([
    db.prepare(`INSERT INTO reply_test_query(id,organization_id,store_id,conversation_id,request_id,actor_user_id,actor_member_id,budget_id,payload,payload_hash,reserved_micros,quota_day,admission_token,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,date('now'),?,${now} WHERE NOT EXISTS (SELECT 1 FROM reply_test_query WHERE organization_id=? AND request_id=?)
      AND ${budgetGuard} AND EXISTS (${knowledgeAccess}) AND EXISTS (SELECT 1 FROM (SELECT ? AS value) p WHERE ${currentReplyTestPayloadGuard})
      AND COALESCE((SELECT queries FROM reply_test_query_usage WHERE day=date('now')),0)<?
      AND COALESCE((SELECT reserved_micros FROM reply_test_query_usage WHERE day=date('now')),0)<=?-? RETURNING id`)
      .bind(c.runId,actor.orgId,c.scope.storeId,c.scope.conversationId,input.requestId,actor.actorUserId,c.actor.memberId,input.budgetId,encoded,hash,reservedMicros,token,
        actor.orgId,input.requestId,...budgetValues,...knowledgeActorValues(actor),encoded,queryConfig.maxQueries,queryConfig.dailyLimitMicros,reservedMicros),
    db.prepare(`INSERT INTO reply_test_query_usage(day,reserved_micros,queries) SELECT quota_day,reserved_micros,1 FROM reply_test_query WHERE id=? AND organization_id=? AND admission_token=?
      ON CONFLICT(day) DO UPDATE SET reserved_micros=reserved_micros+excluded.reserved_micros,queries=queries+1`).bind(c.runId,actor.orgId,token),
  ]);
  const found=await replay(db,actor,input);
  return found?.outcome==='existing'&&rows[0].results.length===1?{outcome:'admitted',query:found.query}:found??{outcome:'query_limit'};
}
export async function claimReplyTestEmbedding(db:D1Database,control:ReplyTestControlReader,actor:ControlActor,requestId:string,memberId:string){
  const q=await readReplyTestQuery(db,actor,requestId,memberId);if(!q||q.attemptedAt!==null)return false;
  await assertCurrentReplyTest(db,control,actor,q.payload.context);
  return !!await db.prepare(`UPDATE reply_test_query AS q SET attempted_at=MAX(created_at,${now}) WHERE q.id=? AND q.organization_id=? AND attempted_at IS NULL AND quota_day=date('now')
    AND ${budgetGuard} AND EXISTS (${knowledgeAccess}) AND EXISTS (SELECT 1 FROM (SELECT q.payload AS value) p WHERE ${currentReplyTestPayloadGuard}) RETURNING id`)
    .bind(q.id,q.organizationId,q.budgetId,q.organizationId,estimateTranslationReservation(q.payload.answerConfig),...knowledgeActorValues(actor)).first();
}
export async function retrieveReplyTestQuery(env:ReplyTestQueryEnvironment,actor:ControlActor,requestId:string,memberId:string,control:ReplyTestControlReader):Promise<QueryResult>{
  const read=()=>readReplyTestQuery(env.DB,actor,requestId,memberId);
  let q=await read();if(!q)return {outcome:'not_found'};
  const services={db:env.DB,control,actor};
  try{
    await assertCurrentReplyTest(env.DB,control,actor,q.payload.context);
    if(q.evidence){await replyTestModelInput(q.payload.context,q.evidence,services);return {outcome:'retrieved',query:q};}
    if(!q.vectors){
      if(q.attemptedAt!==null)return {outcome:'unconfirmed'};
      if(env.REPLY_TEST_ENABLED!=='true'||!env.KNOWLEDGE_AI||!env.KNOWLEDGE_INDEX)return {outcome:'disabled'};
      if(!await claimReplyTestEmbedding(env.DB,control,actor,requestId,memberId))return {outcome:'unconfirmed'};
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        const vectors=await Promise.race([embedKnowledge(env.KNOWLEDGE_AI,[q.payload.context.question]),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('EMBEDDING_TIMEOUT')),20000);})]);
        await assertCurrentReplyTest(env.DB,control,actor,q.payload.context);
        await env.DB.prepare(`UPDATE reply_test_query AS q SET vectors=? WHERE id=? AND organization_id=? AND attempted_at IS NOT NULL AND vectors IS NULL AND error_code IS NULL
          AND EXISTS (${knowledgeAccess}) AND EXISTS (SELECT 1 FROM (SELECT q.payload AS value) p WHERE ${currentReplyTestPayloadGuard})`)
          .bind(JSON.stringify(vectors[0]),q.id,q.organizationId,...knowledgeActorValues(actor)).run();
      }catch{
        // A rejected observation does not prove that the provider made no charge. Never refund or retry here.
        await env.DB.prepare("UPDATE reply_test_query SET error_code='EMBEDDING_UNCONFIRMED' WHERE id=? AND organization_id=? AND attempted_at IS NOT NULL AND vectors IS NULL AND error_code IS NULL").bind(q.id,q.organizationId).run();
      }finally{clearTimeout(timer);}
      q=await read();if(!q)return {outcome:'not_found'};if(!q.vectors)return {outcome:'unconfirmed'};
    }
    if(!env.KNOWLEDGE_INDEX)return {outcome:'index_unavailable'};
    const evidence=await retrieveReplyTestKnowledge(env.DB,env.KNOWLEDGE_INDEX,control,actor,q.payload.context,{inputHash:q.payload.context.questionHash,profile:q.payload.queryConfig.profile,values:q.vectors});
    await env.DB.prepare(`UPDATE reply_test_query AS q SET evidence=? WHERE id=? AND organization_id=? AND vectors IS NOT NULL AND evidence IS NULL
      AND EXISTS (${knowledgeAccess}) AND EXISTS (SELECT 1 FROM (SELECT ? AS value) p WHERE ${currentReplyTestPayloadGuard})`)
      .bind(JSON.stringify(evidence),q.id,q.organizationId,...knowledgeActorValues(actor),JSON.stringify({context:q.payload.context,evidence})).run();
    const final=await read();if(!final)return {outcome:'not_found'};if(!final.evidence)return {outcome:'changed'};
    await replyTestModelInput(final.payload.context,final.evidence,services);return {outcome:'retrieved',query:final};
  }catch(error){
    if(error instanceof Error&&error.message.startsWith('REPLY_TEST_'))return {outcome:'changed'};
    return {outcome:'index_unavailable'};
  }
}
