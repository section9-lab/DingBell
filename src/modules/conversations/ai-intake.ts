import * as v from 'valibot';
import {aiScopeSchema,aiRunSchema} from './ai-state.ts';
import {replyBodySchema,storedControlStateSchema} from './control-state.ts';
import {inboundEventSchema,readInboundEvent} from './inbound.ts';
import {policyStageSchema} from '../../shared/reply-policy.ts';
import {selectReplyPolicy} from '../reply-policies/matching.ts';
import type {ControlScope} from './control-types.ts';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256)),uuid=v.pipe(v.string(),v.uuid());
const counter=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER-1));
const time=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(8640000000000000));
const language=v.picklist(['ru','zh-CN','en']);
export const aiIntakeRequestSchema=v.strictObject({runId:uuid,expectedVersion:counter,messageId:id});
export const aiDispatchAdmissionSchema=v.strictObject({runId:uuid,eventId:id});
export const aiDispatchStopRequestSchema=v.pipe(v.strictObject({eventId:id,runId:uuid,targetRunId:v.nullable(uuid),reason:v.picklist(['unavailable','runtime_failure','timeout','disabled'])}),v.check(r=>r.targetRunId!==null||r.reason==='disabled'||r.reason==='timeout'));
export const aiDispatchStopReceiptSchema=v.pipe(v.strictObject({action:v.literal('ai_dispatch_stop'),origin:v.literal('system'),
 commandId:v.pipe(v.string(),v.maxLength(280)),expectedVersion:counter,expectedEpoch:counter,actorUserId:v.null(),actorMemberId:v.null(),
 input:aiDispatchStopRequestSchema,event:inboundEventSchema,appliedState:storedControlStateSchema}),v.check(r=>{
 const s=r.appliedState;return r.commandId===`ai-dispatch-stop:${r.input.runId}`&&r.input.eventId===r.event.eventId&&s.schemaVersion===2
  &&s.version===r.expectedVersion+1&&s.controlEpoch===r.expectedEpoch+1&&s.lifecycle==='open'&&s.reception==='paused'&&s.assignedMemberId===null&&s.workStatus==='needs_reply';
}));
export type AiDispatchStopReceipt=v.InferOutput<typeof aiDispatchStopReceiptSchema>;
export function checkedAiDispatchStopReceipt(value:unknown){return v.parse(aiDispatchStopReceiptSchema,value);}
export const aiClassificationSchema=v.strictObject({stage:v.picklist(['presale','order','aftersale','unknown']),language:v.picklist(['ru','zh-CN','en','unknown']),customerRequestedHuman:v.boolean()});
const candidate=v.strictObject({stage:policyStageSchema,policyId:id,policyRevision:v.pipe(counter,v.minValue(1)),mode:v.picklist(['automatic','suggest']),language:v.picklist(['customer','ru','zh-CN','en'])});
const admission=v.strictObject({messageId:id,inputRevision:counter,question:replyBodySchema,event:inboundEventSchema,
 candidates:v.pipe(v.array(candidate),v.minLength(1),v.maxLength(3),v.check(rows=>new Set(rows.map(r=>r.stage)).size===rows.length&&rows.some(r=>r.mode==='automatic')))});
export const aiIntakeRunSchema=v.pipe(v.strictObject({schemaVersion:v.literal(2),kind:v.literal('intake'),scope:aiScopeSchema,request:aiIntakeRequestSchema,admission,
 controlEpoch:counter,startedAt:time,deadlineAt:time}),v.check(r=>r.deadlineAt>r.startedAt&&r.deadlineAt<=r.startedAt+60000&&r.request.messageId===r.admission.messageId
  &&r.admission.event.messageId===r.request.messageId&&r.admission.event.sequence<=r.admission.inputRevision&&JSON.stringify(r.scope)===JSON.stringify(r.admission.event.scope)));
export const aiWorkSchema=v.union([aiRunSchema,aiIntakeRunSchema]);
const decision=v.variant('kind',[
 v.strictObject({kind:v.literal('ready'),nextRunId:uuid,stage:policyStageSchema,language,policyId:id,policyRevision:v.pipe(counter,v.minValue(1))}),
 v.strictObject({kind:v.literal('handoff'),reason:v.picklist(['unclassified','customer_request','unsupported_language','policy_unavailable','timeout','runtime_failure'])}),
]);
const fields={commandId:id,expectedVersion:counter,actorUserId:v.null(),actorMemberId:v.null(),appliedState:storedControlStateSchema,run:aiIntakeRunSchema};
export const aiIntakeReceiptSchema=v.pipe(v.variant('action',[
 v.strictObject({...fields,action:v.literal('ai_intake_start'),origin:v.literal('system')}),
 v.strictObject({...fields,action:v.literal('ai_classification'),origin:v.picklist(['agent','system']),classification:v.nullable(aiClassificationSchema),decision}),
]),v.check(r=>{
 const s=r.appliedState,run=r.run;
 if(s.schemaVersion!==2||s.lifecycle!=='open'||s.workStatus!=='needs_reply'||s.assignedMemberId!==null||s.version!==r.expectedVersion+1||s.updatedAt<run.startedAt)return false;
 if(r.action==='ai_intake_start')return r.commandId===`ai-intake:${run.request.runId}`&&r.expectedVersion===run.request.expectedVersion&&s.controlEpoch===run.controlEpoch&&s.reception==='ai';
 if(r.commandId!==`ai-classification:${run.request.runId}`||s.controlEpoch!==run.controlEpoch+1||(r.origin==='agent')!==(r.classification!==null))return false;
 return r.decision.kind==='handoff'?s.reception==='paused':s.reception==='ai'&&r.origin==='agent'&&r.classification?.stage===r.decision.stage&&!r.classification.customerRequestedHuman&&r.decision.nextRunId!==run.request.runId;
}));
export type AiIntakeRun=v.InferOutput<typeof aiIntakeRunSchema>;
export type AiWork=v.InferOutput<typeof aiWorkSchema>;
export type AiClassification=v.InferOutput<typeof aiClassificationSchema>;
export type AiIntakeReceipt=v.InferOutput<typeof aiIntakeReceiptSchema>;
export type AiIntakeDecision=v.InferOutput<typeof decision>;
export function checkedAiIntakeReceipt(value:unknown){return v.parse(aiIntakeReceiptSchema,value);}
export function classifyDecision(run:AiIntakeRun,input:AiClassification):AiIntakeDecision{
 if(input.customerRequestedHuman)return {kind:'handoff',reason:'customer_request'};
 if(input.stage==='unknown')return {kind:'handoff',reason:'unclassified'};
 const candidate=run.admission.candidates.find(c=>c.stage===input.stage);if(!candidate||candidate.mode!=='automatic')return {kind:'handoff',reason:'policy_unavailable'};
 const language=candidate.language==='customer'?input.language:candidate.language;if(language==='unknown')return {kind:'handoff',reason:'unsupported_language'};
 return {kind:'ready',nextRunId:crypto.randomUUID(),stage:input.stage,language,policyId:candidate.policyId,policyRevision:candidate.policyRevision};
}
/** Classification receives facts from committed input and never a caller-selected policy or order scope. */
export async function readAiIntakeAdmission(db:D1Database,scope:ControlScope,messageId:string){
 v.parse(aiScopeSchema,scope);v.parse(id,messageId);
 const row=await db.prepare(`SELECT m.content,c.message_sequence AS inputRevision,e.id AS eventId FROM conversation_control cc
  JOIN conversation c ON c.id=cc.conversation_id AND c.organization_id=cc.organization_id AND c.store_id=cc.store_id
  JOIN store s ON s.id=c.store_id AND s.organization_id=c.organization_id
  JOIN message m ON m.conversation_id=c.id AND m.organization_id=c.organization_id AND m.store_id=c.store_id
  JOIN ingest_event e ON e.message_id=m.id AND e.organization_id=m.organization_id AND e.store_id=m.store_id AND e.conversation_id=m.conversation_id
  WHERE cc.controller_id=? AND cc.organization_id=? AND cc.store_id=? AND cc.conversation_id=? AND m.id=?
  AND s.status IN ('verified','partial','attention') AND c.platform_type='BUYER_SELLER' AND c.platform_status='Opened' AND m.is_image=0 AND length(CAST(m.content AS BLOB))<=15000`)
  .bind(scope.controllerId,scope.organizationId,scope.storeId,scope.conversationId,messageId).first<{content:string;inputRevision:number;eventId:string}>();
 if(!row)return null;const event=await readInboundEvent(db,scope,row.eventId);if(!event)return null;
 const matches=await Promise.all(policyStageSchema.options.map(async stage=>{const p=await selectReplyPolicy(db,scope,stage);return p?{stage,policyId:p.id,policyRevision:p.revision,mode:p.config.mode,language:p.config.language}:null;}));
 try{const content=v.parse(v.pipe(v.array(v.string()),v.minLength(1),v.maxLength(16)),JSON.parse(row.content));return v.parse(admission,{messageId,inputRevision:row.inputRevision,question:content.join('\n'),event,candidates:matches.filter(p=>p!==null)});}catch{return null;}
}
