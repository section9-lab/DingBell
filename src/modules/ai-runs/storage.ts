import { NOW_MS } from '../../platform/database/sql.ts';
import * as v from 'valibot';
import {noPushMessageReview} from '../ozon-push/barrier.ts';
import {aiScopeSchema} from '../conversations/ai-state.ts';
import {aiWorkSchema,type AiWork} from '../conversations/ai-intake.ts';
import type {ControlScope} from '../conversations/control-types.ts';
import {knowledgeHash} from '../knowledge/content.ts';
import {freezeAiModelConfig,estimateAiReservation,estimateAiUsage} from './finance.ts';
import type {AiModelConfig,AiReceipt,AiUsage} from './finance.ts';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const count=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
const time=v.pipe(count,v.maxValue(8640000000000000));
const generation=v.pipe(count,v.minValue(1),v.maxValue(8));
const receiptSchema=v.strictObject({submissionId:id,uid:id,acceptedAt:v.pipe(v.string(),v.maxLength(40),v.isoTimestamp())});
const usageSchema=v.strictObject({input:count,output:count,cacheRead:count,cacheWrite:count});
const closureFields={evidenceId:v.pipe(v.string(),v.uuid()),instanceId:id,verifiedAt:time,executionClosed:v.literal(true)};
const closureSchema=v.variant('kind',[
 v.strictObject({...closureFields,kind:v.literal('runtime_closed'),providerPermits:v.pipe(count,v.maxValue(8)),receipt:receiptSchema,outcome:v.picklist(['completed','failed','aborted'])}),
 v.strictObject({...closureFields,kind:v.literal('unstarted_closed'),providerPermits:v.literal(0)}),
]);
type Config={model:AiModelConfig;maxGenerations:number};
type Closure=v.InferOutput<typeof closureSchema>;
type Payload={schemaVersion:1;run:AiWork;target:ReturnType<typeof target>;modelInput:ReturnType<typeof modelInput>};
type Generation={sequence:number;claimedAt:number;usage:AiUsage|null;chargedMicros:number|null;settledAt:number|null};
export type AiRunReader=(scope:ControlScope,runId:string)=>Promise<AiWork|null>;
export interface AiExecution {id:string;budgetId:string;agent:'Support';instanceId:string;dispatchKey:string;payload:Payload;modelInput:Payload['modelInput'];config:Config;reservedMicros:number;perGenerationMicros:number;
 createdAt:number;receipt:AiReceipt|null;closure:Closure|null;generations:Generation[];remainingReservedMicros:number;status:'open'|'unconfirmed'|'settled'}
type Row={id:string;organizationId:string;storeId:string;conversationId:string;controllerId:string;budgetId:string;payload:string;payloadHash:string;config:string;perGenerationMicros:number;reservedMicros:number;maxGenerations:number;generations:number;createdAt:number;receipt:string|null;closure:string|null};
const now = NOW_MS;
const columns='r.id,r.organization_id AS organizationId,r.store_id AS storeId,r.conversation_id AS conversationId,r.controller_id AS controllerId,r.budget_id AS budgetId,r.payload,r.payload_hash AS payloadHash,r.config,r.per_generation_micros AS perGenerationMicros,r.reserved_micros AS reservedMicros,r.max_generations AS maxGenerations,r.generations,r.created_at AS createdAt,r.receipt,r.closure';
const where='r.id=? AND r.organization_id=? AND r.store_id=? AND r.conversation_id=? AND r.controller_id=?';
function bound(scope:ControlScope,runId:string){v.parse(aiScopeSchema,scope);v.parse(v.pipe(v.string(),v.uuid()),runId);return [runId,scope.organizationId,scope.storeId,scope.conversationId,scope.controllerId];}
export function freezeAiConfig(value:unknown){
 const input=v.parse(v.strictObject({model:v.unknown(),maxGenerations:generation}),value),config={model:freezeAiModelConfig(input.model),maxGenerations:input.maxGenerations};
 const per=estimateAiReservation(config.model),total=BigInt(per)*BigInt(config.maxGenerations);if(total>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('AI_BUDGET_OVERFLOW');
 return {config,per,total:Number(total)};
}
function modelInput(run:AiWork){
 if(run.schemaVersion===2)return {task:'classify' as const,untrustedCustomerQuestion:run.admission.question};
 const policy=run.admission.policyConfig;if(policy.kind!=='automatic')throw new Error('AI_POLICY_INVALID');return {untrustedCustomerQuestion:run.admission.question,language:run.admission.language,stage:run.admission.stage,tone:policy.tone,untrustedMerchantInstructions:policy.instructions};
}
function phaseConfig(run:AiWork,config:Config){return run.schemaVersion===1||(config.maxGenerations===1&&config.model.promptVersion==='intake-v1');}
const target=(runId:string)=>({agent:'Support' as const,instanceId:`ai-support:${runId}`,dispatchKey:runId});
// Recheck D1-controlled authority in the same transaction as a financial grant.
export const currentPayload=`EXISTS (SELECT 1 FROM conversation_control cc JOIN conversation c ON c.id=cc.conversation_id AND c.organization_id=cc.organization_id AND c.store_id=cc.store_id
 JOIN store s ON s.id=c.store_id AND s.organization_id=c.organization_id JOIN reply_policy p ON p.organization_id=c.organization_id
 WHERE cc.controller_id=json_extract(plan.value,'$.run.scope.controllerId') AND cc.organization_id=json_extract(plan.value,'$.run.scope.organizationId')
 AND cc.store_id=json_extract(plan.value,'$.run.scope.storeId') AND cc.conversation_id=json_extract(plan.value,'$.run.scope.conversationId')
 AND cc.lifecycle='open' AND cc.reception='ai' AND cc.control_epoch=json_extract(plan.value,'$.run.controlEpoch') AND cc.assigned_member_id IS NULL AND cc.work_status='needs_reply'
 AND c.message_sequence=json_extract(plan.value,'$.run.admission.inputRevision') AND ${noPushMessageReview('c')}
 AND NOT EXISTS(SELECT 1 FROM ozon_push_chat_head AS head WHERE head.organization_id=c.organization_id AND head.store_id=c.store_id AND head.conversation_id=c.id AND head.message_id IS NOT json_extract(plan.value,'$.run.admission.messageId')) AND c.platform_type='BUYER_SELLER' AND lower(c.platform_status)='opened'
 AND s.status IN ('verified','partial','attention') AND p.enabled=1 AND p.kind='automatic'
 AND ((json_extract(plan.value,'$.run.schemaVersion')=1 AND p.id=json_extract(plan.value,'$.run.admission.policyId') AND p.published_revision=json_extract(plan.value,'$.run.admission.policyRevision'))
  OR (json_extract(plan.value,'$.run.kind')='intake'
   AND (SELECT count(*) FROM json_each(plan.value,'$.run.admission.candidates'))=(SELECT count(*) FROM json_each(plan.value,'$.run.admission.candidates') candidate
    JOIN reply_policy frozen ON frozen.organization_id=p.organization_id AND frozen.id=json_extract(candidate.value,'$.policyId')
    JOIN policy_version pv ON pv.organization_id=frozen.organization_id AND pv.policy_id=frozen.id AND pv.revision=frozen.published_revision AND pv.schema_version=1
    WHERE frozen.enabled=1 AND frozen.kind='automatic' AND frozen.published_revision=json_extract(candidate.value,'$.policyRevision')
     AND json_extract(candidate.value,'$.mode')='automatic' AND json_extract(pv.config,'$.mode')='automatic'
     AND (json_array_length(pv.config,'$.storeIds')=0 OR EXISTS(SELECT 1 FROM json_each(pv.config,'$.storeIds') WHERE value=c.store_id))
     AND json_extract(pv.config,'$.stage')=json_extract(candidate.value,'$.stage'))
   AND EXISTS (SELECT 1 FROM ingest_event e JOIN message m ON m.id=e.message_id AND m.organization_id=e.organization_id AND m.store_id=e.store_id AND m.conversation_id=e.conversation_id
    WHERE e.id=json_extract(plan.value,'$.run.admission.event.eventId') AND e.message_id=json_extract(plan.value,'$.run.request.messageId')
     AND e.organization_id=c.organization_id AND e.store_id=c.store_id AND e.conversation_id=c.id AND e.state='pending' AND e.live_observed_at IS NOT NULL AND m.direction='inbound' AND m.ingest_mode='incremental')))
 AND json_extract(plan.value,'$.run.deadlineAt')>${now})`;
export async function readAiExecution(db:D1Database,scope:ControlScope,runId:string):Promise<AiExecution|null>{
 scope=v.parse(aiScopeSchema,scope);
 const values=bound(scope,runId),rows=await db.batch([
  db.prepare(`SELECT ${columns} FROM ai_execution r WHERE ${where}`).bind(...values),
  db.prepare(`SELECT g.sequence,g.claimed_at AS claimedAt,g.usage,g.charged_micros AS chargedMicros,g.settled_at AS settledAt FROM ai_generation g JOIN ai_execution r ON r.id=g.run_id WHERE ${where} ORDER BY g.sequence`).bind(...values),
 ]),row=rows[0].results[0] as unknown as Row|undefined;if(!row)return null;
 const payload=JSON.parse(row.payload) as Payload,run=v.parse(aiWorkSchema,payload.run),cost=freezeAiConfig(JSON.parse(row.config));
 if(!phaseConfig(run,cost.config))throw new Error('AI_EXECUTION_INVALID');
 if(payload.schemaVersion!==1||JSON.stringify(payload.target)!==JSON.stringify(target(runId))||JSON.stringify(payload.modelInput)!==JSON.stringify(modelInput(run))||run.request.runId!==row.id||JSON.stringify(bound(run.scope,row.id))!==JSON.stringify(values)
  ||await knowledgeHash({payload,config:cost.config})!==row.payloadHash||cost.per!==row.perGenerationMicros||cost.total!==row.reservedMicros||cost.config.maxGenerations!==row.maxGenerations)throw new Error('AI_EXECUTION_INVALID');
 const generations=rows[1].results.map((g:any)=>({...g,usage:g.usage===null?null:v.parse(usageSchema,JSON.parse(g.usage))})) as Generation[];
 if(generations.length!==row.generations||generations.some((g,i)=>g.sequence!==i+1||g.chargedMicros!==(g.usage===null?null:estimateAiUsage(cost.config.model,g.usage))))throw new Error('AI_GENERATIONS_INVALID');
 const receipt=row.receipt===null?null:v.parse(receiptSchema,JSON.parse(row.receipt)),closure=row.closure===null?null:v.parse(closureSchema,JSON.parse(row.closure));
 if(closure&&(closure.instanceId!==`ai-support:${runId}`||closure.providerPermits!==generations.length||(closure.kind==='runtime_closed'?JSON.stringify(closure.receipt)!==JSON.stringify(receipt):receipt!==null)))throw new Error('AI_CLOSURE_INVALID');
 const unsettled=generations.filter(g=>g.usage===null).length;
 return {id:row.id,budgetId:row.budgetId,...payload.target,payload,modelInput:payload.modelInput,config:cost.config,reservedMicros:cost.total,perGenerationMicros:cost.per,
  createdAt:row.createdAt,receipt,closure,generations,remainingReservedMicros:(unsettled+(closure?0:row.maxGenerations-generations.length))*cost.per,status:closure?unsettled?'unconfirmed':'settled':'open'};
}
async function required(db:D1Database,scope:ControlScope,runId:string){const run=await readAiExecution(db,scope,runId);if(!run)throw new Error('AI_EXECUTION_NOT_FOUND');return run;}
/**
 * AI budgets were removed from the product: no spend is reserved and no limit can refuse a run.
 * The `ai_execution.budget_id` foreign key still needs a stable row, so each organization keeps
 * one inert sentinel that is never read back.
 */
const inertBudgetId='ai-unbounded-run';
async function inertExecutionBudget(db:D1Database,organizationId:string){
 await db.prepare(`INSERT INTO ai_budget(id,organization_id,starts_at,ends_at,enabled,revision,limit_micros,max_runs)
  VALUES(?,?,0,8640000000000000,1,0,9007199254740991,1000000) ON CONFLICT(id) DO NOTHING`).bind(inertBudgetId,organizationId).run();
 return inertBudgetId;
}
export async function reserveAiExecution(db:D1Database,read:AiRunReader,scope:ControlScope,runId:string,value:unknown):Promise<{outcome:'reserved'|'existing'|'conflict'|'unavailable'|'pricing_unavailable';run?:AiExecution}>{
 scope=v.parse(aiScopeSchema,scope);
 bound(scope,runId);let cost:ReturnType<typeof freezeAiConfig>;try{cost=freezeAiConfig(value);}catch{return {outcome:'pricing_unavailable'};}
 const previous=await readAiExecution(db,scope,runId);
 if(previous)return JSON.stringify(previous.config)===JSON.stringify(cost.config)?{outcome:'existing',run:previous}:{outcome:'conflict'};
 const raw=await read({...scope},runId);if(!raw)return {outcome:'unavailable'};const run=v.parse(aiWorkSchema,raw);
 if(!phaseConfig(run,cost.config))return {outcome:'pricing_unavailable'};
 if(JSON.stringify(bound(run.scope,run.request.runId))!==JSON.stringify(bound(scope,runId))||Date.now()>=run.deadlineAt)return {outcome:'unavailable'};
 const payload:Payload={schemaVersion:1,run,target:target(runId),modelInput:modelInput(run)},encoded=JSON.stringify(payload);if(new TextEncoder().encode(encoded).length>98304)throw new Error('AI_INPUT_LIMIT');
 const hash=await knowledgeHash({payload,config:cost.config}),budgetId=await inertExecutionBudget(db,scope.organizationId);
 const reserved=cost.per*cost.config.maxGenerations;if(!Number.isSafeInteger(reserved))return {outcome:'pricing_unavailable'};
 const inserted=await db.prepare(`INSERT INTO ai_execution(id,organization_id,store_id,conversation_id,controller_id,budget_id,payload,payload_hash,config,per_generation_micros,reserved_micros,max_generations,created_at)
   SELECT ?,?,?,?,?,?,?,?,?,?,?,?,${now} FROM (SELECT ? AS value) plan WHERE ${currentPayload} ON CONFLICT(id) DO NOTHING RETURNING id`)
  .bind(...bound(scope,runId),budgetId,encoded,hash,JSON.stringify(cost.config),cost.per,reserved,cost.config.maxGenerations,encoded).first();
 const saved=await readAiExecution(db,scope,runId);
 if(saved)return JSON.stringify(saved.config)===JSON.stringify(cost.config)?{outcome:inserted?'reserved':'existing',run:saved}:{outcome:'conflict'};
 return {outcome:'unavailable'};
}
export async function bindAiExecutionReceipt(db:D1Database,scope:ControlScope,runId:string,value:unknown){
 scope=v.parse(aiScopeSchema,scope);
 const encoded=JSON.stringify(v.parse(receiptSchema,value));
 await db.prepare(`UPDATE ai_execution AS r SET receipt=? WHERE ${where} AND receipt IS NULL AND closure IS NULL`).bind(encoded,...bound(scope,runId)).run();
 if(JSON.stringify((await required(db,scope,runId)).receipt)!==encoded)throw new Error('AI_RECEIPT_CONFLICT');
}
export async function claimAiGeneration(db:D1Database,read:AiRunReader,scope:ControlScope,runId:string,sequence:number){
 scope=v.parse(aiScopeSchema,scope);
 v.parse(generation,sequence);const run=await required(db,scope,runId);if(run.closure||run.generations.length!==sequence-1||sequence>run.config.maxGenerations||run.generations.some(g=>g.usage===null))return false;
 const current=await read({...scope},runId);if(JSON.stringify(current)!==JSON.stringify(run.payload.run))return false;
 const token=crypto.randomUUID(),values=bound(scope,runId),result=await db.batch([
  db.prepare(`UPDATE ai_execution AS r SET generations=generations+1,commit_token=? WHERE ${where} AND closure IS NULL AND generations=? AND generations<max_generations
   AND NOT EXISTS (SELECT 1 FROM ai_generation g WHERE g.run_id=r.id AND g.usage IS NULL)
   AND EXISTS (SELECT 1 FROM (SELECT r.payload AS value) plan WHERE ${currentPayload}) RETURNING id`).bind(token,...values,sequence-1),
  db.prepare(`INSERT INTO ai_generation(run_id,sequence,claimed_at) SELECT id,generations,MAX(created_at,${now}) FROM ai_execution r WHERE ${where} AND commit_token=?`).bind(...values,token),
  db.prepare(`UPDATE ai_execution AS r SET commit_token=NULL WHERE ${where} AND commit_token=?`).bind(...values,token),
 ]);return result[0].results.length===1;
}
export async function settleAiGeneration(db:D1Database,scope:ControlScope,runId:string,sequence:number,value:unknown,usageValue:unknown){
 scope=v.parse(aiScopeSchema,scope);
 v.parse(generation,sequence);const receipt=JSON.stringify(v.parse(receiptSchema,value)),usage=v.parse(usageSchema,usageValue),run=await required(db,scope,runId);
 if(JSON.stringify(run.receipt)!==receipt)throw new Error('AI_RECEIPT_CONFLICT');const attempt=run.generations[sequence-1];if(!attempt)throw new Error('AI_GENERATION_NOT_FOUND');
 const charged=estimateAiUsage(run.config.model,usage),encoded=JSON.stringify(usage);if(attempt.usage!==null){if(JSON.stringify(attempt.usage)!==encoded||attempt.chargedMicros!==charged)throw new Error('AI_SETTLEMENT_CONFLICT');return;}
 await db.prepare(`UPDATE ai_generation SET usage=?,charged_micros=?,settled_at=MAX(claimed_at,${now}) WHERE run_id=? AND sequence=? AND usage IS NULL
   AND EXISTS (SELECT 1 FROM ai_execution r WHERE ${where} AND r.receipt=?)`)
  .bind(encoded,charged,runId,sequence,...bound(scope,runId),receipt).run();
 const saved=(await required(db,scope,runId)).generations[sequence-1];if(JSON.stringify(saved?.usage)!==encoded||saved?.chargedMicros!==charged)throw new Error('AI_SETTLEMENT_CONFLICT');
}
/** Only a trusted, permanently closed runtime ledger may provide closure evidence. */
export async function closeAiExecution(db:D1Database,scope:ControlScope,runId:string,value:unknown){
 scope=v.parse(aiScopeSchema,scope);
 const proof=v.parse(closureSchema,value),run=await required(db,scope,runId),encoded=JSON.stringify(proof);
 if(proof.instanceId!==run.instanceId||proof.providerPermits!==run.generations.length||proof.verifiedAt<run.createdAt||proof.verifiedAt>Date.now()
  ||(proof.kind==='runtime_closed'?JSON.stringify(proof.receipt)!==JSON.stringify(run.receipt):run.receipt!==null))throw new Error('AI_CLOSURE_INVALID');
 if(run.closure){if(JSON.stringify(run.closure)!==encoded)throw new Error('AI_CLOSURE_CONFLICT');return;}
 const matches=proof.kind==='runtime_closed'?'r.receipt=?':'r.receipt IS NULL',args=proof.kind==='runtime_closed'?[JSON.stringify(proof.receipt)]:[];
 await db.prepare(`UPDATE ai_execution AS r SET closure=? WHERE ${where} AND closure IS NULL AND generations=? AND ${matches}`)
  .bind(encoded,...bound(scope,runId),proof.providerPermits,...args).run();
 if(JSON.stringify((await required(db,scope,runId)).closure)!==encoded)throw new Error('AI_CLOSURE_CONFLICT');
}

/** Persist the Agent loop so the conversation panel keeps showing it after the runtime closes. */
export async function saveAiLoopSnapshot(db:D1Database,run:AiExecution,loop:{steps:unknown[];truncated:boolean}){
 const encoded=JSON.stringify(loop);if(new TextEncoder().encode(encoded).length>65536)return;
 await db.prepare(`INSERT INTO ai_loop_snapshot(run_id,organization_id,store_id,conversation_id,payload,created_at)
  VALUES(?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET payload=excluded.payload,created_at=excluded.created_at`)
  .bind(run.id,run.payload.run.scope.organizationId,run.payload.run.scope.storeId,run.payload.run.scope.conversationId,encoded,Date.now()).run();
}
export async function readAiLoopSnapshot(db:D1Database,runId:string){
 const row=await db.prepare('SELECT payload FROM ai_loop_snapshot WHERE run_id=?').bind(runId).first<{payload:string}>();
 if(!row)return null;try{return JSON.parse(row.payload) as {steps:unknown[];truncated:boolean};}catch{return null;}
}
