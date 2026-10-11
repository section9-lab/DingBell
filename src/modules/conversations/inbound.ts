import * as v from 'valibot';
import {aiScopeSchema} from './ai-state.ts';
import {storedControlStateSchema} from './control-state.ts';
import type {ControlScope} from './control-types.ts';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const counter=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER-1));
const time=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(8_640_000_000_000_000));
export const inboundEventSchema=v.strictObject({scope:aiScopeSchema,eventId:id,messageId:id,sequence:v.pipe(counter,v.minValue(1)),eventAt:time,liveObservedAt:time});
export const aiPendingInputSchema=v.strictObject({schemaVersion:v.literal(1),event:inboundEventSchema,controlEpoch:counter});
const receiptSchema=v.pipe(v.strictObject({action:v.literal('customer_message'),origin:v.literal('system'),commandId:v.pipe(v.string(),v.maxLength(264)),expectedVersion:counter,
 actorUserId:v.null(),actorMemberId:v.null(),appliedState:storedControlStateSchema,event:inboundEventSchema}),v.check(r=>{
 const s=r.appliedState;return s.schemaVersion===2&&s.lifecycle==='open'&&s.workStatus==='needs_reply'&&s.version===r.expectedVersion+1&&s.sequence>0&&r.commandId===`inbound:${r.event.eventId}`;
}));
export type InboundEvent=v.InferOutput<typeof inboundEventSchema>;
export type InboundReceipt=v.InferOutput<typeof receiptSchema>;
export type AiPendingInput=v.InferOutput<typeof aiPendingInputSchema>;
export function checkedInboundReceipt(value:unknown){return v.parse(receiptSchema,value);}
/** Only committed live customer input is eligible; the caller cannot supply message facts. */
export async function readInboundEvent(db:D1Database,scope:ControlScope,eventId:string):Promise<InboundEvent|null>{
 v.parse(aiScopeSchema,scope);v.parse(id,eventId);
 const row=await db.prepare(`SELECT e.id AS eventId,m.id AS messageId,a.sequence,m.event_at AS eventAt,e.live_observed_at AS liveObservedAt
  FROM ingest_event e JOIN message m ON m.id=e.message_id AND m.organization_id=e.organization_id AND m.store_id=e.store_id AND m.conversation_id=e.conversation_id
  JOIN message_append a ON a.message_id=m.id AND a.organization_id=m.organization_id AND a.store_id=m.store_id AND a.conversation_id=m.conversation_id
  JOIN conversation_control cc ON cc.organization_id=e.organization_id AND cc.store_id=e.store_id AND cc.conversation_id=e.conversation_id
  WHERE cc.controller_id=? AND e.organization_id=? AND e.store_id=? AND e.conversation_id=? AND e.id=? AND e.schema_version=1
  AND e.state='pending' AND e.live_observed_at IS NOT NULL AND m.direction='inbound' AND m.ingest_mode='incremental'
  AND NOT EXISTS(SELECT 1 FROM message newer WHERE newer.organization_id=m.organization_id AND newer.store_id=m.store_id AND newer.conversation_id=m.conversation_id
    AND (newer.event_at>m.event_at OR (newer.event_at=m.event_at AND newer.id>m.id)))`).bind(scope.controllerId,scope.organizationId,scope.storeId,scope.conversationId,eventId).first<Omit<InboundEvent,'scope'>>();
 return row?v.parse(inboundEventSchema,{scope,...row}):null;
}
