import * as v from 'valibot';
import {replyBodySchema,storedControlStateSchema} from './control-state.ts';

const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const version=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER-1));
export const aiSendReceiptSchema=v.pipe(v.strictObject({action:v.literal('ai_send_reply'),origin:v.literal('ai'),
 runId:v.pipe(v.string(),v.uuid()),commandId:id,intentId:id,body:replyBodySchema,expectedVersion:version,
 actorUserId:v.null(),actorMemberId:v.null(),appliedState:storedControlStateSchema}),v.check(receipt=>{
 const state=receipt.appliedState;
 return receipt.commandId===`ai-reply:${receipt.runId}`&&receipt.intentId===receipt.commandId&&state.schemaVersion===2
  &&state.lifecycle==='open'&&state.reception==='ai'&&state.workStatus==='needs_reply'&&state.assignedMemberId===null
  &&state.version===receipt.expectedVersion+1&&state.sequence>=1;
}));
export type AiSendReceipt=v.InferOutput<typeof aiSendReceiptSchema>;
export function checkedAiSendReceipt(value:unknown):AiSendReceipt{return v.parse(aiSendReceiptSchema,value);}
