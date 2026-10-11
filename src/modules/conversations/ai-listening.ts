import * as v from 'valibot';
import {aiScopeSchema} from './ai-state.ts';
import {storedControlStateSchema} from './control-state.ts';
import {policyStageSchema} from '../../shared/reply-policy.ts';
import {selectReplyPolicy} from '../reply-policies/matching.ts';
import type {ControlScope} from './control-types.ts';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256)),uuid=v.pipe(v.string(),v.uuid());
const counter=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER-1));
const time=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(8_640_000_000_000_000));
export const aiListeningRequestSchema=v.strictObject({commandId:uuid,expectedVersion:counter,previousRunId:v.nullable(uuid)});
export const aiListeningSchema=v.strictObject({schemaVersion:v.literal(1),scope:aiScopeSchema,request:aiListeningRequestSchema,afterSequence:counter,createdAt:time,controlEpoch:counter});
export const aiListeningReceiptSchema=v.pipe(v.strictObject({action:v.literal('ai_listen'),origin:v.literal('human'),commandId:id,expectedVersion:counter,
 actorUserId:id,actorMemberId:id,appliedState:storedControlStateSchema,listening:aiListeningSchema}),v.check(r=>{
 const s=r.appliedState,l=r.listening;
 return s.schemaVersion===2&&s.lifecycle==='open'&&s.reception==='ai'&&s.workStatus==='needs_reply'&&s.assignedMemberId===null
  &&s.version===r.expectedVersion+1&&r.expectedVersion===l.request.expectedVersion&&s.controlEpoch===l.controlEpoch&&s.updatedAt===l.createdAt&&r.commandId===`ai-listen:${l.request.commandId}`;
}));
export type AiListening=v.InferOutput<typeof aiListeningSchema>;
export type AiListeningReceipt=v.InferOutput<typeof aiListeningReceiptSchema>;
export function checkedAiListeningReceipt(value:unknown){return v.parse(aiListeningReceiptSchema,value);}
/** Readiness to wait only. Matching the next input and reserving funds happen at execution admission. */
export async function readAiListeningBoundary(db:D1Database,scope:ControlScope){
 v.parse(aiScopeSchema,scope);
 const row=await db.prepare(`SELECT c.message_sequence AS sequence FROM conversation_control cc
  JOIN conversation c ON c.id=cc.conversation_id AND c.organization_id=cc.organization_id AND c.store_id=cc.store_id
  JOIN store s ON s.id=c.store_id AND s.organization_id=c.organization_id
  WHERE cc.controller_id=? AND cc.organization_id=? AND cc.store_id=? AND cc.conversation_id=?
  AND s.status IN ('verified','partial','attention') AND c.platform_type='BUYER_SELLER' AND c.platform_status='Opened'`).bind(scope.controllerId,scope.organizationId,scope.storeId,scope.conversationId).first<{sequence:number}>();
 if(!row)return null;
 const policies=await Promise.all(policyStageSchema.options.map(stage=>selectReplyPolicy(db,scope,stage)));
 return policies.some(policy=>policy?.config.mode==='automatic')?v.parse(counter,row.sequence):null;
}
export async function isNewAiInput(db:D1Database,listening:AiListening,messageId:string){
 const {scope}=v.parse(aiListeningSchema,listening);v.parse(id,messageId);
 return !!await db.prepare(`SELECT a.message_id FROM message_append a JOIN message m ON m.id=a.message_id AND m.organization_id=a.organization_id AND m.store_id=a.store_id AND m.conversation_id=a.conversation_id
  WHERE a.organization_id=? AND a.store_id=? AND a.conversation_id=? AND a.message_id=? AND a.sequence>?
  AND m.direction='inbound' AND m.ingest_mode='incremental' AND m.event_at>=?`).bind(scope.organizationId,scope.storeId,scope.conversationId,messageId,listening.afterSequence,listening.createdAt).first();
}
