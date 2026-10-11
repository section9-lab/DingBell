import * as v from 'valibot';
import {replyPolicyConfigSchema,policyStageSchema} from '../../shared/reply-policy.ts';
import {replyBodySchema,storedControlStateSchema} from './control-state.ts';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const counter=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER-1));
const time=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(8_640_000_000_000_000));
export const aiScopeSchema=v.strictObject({organizationId:id,storeId:id,conversationId:id,controllerId:id});
export const aiStartSchema=v.strictObject({runId:v.pipe(v.string(),v.uuid()),expectedVersion:counter,messageId:id,policyId:id,stage:policyStageSchema,language:v.picklist(['ru','zh-CN','en'])});
export const aiResumeSchema=v.pipe(v.strictObject({...aiStartSchema.entries,previousRunId:v.nullable(v.pipe(v.string(),v.uuid()))}),v.check(r=>r.runId!==r.previousRunId));
export const aiHandoffSchema=v.strictObject({reason:v.picklist(['missing_evidence','customer_request','merchant_decision','tool_failure']),summary:replyBodySchema,
 neededInformation:v.pipe(v.array(v.pipe(replyBodySchema,v.maxLength(200))),v.maxLength(8))});
export const aiAdmissionSchema=v.strictObject({messageId:id,inputRevision:counter,question:replyBodySchema,policyId:id,policyRevision:v.pipe(counter,v.minValue(1)),
 policyConfig:v.pipe(replyPolicyConfigSchema,v.check(c=>c.kind==='automatic'&&c.mode==='automatic')),stage:policyStageSchema,language:v.picklist(['ru','zh-CN','en'])});
export const aiRunSchema=v.pipe(v.strictObject({schemaVersion:v.literal(1),scope:aiScopeSchema,request:aiStartSchema,admission:aiAdmissionSchema,
 controlEpoch:counter,startedAt:time,deadlineAt:time}),v.check(r=>r.deadlineAt>r.startedAt&&r.deadlineAt<=r.startedAt+60_000&&r.request.messageId===r.admission.messageId&&r.request.policyId===r.admission.policyId&&r.request.stage===r.admission.stage));
const fields={commandId:id,expectedVersion:counter,actorUserId:v.null(),actorMemberId:v.null(),appliedState:storedControlStateSchema,run:aiRunSchema};
export const aiReceiptSchema=v.pipe(v.variant('action',[
 v.strictObject({...fields,action:v.literal('ai_start'),origin:v.literal('system')}),
 v.strictObject({...fields,action:v.literal('ai_resume'),origin:v.literal('human'),actorUserId:id,actorMemberId:id,previousRunId:v.nullable(v.pipe(v.string(),v.uuid()))}),
 v.strictObject({...fields,action:v.literal('request_handoff'),origin:v.picklist(['agent','system']),input:aiHandoffSchema}),
]),v.check(r=>{
 const s=r.appliedState;
 return s.schemaVersion===2&&s.lifecycle==='open'&&s.workStatus==='needs_reply'&&s.assignedMemberId===null&&s.version===r.expectedVersion+1&&s.updatedAt>=r.run.startedAt
  &&(r.action!=='request_handoff'?r.commandId===`${r.action==='ai_start'?'ai-start':'ai-resume'}:${r.run.request.runId}`&&(r.action!=='ai_resume'||r.previousRunId!==r.run.request.runId)&&s.reception==='ai'&&s.controlEpoch===r.run.controlEpoch&&r.expectedVersion===r.run.request.expectedVersion:
   r.commandId===`ai-handoff:${r.run.request.runId}`&&s.reception==='paused'&&s.controlEpoch===r.run.controlEpoch+1);
}));
export type AiStart=v.InferOutput<typeof aiStartSchema>;
export type AiRun=v.InferOutput<typeof aiRunSchema>;
export type AiHandoff=v.InferOutput<typeof aiHandoffSchema>;
export type AiReceipt=v.InferOutput<typeof aiReceiptSchema>;
export function checkedAiReceipt(value:unknown):AiReceipt{return v.parse(aiReceiptSchema,value);}
export function handoffNotice(value:unknown){
 const receipt=checkedAiReceipt(value);if(receipt.action!=='request_handoff')throw new Error('HANDOFF_NOT_COMMITTED');
 const language=receipt.run.admission.language;
 const text={ru:'Ваш вопрос передан в очередь поддержки для обработки человеком.', 'zh-CN':'你的问题已转入人工客服待处理队列。',en:'Your question has been added to the support queue for a person to review.'};
 return {language,body:text[language],sent:false as const};
}
