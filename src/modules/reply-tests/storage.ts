import * as v from 'valibot';
import { knowledgeAccess,knowledgeActorValues } from '../knowledge/storage.ts';
import { knowledgeHash } from '../knowledge/content.ts';
import { replyTestModelInput,type ReplyTestContext,type ReplyTestEvidence,type ReplyTestControlReader } from './service.ts';
import type { ControlActor,ControlScope } from '../conversations/control-types.ts';
// Reuse the already-tested currency rounding and pricing validation. Financial rows remain specific to answer tests.
import { estimateTranslationReservation,estimateTranslationUsage,freezeTranslationConfig } from '../translations/config.ts';
import type { TranslationConfig,TranslationUsage,TranslationReceipt,UnstartedTranslationEvidence } from '../translations/types.ts';

const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(value=>value===value.trim()&&value.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(value)));
const count=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
const time=v.pipe(count,v.maxValue(8640000000000000));
const actorSchema=v.strictObject({orgId:id,actorUserId:id,sessionId:id,expectedMemberId:v.optional(id)});
const receiptSchema=v.strictObject({submissionId:id,uid:id,acceptedAt:v.pipe(v.string(),v.maxLength(40),v.isoTimestamp(),v.check(value=>Number.isFinite(Date.parse(value))&&Date.parse(value)>=0))});
const closureSchema=v.strictObject({kind:v.literal('execution_closed_without_provider_request'),evidenceId:id,instanceId:id,verifiedAt:time,providerRequests:v.literal(0),executionClosed:v.literal(true)});
const now="CAST(unixepoch('subsecond')*1000 AS INTEGER)";
export interface ReplyTestBudget {id:string;organizationId:string;startsAt:number;endsAt:number;enabled:boolean;revision:number;limitMicros:number;reservedMicros:number;spentMicros:number;maxRuns:number;admittedRuns:number}
type Payload={context:ReplyTestContext;evidence:ReplyTestEvidence;modelInput:Awaited<ReturnType<typeof replyTestModelInput>>};
export interface ReplyTestRun {
  id:string;organizationId:string;storeId:string;conversationId:string;requestId:string;actorUserId:string;actorMemberId:string;budgetId:string;
  payload:Payload;payloadHash:string;config:TranslationConfig;reservedMicros:number;createdAt:number;receipt:TranslationReceipt|null;providerRequestClaimedAt:number|null;
  settlement:'held'|'settled'|'released';usage:TranslationUsage|null;chargedMicros:number|null;settledAt:number|null;releaseEvidence:UnstartedTranslationEvidence|null;
}
export interface ReplyTestReservationInput {requestId:string;budgetId:string;context:ReplyTestContext;evidence:ReplyTestEvidence}
export type ReplyTestReservation={outcome:'reserved'|'existing';run:ReplyTestRun}|{outcome:'not_found'|'conflict'|'budget_unavailable'|'pricing_unavailable'};
export const budgetColumns='id,organization_id AS organizationId,starts_at AS startsAt,ends_at AS endsAt,enabled,revision,limit_micros AS limitMicros,reserved_micros AS reservedMicros,spent_micros AS spentMicros,max_runs AS maxRuns,admitted_runs AS admittedRuns';
const runColumns=`run.id,run.organization_id AS organizationId,run.store_id AS storeId,run.conversation_id AS conversationId,run.request_id AS requestId,
  run.actor_user_id AS actorUserId,run.actor_member_id AS actorMemberId,run.budget_id AS budgetId,run.payload,run.payload_hash AS payloadHash,run.config,
  run.reserved_micros AS reservedMicros,run.created_at AS createdAt,run.receipt,run.provider_request_claimed_at AS providerRequestClaimedAt,run.settlement,run.usage,
  run.charged_micros AS chargedMicros,run.settled_at AS settledAt,run.release_evidence AS releaseEvidence`;
type BudgetRow=Omit<ReplyTestBudget,'enabled'>&{enabled:number};
type RunRow=Omit<ReplyTestRun,'payload'|'config'|'receipt'|'usage'|'releaseEvidence'>&{payload:string;config:string;receipt:string|null;usage:string|null;releaseEvidence:string|null};
const budget=(row:BudgetRow|null):ReplyTestBudget|null=>row?{...row,enabled:row.enabled===1}:null;
function actorValues(actor:ControlActor){v.parse(actorSchema,actor);return knowledgeActorValues(actor);}
async function decode(row:RunRow):Promise<ReplyTestRun>{
  const payload=JSON.parse(row.payload) as Payload,config=freezeTranslationConfig(JSON.parse(row.config)),context=payload.context;
  if(await knowledgeHash(payload)!==row.payloadHash||estimateTranslationReservation(config)!==row.reservedMicros||context.runId!==row.id
    ||context.scope.organizationId!==row.organizationId||context.scope.storeId!==row.storeId||context.scope.conversationId!==row.conversationId
    ||context.actor.actorUserId!==row.actorUserId||context.actor.memberId!==row.actorMemberId)throw new Error('REPLY_TEST_RUN_INVALID');
  return {...row,payload,config,receipt:row.receipt===null?null:v.parse(receiptSchema,JSON.parse(row.receipt)),usage:row.usage===null?null:JSON.parse(row.usage),releaseEvidence:row.releaseEvidence===null?null:v.parse(closureSchema,JSON.parse(row.releaseEvidence))};
}
const runWhere='run.id=? AND run.organization_id=? AND run.store_id=? AND run.conversation_id=? AND json_extract(run.payload,\'$.context.scope.controllerId\')=?';
function scopeValues(scope:ControlScope,runId:string){
  for(const value of [runId,scope.organizationId,scope.storeId,scope.conversationId,scope.controllerId])v.parse(id,value);
  return [runId,scope.organizationId,scope.storeId,scope.conversationId,scope.controllerId];
}
async function internalRead(db:D1Database,scope:ControlScope,runId:string){
  const row=await db.prepare(`SELECT ${runColumns} FROM reply_test_run AS run WHERE ${runWhere}`).bind(...scopeValues(scope,runId)).first<RunRow>();
  return row?decode(row):null;
}
async function required(db:D1Database,scope:ControlScope,runId:string){const run=await internalRead(db,scope,runId);if(!run)throw new Error('REPLY_TEST_RUN_NOT_FOUND');return run;}
function authorizedRead(db:D1Database,actor:ControlActor,requestId:string,memberId:string){
  v.parse(id,requestId);v.parse(id,memberId);
  return db.prepare(`SELECT ${runColumns} FROM reply_test_run AS run WHERE run.organization_id=? AND run.request_id=? AND run.actor_user_id=? AND run.actor_member_id=?
    AND EXISTS (${knowledgeAccess}) AND EXISTS (SELECT 1 FROM member WHERE id=run.actor_member_id AND organization_id=run.organization_id AND user_id=run.actor_user_id)`)
    .bind(actor.orgId,requestId,actor.actorUserId,memberId,...actorValues(actor));
}
export async function readReplyTestRun(db:D1Database,actor:ControlActor,requestId:string,memberId:string){
  const query=authorizedRead(db,actor,requestId,memberId),row=await query.first<RunRow>();if(!row)return null;
  const value=await decode(row);return await query.first()?value:null;
}
export async function createReplyTestBudget(db:D1Database,actor:ControlActor,input:{id:string;startsAt:number;endsAt:number;limitMicros:number;maxRuns:number}){
  v.parse(v.strictObject({id,startsAt:time,endsAt:time,limitMicros:count,maxRuns:v.pipe(count,v.minValue(1),v.maxValue(1000000))}),input);
  if(input.endsAt<=input.startsAt)throw new RangeError('INVALID_REPLY_TEST_BUDGET');
  return budget(await db.prepare(`INSERT INTO reply_test_budget(id,organization_id,starts_at,ends_at,limit_micros,max_runs)
    SELECT ?,?,?,?,?,? WHERE EXISTS (${knowledgeAccess}) RETURNING ${budgetColumns}`)
    .bind(input.id,actor.orgId,input.startsAt,input.endsAt,input.limitMicros,input.maxRuns,...actorValues(actor)).first<BudgetRow>());
}
export async function readReplyTestBudget(db:D1Database,actor:ControlActor,budgetId:string){
  v.parse(id,budgetId);return budget(await db.prepare(`SELECT ${budgetColumns} FROM reply_test_budget WHERE organization_id=? AND id=? AND EXISTS (${knowledgeAccess})`)
    .bind(actor.orgId,budgetId,...actorValues(actor)).first<BudgetRow>());
}
export async function setReplyTestBudgetEnabled(db:D1Database,actor:ControlActor,budgetId:string,revision:number,enabled:boolean){
  v.parse(id,budgetId);v.parse(v.pipe(count,v.maxValue(Number.MAX_SAFE_INTEGER-1)),revision);v.parse(v.boolean(),enabled);
  return budget(await db.prepare(`UPDATE reply_test_budget SET enabled=?,revision=revision+1 WHERE organization_id=? AND id=? AND revision=? AND EXISTS (${knowledgeAccess}) RETURNING ${budgetColumns}`)
    .bind(Number(enabled),actor.orgId,budgetId,revision,...actorValues(actor)).first<BudgetRow>());
}
// D1 parts of the frozen context are checked again in the same transaction as admission/permission.
// DO authority is checked by replyTestModelInput; result review still rejects any later takeover.
export const currentReplyTestPayloadGuard=`EXISTS (SELECT 1 FROM conversation JOIN member actor ON actor.organization_id=conversation.organization_id
    JOIN user caller ON caller.id=actor.user_id JOIN session login ON login.user_id=caller.id
    JOIN reply_policy policy ON policy.organization_id=conversation.organization_id
    WHERE conversation.organization_id=json_extract(p.value,'$.context.scope.organizationId') AND conversation.store_id=json_extract(p.value,'$.context.scope.storeId')
      AND conversation.id=json_extract(p.value,'$.context.scope.conversationId') AND conversation.message_sequence=json_extract(p.value,'$.context.inputRevision')
      AND actor.id=json_extract(p.value,'$.context.actor.memberId') AND actor.user_id=json_extract(p.value,'$.context.actor.actorUserId')
      AND actor.role IN ('owner','admin') AND caller.email_verified=1 AND login.id=json_extract(p.value,'$.context.actor.sessionId') AND login.expires_at>${now}
      AND policy.id=json_extract(p.value,'$.context.policy.id') AND policy.enabled=1 AND policy.published_revision=json_extract(p.value,'$.context.policy.revision'))
  AND NOT EXISTS (SELECT 1 FROM json_each(p.value,'$.evidence.chunks') wanted WHERE NOT EXISTS (
    SELECT 1 FROM knowledge_document doc JOIN knowledge_chunk chunk ON chunk.organization_id=doc.organization_id AND chunk.document_id=doc.id AND chunk.revision=doc.active_revision
    WHERE doc.organization_id=json_extract(p.value,'$.context.scope.organizationId') AND doc.id=json_extract(wanted.value,'$.documentId')
      AND doc.active_revision=json_extract(wanted.value,'$.revision') AND chunk.id=json_extract(wanted.value,'$.chunkId') AND chunk.body_hash=json_extract(wanted.value,'$.bodyHash')))`;
async function replay(db:D1Database,actor:ControlActor,input:ReplyTestReservationInput):Promise<ReplyTestReservation|null>{
  const row=await db.prepare('SELECT id FROM reply_test_run WHERE organization_id=? AND request_id=?').bind(actor.orgId,input.requestId).first();
  if(!row)return null;
  const saved=await readReplyTestRun(db,actor,input.requestId,input.context.actor.memberId);if(!saved)return {outcome:'not_found'};
  return saved.budgetId===input.budgetId&&JSON.stringify(saved.payload.context)===JSON.stringify(input.context)&&JSON.stringify(saved.payload.evidence)===JSON.stringify(input.evidence)
    ?{outcome:'existing',run:saved}:{outcome:'conflict'};
}
export async function reserveReplyTest(db:D1Database,control:ReplyTestControlReader,actor:ControlActor,input:ReplyTestReservationInput,currentConfig:unknown):Promise<ReplyTestReservation>{
  actor=v.parse(actorSchema,actor);input=structuredClone(input);v.parse(id,input.requestId);v.parse(id,input.budgetId);
  const previous=await replay(db,actor,input);if(previous)return previous;
  let config:TranslationConfig,reserved:number;
  try{config=freezeTranslationConfig(currentConfig);reserved=estimateTranslationReservation(config);}catch(error){if(error instanceof RangeError)return {outcome:'pricing_unavailable'};throw error;}
  const payload:Payload={context:input.context,evidence:input.evidence,modelInput:await replyTestModelInput(input.context,input.evidence,{db,control,actor})};
  const encoded=JSON.stringify(payload);if(new TextEncoder().encode(encoded).length>98304)throw new RangeError('REPLY_TEST_INPUT_LIMIT');
  const hash=await knowledgeHash(payload),c=input.context,token=crypto.randomUUID(),marker=[input.budgetId,actor.orgId,token];
  const results=await db.batch([
    db.prepare(`UPDATE reply_test_budget SET reserved_micros=reserved_micros+?,admitted_runs=admitted_runs+1,commit_token=?
      WHERE id=? AND organization_id=? AND enabled=1 AND starts_at<=${now} AND ends_at>${now} AND admitted_runs<max_runs
        AND reserved_micros<=9007199254740991-? AND limit_micros-spent_micros-reserved_micros>=?
        AND NOT EXISTS (SELECT 1 FROM reply_test_run WHERE organization_id=? AND request_id=?)
        AND EXISTS (SELECT 1 FROM (SELECT ? AS value) p WHERE ${currentReplyTestPayloadGuard}) RETURNING id`)
      .bind(reserved,token,input.budgetId,actor.orgId,reserved,reserved,actor.orgId,input.requestId,encoded),
    db.prepare(`INSERT INTO reply_test_run(id,organization_id,store_id,conversation_id,request_id,actor_user_id,actor_member_id,budget_id,payload,payload_hash,config,reserved_micros,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,${now} WHERE EXISTS (SELECT 1 FROM reply_test_budget WHERE id=? AND organization_id=? AND commit_token=?)`)
      .bind(c.runId,actor.orgId,c.scope.storeId,c.scope.conversationId,input.requestId,actor.actorUserId,c.actor.memberId,input.budgetId,encoded,hash,JSON.stringify(config),reserved,...marker),
    db.prepare('UPDATE reply_test_budget SET commit_token=NULL WHERE id=? AND organization_id=? AND commit_token=?').bind(...marker),
  ]);
  const found=await replay(db,actor,input);
  return found?.outcome==='existing'&&results[0].results.length===1?{outcome:'reserved',run:found.run}:found??{outcome:'budget_unavailable'};
}
function receiptText(receipt:TranslationReceipt){return JSON.stringify(v.parse(receiptSchema,receipt));}
export async function bindReplyTestReceipt(db:D1Database,scope:ControlScope,runId:string,receipt:TranslationReceipt){
  const encoded=receiptText(receipt);await db.prepare(`UPDATE reply_test_run AS run SET receipt=? WHERE ${runWhere} AND settlement='held' AND receipt IS NULL`).bind(encoded,...scopeValues(scope,runId)).run();
  const run=await required(db,scope,runId);if(run.settlement==='released')throw new Error('REPLY_TEST_SETTLEMENT_CONFLICT');
  if(JSON.stringify(run.receipt)!==encoded)throw new Error('REPLY_TEST_RECEIPT_CONFLICT');
}
export async function readReplyTestExecutionContext(db:D1Database,control:ReplyTestControlReader,scope:ControlScope,runId:string){
  const run=await internalRead(db,scope,runId);if(!run||run.settlement!=='held')return null;
  const allowed=await db.prepare(`SELECT 1 FROM reply_test_budget WHERE id=? AND organization_id=? AND enabled=1
    AND reserved_micros>=? AND spent_micros<=limit_micros-reserved_micros`).bind(run.budgetId,run.organizationId,run.reservedMicros).first();
  if(!allowed)return null;
  try{
    const {context,evidence}=run.payload;
    const modelInput=await replyTestModelInput(context,evidence,{db,control,actor:{orgId:run.organizationId,actorUserId:run.actorUserId,sessionId:context.actor.sessionId,expectedMemberId:run.actorMemberId}});
    return JSON.stringify(modelInput)===JSON.stringify(run.payload.modelInput)?run:null;
  }catch(error){if(error instanceof Error&&error.message.startsWith('REPLY_TEST_'))return null;throw error;}
}
export async function claimReplyTestProviderRequest(db:D1Database,control:ReplyTestControlReader,scope:ControlScope,runId:string){
  const run=await readReplyTestExecutionContext(db,control,scope,runId);if(!run||run.providerRequestClaimedAt!==null)return false;
  return !!await db.prepare(`UPDATE reply_test_run AS run SET provider_request_claimed_at=MAX(created_at,${now})
    WHERE ${runWhere} AND settlement='held' AND provider_request_claimed_at IS NULL
      AND EXISTS (SELECT 1 FROM reply_test_budget budget WHERE budget.id=run.budget_id AND budget.organization_id=run.organization_id AND budget.enabled=1
        AND budget.reserved_micros>=run.reserved_micros AND budget.spent_micros<=budget.limit_micros-budget.reserved_micros)
      AND EXISTS (SELECT 1 FROM (SELECT run.payload AS value) p WHERE ${currentReplyTestPayloadGuard}) RETURNING id`)
    .bind(...scopeValues(scope,runId)).first();
}
async function finish(db:D1Database,scope:ControlScope,run:ReplyTestRun,settlement:'settled'|'released',charged:number,usage:string|null,evidence:string|null,receipt:string|null){
  const token=crypto.randomUUID(),bound=scopeValues(scope,run.id),marker=[run.budgetId,run.organizationId,token];
  await db.batch([
    db.prepare(`UPDATE reply_test_budget SET reserved_micros=reserved_micros-?,spent_micros=spent_micros+?,commit_token=?
      WHERE id=? AND organization_id=? AND reserved_micros>=? AND spent_micros<=9007199254740991-?
        AND EXISTS (SELECT 1 FROM reply_test_run AS run WHERE ${runWhere} AND settlement='held'
          ${settlement==='settled'?'AND provider_request_claimed_at IS NOT NULL AND receipt=?':'AND provider_request_claimed_at IS NULL'})`)
      .bind(run.reservedMicros,charged,token,run.budgetId,run.organizationId,run.reservedMicros,charged,...bound,...(settlement==='settled'?[receipt]:[])),
    db.prepare(`UPDATE reply_test_run AS run SET settlement=?,usage=?,charged_micros=?,settled_at=MAX(created_at,${now}),release_evidence=?
      WHERE ${runWhere} AND settlement='held' AND EXISTS (SELECT 1 FROM reply_test_budget WHERE id=? AND organization_id=? AND commit_token=?)`)
      .bind(settlement,usage,charged,evidence,...bound,...marker),
    db.prepare('UPDATE reply_test_budget SET commit_token=NULL WHERE id=? AND organization_id=? AND commit_token=?').bind(...marker),
  ]);
  const final=await required(db,scope,run.id);
  if(final.settlement!==settlement||final.chargedMicros!==charged||JSON.stringify(final.usage)!==(usage??'null')||JSON.stringify(final.releaseEvidence)!==(evidence??'null'))throw new Error('REPLY_TEST_SETTLEMENT_CONFLICT');
  if(settlement==='settled'&&JSON.stringify(final.receipt)!==receipt)throw new Error('REPLY_TEST_RECEIPT_CONFLICT');
}
export async function settleReplyTestUsage(db:D1Database,scope:ControlScope,runId:string,receipt:TranslationReceipt,usage:TranslationUsage){
  const encoded=receiptText(receipt),run=await required(db,scope,runId);
  if(JSON.stringify(run.receipt)!==encoded)throw new Error('REPLY_TEST_RECEIPT_CONFLICT');
  const charged=estimateTranslationUsage(run.config,usage),value=JSON.stringify({input:usage.input,output:usage.output,cacheRead:usage.cacheRead,cacheWrite:usage.cacheWrite});
  await finish(db,scope,run,'settled',charged,value,null,encoded);
}
export async function releaseUnstartedReplyTest(db:D1Database,scope:ControlScope,runId:string,evidence:UnstartedTranslationEvidence){
  const proof=v.parse(closureSchema,evidence),run=await required(db,scope,runId);
  if(proof.instanceId!==`reply-test:${run.id}`||proof.verifiedAt<run.createdAt||proof.verifiedAt>Date.now())throw new RangeError('INVALID_REPLY_TEST_CLOSURE');
  // Internal only: a closed provider ledger must supply this proof. Timeouts and absent receipts are insufficient.
  await finish(db,scope,run,'released',0,null,JSON.stringify(proof),null);
}
