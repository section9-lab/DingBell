import * as v from 'valibot';
import {aiScopeSchema} from '../conversations/ai-state.ts';
import {aiWorkSchema,type AiWork} from '../conversations/ai-intake.ts';
import type {ControlScope} from '../conversations/control-types.ts';
import {knowledgeHash} from '../knowledge/content.ts';
import {freezeTranslationConfig,estimateTranslationReservation,estimateTranslationUsage} from '../translations/config.ts';
import type {TranslationConfig,TranslationReceipt,TranslationUsage} from '../translations/types.ts';
export {changeAiBudget,readAiBudget} from './budget.ts';
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
type Config={model:TranslationConfig;maxGenerations:number};
type Closure=v.InferOutput<typeof closureSchema>;
type Payload={schemaVersion:1;run:AiWork;target:ReturnType<typeof target>;modelInput:ReturnType<typeof modelInput>};
type Generation={sequence:number;claimedAt:number;usage:TranslationUsage|null;chargedMicros:number|null;settledAt:number|null};
export type AiRunReader=(scope:ControlScope,runId:string)=>Promise<AiWork|null>;
export interface AiExecution {id:string;budgetId:string;agent:'Support';instanceId:string;dispatchKey:string;payload:Payload;modelInput:Payload['modelInput'];config:Config;reservedMicros:number;perGenerationMicros:number;
 createdAt:number;receipt:TranslationReceipt|null;closure:Closure|null;generations:Generation[];remainingReservedMicros:number;status:'open'|'unconfirmed'|'settled'}
type Row={id:string;organizationId:string;storeId:string;conversationId:string;controllerId:string;budgetId:string;payload:string;payloadHash:string;config:string;perGenerationMicros:number;reservedMicros:number;maxGenerations:number;generations:number;createdAt:number;receipt:string|null;closure:string|null};
const now="CAST(unixepoch('subsecond')*1000 AS INTEGER)";
const columns='r.id,r.organization_id AS organizationId,r.store_id AS storeId,r.conversation_id AS conversationId,r.controller_id AS controllerId,r.budget_id AS budgetId,r.payload,r.payload_hash AS payloadHash,r.config,r.per_generation_micros AS perGenerationMicros,r.reserved_micros AS reservedMicros,r.max_generations AS maxGenerations,r.generations,r.created_at AS createdAt,r.receipt,r.closure';
const where='r.id=? AND r.organization_id=? AND r.store_id=? AND r.conversation_id=? AND r.controller_id=?';
function bound(scope:ControlScope,runId:string){v.parse(aiScopeSchema,scope);v.parse(v.pipe(v.string(),v.uuid()),runId);return [runId,scope.organizationId,scope.storeId,scope.conversationId,scope.controllerId];}
export function freezeAiConfig(value:unknown){
 const input=v.parse(v.strictObject({model:v.unknown(),maxGenerations:generation}),value),config={model:freezeTranslationConfig(input.model),maxGenerations:input.maxGenerations};
 const per=estimateTranslationReservation(config.model),total=BigInt(per)*BigInt(config.maxGenerations);if(total>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('AI_BUDGET_OVERFLOW');
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
 AND c.message_sequence=json_extract(plan.value,'$.run.admission.inputRevision') AND c.platform_type='BUYER_SELLER' AND c.platform_status='Opened'
 AND s.status IN ('verified','partial','attention') AND p.enabled=1 AND p.kind='automatic'
 AND ((json_extract(plan.value,'$.run.schemaVersion')=1 AND p.id=json_extract(plan.value,'$.run.admission.policyId') AND p.published_revision=json_extract(plan.value,'$.run.admission.policyRevision'))
  OR (json_extract(plan.value,'$.run.kind')='intake' AND EXISTS (SELECT 1 FROM json_each(plan.value,'$.run.admission.candidates') candidate
   JOIN policy_version pv ON pv.organization_id=p.organization_id AND pv.policy_id=p.id AND pv.revision=p.published_revision AND pv.schema_version=1
   WHERE p.id=json_extract(candidate.value,'$.policyId') AND p.published_revision=json_extract(candidate.value,'$.policyRevision')
    AND json_extract(candidate.value,'$.mode')='automatic' AND json_extract(pv.config,'$.mode')='automatic'
    AND EXISTS(SELECT 1 FROM json_each(pv.config,'$.storeIds') WHERE value=c.store_id)
    AND EXISTS(SELECT 1 FROM json_each(pv.config,'$.stages') WHERE value=json_extract(candidate.value,'$.stage')))
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
 if(generations.length!==row.generations||generations.some((g,i)=>g.sequence!==i+1||g.chargedMicros!==(g.usage===null?null:estimateTranslationUsage(cost.config.model,g.usage))))throw new Error('AI_GENERATIONS_INVALID');
 const receipt=row.receipt===null?null:v.parse(receiptSchema,JSON.parse(row.receipt)),closure=row.closure===null?null:v.parse(closureSchema,JSON.parse(row.closure));
 if(closure&&(closure.instanceId!==`ai-support:${runId}`||closure.providerPermits!==generations.length||(closure.kind==='runtime_closed'?JSON.stringify(closure.receipt)!==JSON.stringify(receipt):receipt!==null)))throw new Error('AI_CLOSURE_INVALID');
 const unsettled=generations.filter(g=>g.usage===null).length;
 return {id:row.id,budgetId:row.budgetId,...payload.target,payload,modelInput:payload.modelInput,config:cost.config,reservedMicros:cost.total,perGenerationMicros:cost.per,
  createdAt:row.createdAt,receipt,closure,generations,remainingReservedMicros:(unsettled+(closure?0:row.maxGenerations-generations.length))*cost.per,status:closure?unsettled?'unconfirmed':'settled':'open'};
}
async function required(db:D1Database,scope:ControlScope,runId:string){const run=await readAiExecution(db,scope,runId);if(!run)throw new Error('AI_EXECUTION_NOT_FOUND');return run;}
export async function reserveAiExecution(db:D1Database,read:AiRunReader,scope:ControlScope,runId:string,budgetId:string,value:unknown):Promise<{outcome:'reserved'|'existing'|'conflict'|'unavailable'|'budget_unavailable'|'pricing_unavailable';run?:AiExecution}>{
 scope=v.parse(aiScopeSchema,scope);
 bound(scope,runId);v.parse(id,budgetId);let cost:ReturnType<typeof freezeAiConfig>;try{cost=freezeAiConfig(value);}catch{return {outcome:'pricing_unavailable'};}
 const previous=await readAiExecution(db,scope,runId);
 if(previous)return previous.budgetId===budgetId&&JSON.stringify(previous.config)===JSON.stringify(cost.config)?{outcome:'existing',run:previous}:{outcome:'conflict'};
 const raw=await read({...scope},runId);if(!raw)return {outcome:'unavailable'};const run=v.parse(aiWorkSchema,raw);
 if(!phaseConfig(run,cost.config))return {outcome:'pricing_unavailable'};
 if(JSON.stringify(bound(run.scope,run.request.runId))!==JSON.stringify(bound(scope,runId))||Date.now()>=run.deadlineAt)return {outcome:'unavailable'};
 const payload:Payload={schemaVersion:1,run,target:target(runId),modelInput:modelInput(run)},encoded=JSON.stringify(payload);if(new TextEncoder().encode(encoded).length>98304)throw new Error('AI_INPUT_LIMIT');
 const hash=await knowledgeHash({payload,config:cost.config}),token=crypto.randomUUID(),marker=[budgetId,scope.organizationId,token];
 const results=await db.batch([
  db.prepare(`UPDATE ai_budget SET reserved_micros=reserved_micros+?,admitted_runs=admitted_runs+1,commit_token=? WHERE id=? AND organization_id=? AND enabled=1
   AND starts_at<=${now} AND ends_at>${now} AND admitted_runs<max_runs AND reserved_micros<=9007199254740991-? AND limit_micros-spent_micros-reserved_micros>=?
   AND NOT EXISTS (SELECT 1 FROM ai_execution WHERE id=?) AND EXISTS (SELECT 1 FROM (SELECT ? AS value) plan WHERE ${currentPayload}) RETURNING id`)
   .bind(cost.total,token,budgetId,scope.organizationId,cost.total,cost.total,runId,encoded),
  db.prepare(`INSERT INTO ai_execution(id,organization_id,store_id,conversation_id,controller_id,budget_id,payload,payload_hash,config,per_generation_micros,reserved_micros,max_generations,created_at)
   SELECT ?,?,?,?,?,?,?,?,?,?,?,?,${now} WHERE EXISTS (SELECT 1 FROM ai_budget WHERE id=? AND organization_id=? AND commit_token=?)`)
   .bind(...bound(scope,runId),budgetId,encoded,hash,JSON.stringify(cost.config),cost.per,cost.total,cost.config.maxGenerations,...marker),
  db.prepare('UPDATE ai_budget SET commit_token=NULL WHERE id=? AND organization_id=? AND commit_token=?').bind(...marker),
 ]);
 const saved=await readAiExecution(db,scope,runId);if(saved)return saved.budgetId===budgetId&&JSON.stringify(saved.config)===JSON.stringify(cost.config)?{outcome:results[0].results.length?'reserved':'existing',run:saved}:{outcome:'conflict'};
 return {outcome:'budget_unavailable'};
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
   AND EXISTS (SELECT 1 FROM ai_budget b WHERE b.id=r.budget_id AND b.organization_id=r.organization_id AND b.enabled=1 AND b.reserved_micros>=(r.max_generations-r.generations)*r.per_generation_micros AND b.spent_micros<=b.limit_micros-b.reserved_micros)
   AND EXISTS (SELECT 1 FROM (SELECT r.payload AS value) plan WHERE ${currentPayload}) RETURNING id`).bind(token,...values,sequence-1),
  db.prepare(`INSERT INTO ai_generation(run_id,sequence,claimed_at) SELECT id,generations,MAX(created_at,${now}) FROM ai_execution r WHERE ${where} AND commit_token=?`).bind(...values,token),
  db.prepare(`UPDATE ai_execution AS r SET commit_token=NULL WHERE ${where} AND commit_token=?`).bind(...values,token),
 ]);return result[0].results.length===1;
}
export async function settleAiGeneration(db:D1Database,scope:ControlScope,runId:string,sequence:number,value:unknown,usageValue:unknown){
 scope=v.parse(aiScopeSchema,scope);
 v.parse(generation,sequence);const receipt=JSON.stringify(v.parse(receiptSchema,value)),usage=v.parse(usageSchema,usageValue),run=await required(db,scope,runId);
 if(JSON.stringify(run.receipt)!==receipt)throw new Error('AI_RECEIPT_CONFLICT');const attempt=run.generations[sequence-1];if(!attempt)throw new Error('AI_GENERATION_NOT_FOUND');
 const charged=estimateTranslationUsage(run.config.model,usage),encoded=JSON.stringify(usage);if(attempt.usage!==null){if(JSON.stringify(attempt.usage)!==encoded||attempt.chargedMicros!==charged)throw new Error('AI_SETTLEMENT_CONFLICT');return;}
 const token=crypto.randomUUID(),marker=[run.budgetId,scope.organizationId,token];await db.batch([
  db.prepare(`UPDATE ai_budget SET reserved_micros=reserved_micros-?,spent_micros=spent_micros+?,commit_token=? WHERE id=? AND organization_id=? AND reserved_micros>=? AND spent_micros<=9007199254740991-?
   AND EXISTS (SELECT 1 FROM ai_execution r JOIN ai_generation g ON g.run_id=r.id WHERE ${where} AND r.receipt=? AND g.sequence=? AND g.usage IS NULL)`)
   .bind(run.perGenerationMicros,charged,token,run.budgetId,scope.organizationId,run.perGenerationMicros,charged,...bound(scope,runId),receipt,sequence),
  db.prepare(`UPDATE ai_generation SET usage=?,charged_micros=?,settled_at=MAX(claimed_at,${now}) WHERE run_id=? AND sequence=? AND usage IS NULL AND EXISTS (SELECT 1 FROM ai_budget WHERE id=? AND organization_id=? AND commit_token=?)`)
   .bind(encoded,charged,runId,sequence,...marker),
  db.prepare('UPDATE ai_budget SET commit_token=NULL WHERE id=? AND organization_id=? AND commit_token=?').bind(...marker),
 ]);
 const saved=(await required(db,scope,runId)).generations[sequence-1];if(JSON.stringify(saved?.usage)!==encoded||saved?.chargedMicros!==charged)throw new Error('AI_SETTLEMENT_CONFLICT');
}
/** Only a trusted, permanently closed runtime ledger may provide closure evidence. */
export async function closeAiExecution(db:D1Database,scope:ControlScope,runId:string,value:unknown){
 scope=v.parse(aiScopeSchema,scope);
 const proof=v.parse(closureSchema,value),run=await required(db,scope,runId),encoded=JSON.stringify(proof);
 if(proof.instanceId!==run.instanceId||proof.providerPermits!==run.generations.length||proof.verifiedAt<run.createdAt||proof.verifiedAt>Date.now()
  ||(proof.kind==='runtime_closed'?JSON.stringify(proof.receipt)!==JSON.stringify(run.receipt):run.receipt!==null))throw new Error('AI_CLOSURE_INVALID');
 if(run.closure){if(JSON.stringify(run.closure)!==encoded)throw new Error('AI_CLOSURE_CONFLICT');return;}
 const unused=(run.config.maxGenerations-run.generations.length)*run.perGenerationMicros,token=crypto.randomUUID(),marker=[run.budgetId,scope.organizationId,token];
 const matches=proof.kind==='runtime_closed'?'r.receipt=?':'r.receipt IS NULL',args=proof.kind==='runtime_closed'?[JSON.stringify(proof.receipt)]:[];
 await db.batch([
  db.prepare(`UPDATE ai_budget SET reserved_micros=reserved_micros-?,commit_token=? WHERE id=? AND organization_id=? AND reserved_micros>=?
   AND EXISTS (SELECT 1 FROM ai_execution r WHERE ${where} AND closure IS NULL AND generations=? AND ${matches})`)
   .bind(unused,token,run.budgetId,scope.organizationId,unused,...bound(scope,runId),proof.providerPermits,...args),
  db.prepare(`UPDATE ai_execution AS r SET closure=? WHERE ${where} AND closure IS NULL AND generations=? AND ${matches} AND EXISTS (SELECT 1 FROM ai_budget WHERE id=? AND organization_id=? AND commit_token=?)`)
   .bind(encoded,...bound(scope,runId),proof.providerPermits,...args,...marker),
  db.prepare('UPDATE ai_budget SET commit_token=NULL WHERE id=? AND organization_id=? AND commit_token=?').bind(...marker),
 ]);
 if(JSON.stringify((await required(db,scope,runId)).closure)!==encoded)throw new Error('AI_CLOSURE_CONFLICT');
}
