import * as v from 'valibot';
import { storeAccess } from '../stores/storage.ts';
import { replyBodySchema } from '../conversations/control-state.ts';
import { estimateTranslationReservation,estimateTranslationUsage,freezeTranslationConfig } from './config.ts';
import type { TranslationActor,TranslationBudget,TranslationConfig,TranslationInput,TranslationOutput,TranslationReceipt,TranslationReservation,TranslationRun,TranslationScope,TranslationUsage,UnstartedTranslationEvidence } from './types.ts';
import type { TranslationDeploymentEnv } from './deployment-config.ts';

const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(value=>value.trim()===value&&value.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(value)));
const counter=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
const time=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(8_640_000_000_000_000));
const actorSchema=v.strictObject({orgId:id,actorUserId:id,sessionId:id});
const querySchema=v.strictObject({requestId:id,storeId:id,conversationId:id,expectedMemberId:id});
const previewInputSchema=v.strictObject({...querySchema.entries,source:replyBodySchema,sourceRevision:counter});
const inputSchema=v.strictObject({...previewInputSchema.entries,budgetId:id});
const scopeSchema=v.strictObject({organizationId:id,storeId:id,conversationId:id});
const receiptSchema=v.strictObject({submissionId:id,uid:id,acceptedAt:v.pipe(v.string(),v.maxLength(40),v.isoTimestamp(),v.check(value=>Number.isFinite(Date.parse(value))&&Date.parse(value)>=0))});
const evidenceSchema=v.strictObject({kind:v.literal('execution_closed_without_provider_request'),evidenceId:id,instanceId:id,verifiedAt:time,providerRequests:v.literal(0),executionClosed:v.literal(true)});
const now="CAST(unixepoch('subsecond')*1000 AS INTEGER)";
const budgetColumns='id,organization_id AS organizationId,starts_at AS startsAt,ends_at AS endsAt,enabled,revision,limit_micros AS limitMicros,reserved_micros AS reservedMicros,spent_micros AS spentMicros';
const runColumns=`run.id,run.organization_id AS organizationId,run.store_id AS storeId,run.conversation_id AS conversationId,run.request_id AS requestId,
  run.actor_user_id AS actorUserId,run.actor_member_id AS actorMemberId,run.source,run.source_hash AS sourceHash,run.source_revision AS sourceRevision,
  run.budget_id AS budgetId,run.config,run.reserved_micros AS reservedMicros,run.created_at AS createdAt,run.receipt,run.settlement,run.usage,
  run.charged_micros AS chargedMicros,run.settled_at AS settledAt,run.release_evidence AS releaseEvidence,run.provider_request_claimed_at AS providerRequestClaimedAt`;
type BudgetRow=Omit<TranslationBudget,'enabled'>&{enabled:number};
type RunRow=Omit<TranslationRun,'config'|'receipt'|'usage'|'releaseEvidence'>&{config:string;receipt:string|null;usage:string|null;releaseEvidence:string|null};
type AccessRow=RunRow&{accessMemberId:string};
function validActor(actor:TranslationActor){if(!v.is(actorSchema,actor))throw new RangeError('INVALID_TRANSLATION_ACTOR');}
function budget(row:BudgetRow|null):TranslationBudget|null{return row?{...row,enabled:row.enabled===1}:null;}
function run(row:RunRow):TranslationRun{
  return {id:row.id,organizationId:row.organizationId,storeId:row.storeId,conversationId:row.conversationId,requestId:row.requestId,
    actorUserId:row.actorUserId,actorMemberId:row.actorMemberId,source:row.source,sourceHash:row.sourceHash,sourceRevision:row.sourceRevision,budgetId:row.budgetId,providerRequestClaimedAt:row.providerRequestClaimedAt,
    config:freezeTranslationConfig(JSON.parse(row.config)),reservedMicros:row.reservedMicros,createdAt:row.createdAt,receipt:row.receipt===null?null:JSON.parse(row.receipt),
    settlement:row.settlement,usage:row.usage===null?null:JSON.parse(row.usage),chargedMicros:row.chargedMicros,settledAt:row.settledAt,releaseEvidence:row.releaseEvidence===null?null:JSON.parse(row.releaseEvidence)};
}
function scopeValues(scope:TranslationScope,runId:string){
  if(!v.is(scopeSchema,scope)||!v.is(id,runId))throw new RangeError('INVALID_TRANSLATION_SCOPE');
  return [runId,scope.organizationId,scope.storeId,scope.conversationId];
}
const runWhere='run.id=? AND run.organization_id=? AND run.store_id=? AND run.conversation_id=?';
function internalRead(db:D1Database,scope:TranslationScope,runId:string){return db.prepare(`SELECT ${runColumns} FROM reply_preview_run AS run WHERE ${runWhere}`).bind(...scopeValues(scope,runId));}
async function requiredRun(db:D1Database,scope:TranslationScope,runId:string){
  const row=await internalRead(db,scope,runId).first<RunRow>();if(!row)throw new Error('TRANSLATION_RUN_NOT_FOUND');return run(row);
}
/** Internal financial repair read; it confers no permission to display the source or output. */
export async function readTranslationForRepair(db:D1Database,scope:TranslationScope,runId:string){
  const row=await internalRead(db,scope,runId).first<RunRow>();return row?run(row):null;
}
const accessFrom=`FROM conversation JOIN store ON store.id=conversation.store_id AND store.organization_id=conversation.organization_id
  JOIN member AS viewer ON viewer.organization_id=conversation.organization_id AND viewer.user_id=?`;
const accessWhere=`conversation.organization_id=? AND conversation.store_id=? AND conversation.id=? AND viewer.id=? AND ${storeAccess('store.organization_id',false)}`;
type RunQuery=Pick<TranslationInput,'requestId'|'storeId'|'conversationId'|'expectedMemberId'>;
function queryValues(actor:TranslationActor,input:RunQuery){
  validActor(actor);if(!v.is(querySchema,input))throw new RangeError('INVALID_TRANSLATION_QUERY');
  return [actor.orgId,input.storeId,input.conversationId,input.expectedMemberId,actor.actorUserId,actor.sessionId];
}
function authorizedRead(db:D1Database,actor:TranslationActor,input:RunQuery){
  const values=queryValues(actor,input);
  return db.prepare(`SELECT viewer.id AS accessMemberId,${runColumns} ${accessFrom}
    LEFT JOIN reply_preview_run AS run ON run.organization_id=conversation.organization_id AND run.request_id=? WHERE ${accessWhere}`)
    .bind(actor.actorUserId,input.requestId,...values);
}
function query(input:RunQuery):RunQuery{return {requestId:input.requestId,storeId:input.storeId,conversationId:input.conversationId,expectedMemberId:input.expectedMemberId};}
function matchesIdentity(value:TranslationRun,actor:TranslationActor,input:RunQuery){
  return value.organizationId===actor.orgId&&value.storeId===input.storeId&&value.conversationId===input.conversationId&&value.actorUserId===actor.actorUserId&&value.actorMemberId===input.expectedMemberId;
}
function existing(row:AccessRow|null,actor:TranslationActor,input:TranslationInput):TranslationReservation|null{
  if(!row)return {outcome:'not_found'};if(!row.id)return null;
  const value=run(row);
  return matchesIdentity(value,actor,input)&&value.source===input.source&&value.sourceRevision===input.sourceRevision&&value.budgetId===input.budgetId
    ?{outcome:'existing',run:value}:{outcome:'conflict'};
}
export async function createTranslationBudget(db:D1Database,actor:TranslationActor,input:{id:string;startsAt:number;endsAt:number;limitMicros:number}):Promise<TranslationBudget|null>{
  validActor(actor);
  if(!v.is(v.strictObject({id,startsAt:time,endsAt:time,limitMicros:counter}),input)||input.endsAt<=input.startsAt)throw new RangeError('INVALID_TRANSLATION_BUDGET');
  return budget(await db.prepare(`INSERT INTO translation_budget_bucket(id,organization_id,starts_at,ends_at,limit_micros)
    SELECT ?,?,?,?,? WHERE ${storeAccess('?')} RETURNING ${budgetColumns}`)
    .bind(input.id,actor.orgId,input.startsAt,input.endsAt,input.limitMicros,actor.orgId,actor.actorUserId,actor.sessionId).first<BudgetRow>());
}
export async function readTranslationBudget(db:D1Database,actor:TranslationActor,budgetId:string):Promise<TranslationBudget|null>{
  validActor(actor);if(!v.is(id,budgetId))throw new RangeError('INVALID_TRANSLATION_BUDGET');
  return budget(await db.prepare(`SELECT ${budgetColumns} FROM translation_budget_bucket WHERE id=? AND organization_id=? AND ${storeAccess('translation_budget_bucket.organization_id')}`)
    .bind(budgetId,actor.orgId,actor.actorUserId,actor.sessionId).first<BudgetRow>());
}
export async function setTranslationBudgetEnabled(db:D1Database,actor:TranslationActor,budgetId:string,expectedRevision:number,enabled:boolean):Promise<TranslationBudget|null>{
  validActor(actor);if(!v.is(id,budgetId)||!v.is(counter,expectedRevision)||expectedRevision===Number.MAX_SAFE_INTEGER||typeof enabled!=='boolean')throw new RangeError('INVALID_TRANSLATION_BUDGET');
  return budget(await db.prepare(`UPDATE translation_budget_bucket SET enabled=?,revision=revision+1 WHERE id=? AND organization_id=? AND revision=? AND ${storeAccess('translation_budget_bucket.organization_id')}
    RETURNING ${budgetColumns}`).bind(enabled?1:0,budgetId,actor.orgId,expectedRevision,actor.actorUserId,actor.sessionId).first<BudgetRow>());
}
export async function readTranslationRun(db:D1Database,actor:TranslationActor,input:RunQuery):Promise<TranslationRun|null>{
  // Callers may hold the full frozen input; only the read scope participates here.
  const row=await authorizedRead(db,actor,query(input)).first<AccessRow>();
  if(!row?.id)return null;const value=run(row);return matchesIdentity(value,actor,input)?value:null;
}
const outputSchema=v.strictObject({runId:id,body:replyBodySchema,bodyHash:v.pipe(v.string(),v.regex(/^[a-f0-9]{64}$/)),receipt:receiptSchema,recordedAt:time});
type OutputRow=Omit<TranslationOutput,'receipt'>&{receipt:string;runReceipt:string};
const outputColumns='output.run_id AS runId,output.body,output.body_hash AS bodyHash,output.receipt,output.recorded_at AS recordedAt,run.receipt AS runReceipt';
function outputRead(db:D1Database,bound:ReturnType<typeof scopeValues>){
  return db.prepare(`SELECT ${outputColumns} FROM reply_preview_run AS run JOIN reply_preview_output AS output ON output.run_id=run.id WHERE ${runWhere}`).bind(...bound);
}
async function outputHash(body:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
async function checkedOutput(row:OutputRow):Promise<TranslationOutput>{
  const parsed=v.safeParse(outputSchema,{runId:row.runId,body:row.body,bodyHash:row.bodyHash,receipt:JSON.parse(row.receipt),recordedAt:row.recordedAt});
  if(!parsed.success||row.receipt!==row.runReceipt||await outputHash(parsed.output.body)!==parsed.output.bodyHash)throw new Error('INVALID_TRANSLATION_OUTPUT');
  return parsed.output;
}
// Internal scope-bound evidence reads. Public callers still require the original member authorization.
export async function readTranslationOutput(db:D1Database,scope:TranslationScope,runId:string):Promise<TranslationOutput|null>{
  const row=await outputRead(db,scopeValues(scope,runId)).first<OutputRow>();return row?checkedOutput(row):null;
}
export async function freezeTranslationOutput(db:D1Database,scope:TranslationScope,runId:string,receipt:TranslationReceipt,body:string):Promise<TranslationOutput>{
  const bound=scopeValues(scope,runId),encoded=receiptText(receipt);
  if(!v.is(replyBodySchema,body))throw new RangeError('INVALID_TRANSLATION_OUTPUT');
  const hash=await outputHash(body);
  const results=await db.batch([
    db.prepare(`INSERT INTO reply_preview_output(run_id,body,body_hash,receipt,recorded_at)
      SELECT run.id,?,?,?,MAX(${now},run.created_at) FROM reply_preview_run AS run
      WHERE ${runWhere} AND run.receipt=? AND run.settlement<>'released'
        AND NOT EXISTS (SELECT 1 FROM reply_preview_output WHERE run_id=run.id)`)
      .bind(body,hash,encoded,...bound,encoded),
    outputRead(db,bound),
  ]);
  const row=results[1]!.results[0] as OutputRow|undefined;if(!row)throw new Error('TRANSLATION_OUTPUT_UNAVAILABLE');
  const saved=await checkedOutput(row);
  if(saved.body!==body||saved.bodyHash!==hash||receiptText(saved.receipt)!==encoded)throw new Error('TRANSLATION_OUTPUT_CONFLICT');
  return saved;
}
export async function reserveTranslation(db:D1Database,actor:TranslationActor,input:TranslationInput,currentConfig:unknown):Promise<TranslationReservation>{
  if(!v.is(inputSchema,input))throw new RangeError('INVALID_TRANSLATION_INPUT');
  const replay=existing(await authorizedRead(db,actor,query(input)).first<AccessRow>(),actor,input);if(replay)return replay;
  let config:TranslationConfig,reserved:number;
  try {config=freezeTranslationConfig(currentConfig);reserved=estimateTranslationReservation(config);}catch(error){if(error instanceof RangeError)return {outcome:'pricing_unavailable'};throw error;}
  const sourceHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input.source)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  const token=crypto.randomUUID(),runId=crypto.randomUUID();
  const marker='EXISTS (SELECT 1 FROM translation_budget_bucket WHERE id=? AND organization_id=? AND commit_token=?)';
  const markerValues=[input.budgetId,actor.orgId,token];
  const results=await db.batch([
    db.prepare(`UPDATE translation_budget_bucket SET reserved_micros=reserved_micros+?,commit_token=?
      WHERE id=? AND organization_id=? AND enabled=1 AND starts_at<=${now} AND ends_at>${now}
        AND reserved_micros<=9007199254740991-? AND limit_micros-spent_micros-reserved_micros>=?
        AND NOT EXISTS (SELECT 1 FROM reply_preview_run WHERE organization_id=? AND request_id=?)
        AND EXISTS (SELECT 1 ${accessFrom} WHERE ${accessWhere})`)
      .bind(reserved,token,input.budgetId,actor.orgId,reserved,reserved,actor.orgId,input.requestId,actor.actorUserId,...queryValues(actor,query(input))),
    db.prepare(`INSERT INTO reply_preview_run(id,organization_id,store_id,conversation_id,request_id,actor_user_id,actor_member_id,source,source_hash,source_revision,budget_id,config,reserved_micros,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,${now} WHERE ${marker}`)
      .bind(runId,actor.orgId,input.storeId,input.conversationId,input.requestId,actor.actorUserId,input.expectedMemberId,input.source,sourceHash,input.sourceRevision,input.budgetId,JSON.stringify(config),reserved,...markerValues),
    authorizedRead(db,actor,query(input)),
    db.prepare('UPDATE translation_budget_bucket SET commit_token=NULL WHERE id=? AND organization_id=? AND commit_token=?').bind(...markerValues),
  ]);
  const found=existing((results[2]!.results[0]??null) as AccessRow|null,actor,input);
  if(found?.outcome==='existing'&&results[0]!.meta.changes===1)return {outcome:'reserved',run:found.run};
  return found??{outcome:'budget_unavailable'};
}
function receiptText(receipt:TranslationReceipt){
  const parsed=v.safeParse(receiptSchema,receipt);if(!parsed.success)throw new RangeError('INVALID_TRANSLATION_RECEIPT');return JSON.stringify(parsed.output);
}
export async function bindTranslationReceipt(db:D1Database,scope:TranslationScope,runId:string,receipt:TranslationReceipt):Promise<void>{
  const bound=scopeValues(scope,runId),encoded=receiptText(receipt);
  const results=await db.batch([
    db.prepare(`UPDATE reply_preview_run AS run SET receipt=? WHERE ${runWhere} AND settlement='held' AND receipt IS NULL`).bind(encoded,...bound),
    internalRead(db,scope,runId),
  ]);
  const row=results[1]!.results[0] as RunRow|undefined;if(!row)throw new Error('TRANSLATION_RUN_NOT_FOUND');
  if(row.settlement==='released')throw new Error('TRANSLATION_SETTLEMENT_CONFLICT');
  if(row.receipt!==encoded)throw new Error('TRANSLATION_RECEIPT_CONFLICT');
}
async function finish(db:D1Database,scope:TranslationScope,value:TranslationRun,settlement:'settled'|'released',charged:number,usage:string|null,evidence:string|null,receipt:string|null){
  const token=crypto.randomUUID(),bound=scopeValues(scope,value.id),marker=[value.budgetId,scope.organizationId,token];
  const results=await db.batch([
    db.prepare(`UPDATE translation_budget_bucket SET reserved_micros=reserved_micros-?,spent_micros=spent_micros+?,commit_token=?
      WHERE id=? AND organization_id=? AND reserved_micros>=? AND spent_micros<=9007199254740991-?
        AND EXISTS (SELECT 1 FROM reply_preview_run AS run WHERE ${runWhere} AND settlement='held' ${settlement==='settled'?'AND receipt=?':'AND provider_request_claimed_at IS NULL'})`)
      .bind(value.reservedMicros,charged,token,value.budgetId,scope.organizationId,value.reservedMicros,charged,...bound,...(settlement==='settled'?[receipt]:[])),
    db.prepare(`UPDATE reply_preview_run AS run SET settlement=?,usage=?,charged_micros=?,settled_at=MAX(created_at,${now}),release_evidence=?,repair_due_at=NULL,repair_token=NULL
      WHERE ${runWhere} AND settlement='held' AND EXISTS (SELECT 1 FROM translation_budget_bucket WHERE id=? AND organization_id=? AND commit_token=?)`)
      .bind(settlement,usage,charged,evidence,...bound,...marker),
    internalRead(db,scope,value.id),
    db.prepare('UPDATE translation_budget_bucket SET commit_token=NULL WHERE id=? AND organization_id=? AND commit_token=?').bind(...marker),
  ]);
  const row=results[2]!.results[0] as RunRow|undefined;if(!row)throw new Error('TRANSLATION_RUN_NOT_FOUND');
  if(row.settlement!==settlement||row.usage!==usage||row.chargedMicros!==charged||row.releaseEvidence!==evidence)throw new Error('TRANSLATION_SETTLEMENT_CONFLICT');
  if(settlement==='settled'&&row.receipt!==receipt)throw new Error('TRANSLATION_RECEIPT_CONFLICT');
}
export async function settleTranslationUsage(db:D1Database,scope:TranslationScope,runId:string,receipt:TranslationReceipt,usage:TranslationUsage):Promise<void>{
  const encoded=receiptText(receipt),value=await requiredRun(db,scope,runId);
  if(value.receipt===null||receiptText(value.receipt)!==encoded)throw new Error('TRANSLATION_RECEIPT_CONFLICT');
  const charged=estimateTranslationUsage(value.config,usage),encodedUsage=JSON.stringify({input:usage.input,output:usage.output,cacheRead:usage.cacheRead,cacheWrite:usage.cacheWrite});
  await finish(db,scope,value,'settled',charged,encodedUsage,null,encoded);
}
export async function releaseUnstartedTranslation(db:D1Database,scope:TranslationScope,runId:string,evidence:UnstartedTranslationEvidence):Promise<void>{
  // Internal trust boundary: 4C3B must obtain this proof from the closed provider
  // ledger. Neither a missing receipt nor a timeout is evidence of zero requests.
  const parsed=v.safeParse(evidenceSchema,evidence);if(!parsed.success||evidence.instanceId!==`reply-preview:${runId}`)throw new RangeError('INVALID_TRANSLATION_RELEASE_EVIDENCE');
  const value=await requiredRun(db,scope,runId);
  if(evidence.verifiedAt<value.createdAt||evidence.verifiedAt>Date.now())throw new RangeError('INVALID_TRANSLATION_RELEASE_EVIDENCE');
  await finish(db,scope,value,'released',0,null,JSON.stringify(parsed.output),null);
}

const executionEligible=`run.settlement='held' AND EXISTS (
  SELECT 1 FROM conversation JOIN store ON store.id=conversation.store_id AND store.organization_id=conversation.organization_id
  JOIN member AS actor ON actor.id=run.actor_member_id AND actor.user_id=run.actor_user_id AND actor.organization_id=run.organization_id
  JOIN user AS caller ON caller.id=actor.user_id
  JOIN translation_budget_bucket AS budget ON budget.id=run.budget_id AND budget.organization_id=run.organization_id
  WHERE conversation.id=run.conversation_id AND conversation.organization_id=run.organization_id AND conversation.store_id=run.store_id
    AND caller.email_verified=1 AND budget.enabled=1 AND budget.reserved_micros>=run.reserved_micros
    AND budget.spent_micros<=budget.limit_micros-budget.reserved_micros
    AND (actor.role IN ('owner','admin') OR (actor.role='member' AND EXISTS (SELECT 1 FROM store_grant AS permission
      WHERE permission.organization_id=store.organization_id AND permission.store_id=store.id AND permission.member_id=actor.id))))`;
export async function readTranslationExecutionContext(db:D1Database,scope:TranslationScope,runId:string):Promise<TranslationRun|null>{
  const row=await db.prepare(`SELECT ${runColumns} FROM reply_preview_run AS run WHERE ${runWhere} AND ${executionEligible}`).bind(...scopeValues(scope,runId)).first<RunRow>();
  if(!row)return null;
  try{const value=run(row);return estimateTranslationReservation(value.config)===value.reservedMicros?value:null;}
  catch(error){if(error instanceof RangeError||error instanceof SyntaxError)return null;throw error;}
}
export async function claimTranslationProviderRequest(db:D1Database,scope:TranslationScope,runId:string):Promise<boolean>{
  const value=await readTranslationExecutionContext(db,scope,runId);if(!value||value.providerRequestClaimedAt!==null)return false;
  // A committed marker whose response was lost is never a reusable permission.
  // The immutable frozen inputs were validated above; authorization is checked again here.
  const claimed=await db.prepare(`UPDATE reply_preview_run AS run SET provider_request_claimed_at=MAX(created_at,${now})
    WHERE ${runWhere} AND provider_request_claimed_at IS NULL AND reserved_micros=? AND ${executionEligible}
    RETURNING provider_request_claimed_at`).bind(...scopeValues(scope,runId),value.reservedMicros).first();
  return claimed!==null;
}
export async function admitTranslationPreview(db:D1Database,actor:TranslationActor,input:Omit<TranslationInput,'budgetId'>,env:TranslationDeploymentEnv):Promise<TranslationReservation|{outcome:'disabled'|'not_configured'}>{
  if(!v.is(previewInputSchema,input))throw new RangeError('INVALID_TRANSLATION_INPUT');
  const replay=async()=>{
    const row=await authorizedRead(db,actor,query(input)).first<AccessRow>();
    return existing(row,actor,{...input,budgetId:row?.budgetId??''});
  };
  const previous=await replay();if(previous)return previous;
  if(env.TRANSLATION_ENABLED!=='true')return {outcome:'disabled'};
  const config=(await import('./deployment-config.ts')).readTranslationDeploymentConfig(env);if(!config)return {outcome:'not_configured'};
  const budgets=await db.prepare(`SELECT id FROM translation_budget_bucket WHERE organization_id=? AND enabled=1
    AND starts_at<=${now} AND ends_at>${now} ORDER BY starts_at LIMIT 2`).bind(actor.orgId).all<{id:string}>();
  if(budgets.results.length!==1)return {outcome:'budget_unavailable'};
  const result=await reserveTranslation(db,actor,{...input,budgetId:budgets.results[0]!.id},config);
  // A concurrent original request may have chosen a different admission window.
  return result.outcome==='conflict'?(await replay()??result):result;
}
