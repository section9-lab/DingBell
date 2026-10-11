import * as v from 'valibot';
import { replyBodySchema } from './control-state.ts';
import type { ReplySnapshot, ReplyView } from './reply-types.ts';

const identifier=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const counter=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
const positive=v.pipe(counter,v.minValue(1));
const timestamp=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(8_640_000_000_000_000));
const reason=v.nullable(v.pipe(v.string(),v.regex(/^[A-Z][A-Z0-9_]{0,127}$/)));
const intentFields={id:identifier,commandId:identifier,
  body:replyBodySchema,bodyHash:v.pipe(v.string(),v.regex(/^[a-f0-9]{64}$/)),platformThreadId:identifier,credentialVersion:positive,controlEpoch:counter,
  state:v.picklist(['queued','sending','sent','failed','unknown','skipped','canceled']),revision:positive,createdAt:timestamp,updatedAt:timestamp,dueAt:v.nullable(timestamp),lastError:reason};
const intentSchema=v.variant('schemaVersion',[
  v.strictObject({...intentFields,schemaVersion:v.literal(1),actorUserId:identifier,actorMemberId:identifier}),
  v.pipe(v.strictObject({...intentFields,schemaVersion:v.literal(2),origin:v.literal('ai'),runId:v.pipe(v.string(),v.uuid()),actorUserId:v.null(),actorMemberId:v.null()}),v.check(intent=>intent.id===`ai-reply:${intent.runId}`)),
]);
const attemptSchema=v.strictObject({id:v.pipe(v.string(),v.minLength(3),v.maxLength(258)),intentId:identifier,
  state:v.picklist(['sending','sent','failed','unknown']),startedAt:timestamp,deadlineAt:timestamp,finishedAt:v.nullable(timestamp),
  httpStatus:v.nullable(v.pipe(v.number(),v.integer(),v.minValue(100),v.maxValue(599))),providerResult:v.nullable(v.literal('success')),errorCode:reason});
export const replySnapshotSchema=v.pipe(v.strictObject({intent:intentSchema,attempt:v.nullable(attemptSchema)}),v.check(({intent,attempt})=>{
  if(intent.id!==intent.commandId||intent.updatedAt<intent.createdAt)return false;
  if((intent.state==='queued'||intent.state==='sending')?intent.dueAt===null:intent.dueAt!==null)return false;
  if(intent.state==='queued'||intent.state==='skipped'||intent.state==='canceled')return attempt===null&&(intent.state==='skipped'?intent.lastError!==null:intent.lastError===null);
  if(!attempt||attempt.intentId!==intent.id||attempt.id!==`${intent.id}:1`||attempt.state!==intent.state||attempt.deadlineAt<attempt.startedAt||attempt.startedAt<intent.createdAt||attempt.startedAt>intent.updatedAt)return false;
  if(attempt.state==='sending')return attempt.finishedAt===null&&attempt.providerResult===null&&attempt.httpStatus===null&&attempt.errorCode===null&&intent.lastError===null;
  if(attempt.finishedAt===null||attempt.finishedAt<attempt.startedAt||attempt.finishedAt>intent.updatedAt)return false;
  return attempt.state==='sent'?attempt.httpStatus===200&&attempt.providerResult==='success'&&attempt.errorCode===null&&intent.lastError===null:
    attempt.providerResult===null&&attempt.errorCode!==null&&intent.lastError===attempt.errorCode;
}));

export function checkedReply(value:unknown):ReplySnapshot {
  const parsed=v.safeParse(replySnapshotSchema,value);
  if(!parsed.success)throw new Error('INVALID_REPLY_STATE');
  return parsed.output;
}
export function replyView(snapshot:ReplySnapshot,previewRequestId?:string):ReplyView {
  const {intent,attempt}=checkedReply(snapshot);
  return {intentId:intent.id,commandId:intent.commandId,body:intent.body,...(previewRequestId?{previewRequestId}:{}),status:intent.state,revision:intent.revision,
    createdAt:intent.createdAt,updatedAt:intent.updatedAt,reason:intent.lastError,
    attempt:attempt?{id:attempt.id,status:attempt.state,startedAt:attempt.startedAt,finishedAt:attempt.finishedAt,
      httpStatus:attempt.httpStatus,providerResult:attempt.providerResult,errorCode:attempt.errorCode}:null};
}
