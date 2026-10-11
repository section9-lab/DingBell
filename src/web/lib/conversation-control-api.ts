import * as v from 'valibot';
import { ApiError, request } from './api.ts';

const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const count=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
const timestamp=v.pipe(v.string(),v.isoTimestamp(),v.check(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value));
const noteBody=v.pipe(v.string(),v.maxLength(4000),v.check(value=>!!value.trim()&&value.isWellFormed()&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)));
const replyBody=v.pipe(noteBody,v.maxLength(1000));
const uuid=v.pipe(v.string(),v.uuid());
const replyId=v.pipe(v.string(),v.check(value=>v.is(uuid,value.startsWith('ai-reply:')?value.slice(9):value)));
const replyReason=v.nullable(v.pipe(v.string(),v.minLength(1),v.maxLength(128),v.regex(/^[A-Za-z][A-Za-z0-9_]*$/)));
const replyAttemptSchema=v.object({id,status:v.picklist(['sending','sent','failed','unknown']),startedAt:timestamp,finishedAt:v.nullable(timestamp),
  httpStatus:v.nullable(v.pipe(v.number(),v.integer(),v.minValue(100),v.maxValue(599))),providerResult:v.nullable(v.literal('success')),errorCode:replyReason});
const replySchema=v.pipe(v.object({intentId:replyId,commandId:replyId,body:replyBody,previewRequestId:v.optional(uuid),status:v.picklist(['queued','sending','sent','failed','unknown','skipped','canceled']),
  revision:v.pipe(count,v.minValue(1)),createdAt:timestamp,updatedAt:timestamp,reason:replyReason,attempt:v.nullable(replyAttemptSchema)}),v.check(reply=>{
  if(reply.intentId!==reply.commandId||Date.parse(reply.updatedAt)<Date.parse(reply.createdAt))return false;
  const attempt=reply.attempt;
  if(reply.status==='queued'||reply.status==='skipped'||reply.status==='canceled')return attempt===null&&(reply.status==='skipped'?reply.reason!==null:reply.reason===null);
  if(!attempt||attempt.id!==`${reply.intentId}:1`||attempt.status!==reply.status||Date.parse(attempt.startedAt)<Date.parse(reply.createdAt))return false;
  if(reply.status==='sending')return attempt.finishedAt===null&&attempt.httpStatus===null&&attempt.providerResult===null&&attempt.errorCode===null&&reply.reason===null;
  if(attempt.finishedAt===null||Date.parse(attempt.finishedAt)<Date.parse(attempt.startedAt)||Date.parse(attempt.finishedAt)>Date.parse(reply.updatedAt))return false;
  return reply.status==='sent'?attempt.httpStatus===200&&attempt.providerResult==='success'&&attempt.errorCode===null&&reply.reason===null:
    attempt.providerResult===null&&attempt.errorCode!==null&&reply.reason===attempt.errorCode;
}));
const noteCursor=v.pipe(v.string(),v.minLength(1),v.maxLength(4096));
const noteOptions=v.strictObject({limit:v.optional(v.pipe(count,v.minValue(1),v.maxValue(50))),cursor:v.optional(noteCursor)});
const noteSchema=v.object({commandId:v.pipe(v.string(),v.uuid()),sequence:v.pipe(count,v.minValue(1)),body:noteBody,authorMemberId:id,authorName:v.string(),createdAt:timestamp});
const reason=v.pipe(v.string(),v.minLength(1),v.maxLength(500));
const targetSchema=v.object({memberId:id,name:v.string(),email:v.string(),role:v.picklist(['owner','admin','member'])});
const offsetSchema=v.pipe(count,v.maxValue(10000));
const workStatusSchema=v.picklist(['needs_reply','waiting_customer','waiting_internal']);
const stateFields={
  version:count,controlEpoch:count,sequence:count,
  lifecycle:v.picklist(['open','resolved']),reception:v.picklist(['paused','human','ai']),assignedMemberId:v.nullable(id),updatedAt:timestamp,
};
const legacyStateSchema=v.object({...stateFields,reception:v.picklist(['paused','human']),schemaVersion:v.literal(1)});
const stateSchema=v.pipe(v.object({...stateFields,schemaVersion:v.literal(2),workStatus:v.nullable(workStatusSchema)}),
  v.check(state=>(state.lifecycle==='resolved'?state.workStatus===null:state.workStatus!==null)&&(state.reception!=='ai'||state.lifecycle==='open'&&state.workStatus==='needs_reply'&&state.assignedMemberId===null)));
const assigneeSchema=v.nullable(v.union([
  v.object({memberId:id,name:v.string(),status:v.picklist(['eligible','ineligible'])}),
  v.object({memberId:id,name:v.null(),status:v.literal('removed')}),
]));
const controlSchema=v.pipe(v.object({state:stateSchema,viewerMemberId:id,projectionPending:v.boolean(),assignee:assigneeSchema}),
  v.check(view=>view.state.assignedMemberId===null?view.assignee===null:view.assignee?.memberId===view.state.assignedMemberId));
const commandFields={commandId:v.pipe(v.string(),v.uuid()),expectedVersion:v.pipe(count,v.maxValue(Number.MAX_SAFE_INTEGER-1))};
const actionSchema=v.picklist(['claim','takeover','resolve','reopen']);
const commandSchema=v.union([
  v.strictObject({...commandFields,action:actionSchema}),
  v.strictObject({...commandFields,action:v.literal('set_work_status'),workStatus:workStatusSchema}),
  v.strictObject({...commandFields,action:v.literal('transfer'),targetMemberId:id,reason:v.pipe(v.string(),v.trim(),reason)}),
  v.strictObject({...commandFields,action:v.literal('add_note'),body:noteBody}),
  v.strictObject({...commandFields,action:v.literal('send_reply'),body:replyBody,previewRequestId:v.optional(uuid)}),
  v.strictObject({...commandFields,action:v.literal('cancel_reply'),targetIntentId:uuid}),
]);
const digest=v.pipe(v.string(),v.regex(/^[a-f0-9]{64}$/));
const translationSchema=v.object({requestId:uuid,runId:uuid,sourceRevision:count,sourceHash:digest,outputHash:digest,confirmedBodyHash:digest});
const receiptFields={...commandFields,actorUserId:id,actorMemberId:id};
const receiptSchema=v.union([
  v.object({...receiptFields,action:actionSchema,appliedState:v.union([legacyStateSchema,stateSchema])}),
  v.object({...receiptFields,action:v.literal('set_work_status'),workStatus:workStatusSchema,
    appliedState:v.pipe(stateSchema,v.check(state=>state.lifecycle==='open'))}),
  v.object({...receiptFields,action:v.literal('transfer'),targetMemberId:id,reason,
    appliedState:v.pipe(stateSchema,v.check(state=>state.lifecycle==='open'&&state.reception==='human'))}),
  v.object({...receiptFields,action:v.literal('add_note'),body:noteBody,authorName:v.string(),appliedState:stateSchema}),
  v.object({...receiptFields,action:v.literal('send_reply'),body:replyBody,intentId:v.pipe(v.string(),v.uuid()),previewRequestId:v.optional(uuid),translation:v.optional(translationSchema),
    appliedState:v.pipe(stateSchema,v.check(state=>state.lifecycle==='open'&&state.reception==='human'))}),
  v.object({...receiptFields,action:v.literal('cancel_reply'),targetIntentId:uuid,appliedState:stateSchema}),
]);
export function isValidConversationNoteBody(body:string){return v.is(noteBody,body);}
export type ConversationNote=v.InferOutput<typeof noteSchema>;
export type ConversationNoteOptions=v.InferOutput<typeof noteOptions>;
export type ConversationTransferTarget=v.InferOutput<typeof targetSchema>;
export type ConversationWorkStatus=v.InferOutput<typeof workStatusSchema>;
export type ConversationControlState=v.InferOutput<typeof stateSchema>;
export type ConversationControlView=v.InferOutput<typeof controlSchema>;
export type ConversationCommand=v.InferOutput<typeof commandSchema>;
export type ConversationCommandReceipt=v.InferOutput<typeof receiptSchema>;
export type ConversationReply=v.InferOutput<typeof replySchema>;
export function isValidConversationReplyBody(body: string) { return v.is(replyBody, body); }
function normalize(state:ConversationCommandReceipt['appliedState']):ConversationControlState{
  return state.schemaVersion===1?{...state,schemaVersion:2,workStatus:state.lifecycle==='open'?'needs_reply':null}:state;
}
function path(companyId:string,conversationId:string){
  if(!v.is(id,companyId)||!v.is(id,conversationId))throw new ApiError('INVALID_REQUEST');
  return `/api/companies/${encodeURIComponent(companyId)}/conversations/${encodeURIComponent(conversationId)}`;
}

export async function readConversationControl(companyId:string,conversationId:string,signal?:AbortSignal){
  return request(`${path(companyId,conversationId)}/control`,v.object({companyId:v.literal(companyId),conversationId:v.literal(conversationId),control:controlSchema}),{signal});
}

export async function readConversationReply(companyId:string,conversationId:string,intentId:string,signal?:AbortSignal){
  const base=path(companyId,conversationId);
  if(!v.is(replyId,intentId))throw new ApiError('INVALID_REQUEST');
  return request(`${base}/replies/${encodeURIComponent(intentId)}`,v.object({companyId:v.literal(companyId),conversationId:v.literal(conversationId),
    reply:v.pipe(replySchema,v.check(reply=>reply.intentId===intentId)),
  }),{signal});
}

export async function readConversationReplies(companyId:string,conversationId:string,signal?:AbortSignal){
  const readiness=v.pipe(v.object({allowed:v.boolean(),code:v.nullable(v.picklist(['OUTBOUND_DISABLED','CAPABILITY_UNVERIFIED','REPLY_UNAVAILABLE']))}),
    v.check(value=>value.allowed===(value.code===null)));
  return request(`${path(companyId,conversationId)}/replies`,v.pipe(v.object({
    companyId:v.literal(companyId),conversationId:v.literal(conversationId),viewerMemberId:id,controlVersion:count,historyReady:v.boolean(),readiness,
    replies:v.pipe(v.array(replySchema),v.maxLength(20),v.check(rows=>new Set(rows.map(row=>row.intentId)).size===rows.length)),
  }),v.check(value=>value.historyReady||!value.readiness.allowed)),{signal});
}

export async function readConversationTransferTargets(companyId:string,conversationId:string,offset=0,signal?:AbortSignal){
  const base=path(companyId,conversationId);
  if(!v.is(offsetSchema,offset))throw new ApiError('INVALID_REQUEST');
  return request(`${base}/transfer-targets?offset=${offset}`,v.object({
    companyId:v.literal(companyId),conversationId:v.literal(conversationId),
    targets:v.pipe(v.array(targetSchema),v.maxLength(100)),
    nextOffset:v.nullable(v.pipe(offsetSchema,v.check(value=>value===offset+100))),
  }),{signal});
}

export async function readConversationNotes(companyId:string,conversationId:string,options:ConversationNoteOptions={},signal?:AbortSignal){
  const base=path(companyId,conversationId),parsed=v.safeParse(noteOptions,options);
  if(!parsed.success)throw new ApiError('INVALID_REQUEST');
  const limit=parsed.output.limit??20,query=new URLSearchParams({limit:String(limit)});
  if(parsed.output.cursor!==undefined)query.set('cursor',parsed.output.cursor);
  return request(`${base}/notes?${query}`,v.object({companyId:v.literal(companyId),conversationId:v.literal(conversationId),
    notes:v.pipe(v.array(noteSchema),v.maxLength(limit),v.check(notes=>new Set(notes.map(note=>note.commandId)).size===notes.length&&notes.every((note,index)=>index===0||notes[index-1]!.sequence>note.sequence))),
    nextCursor:v.nullable(noteCursor),
  }),{signal});
}

export async function sendConversationCommand(companyId:string,conversationId:string,command:ConversationCommand,expectedMemberId?:string){
  const base=path(companyId,conversationId),parsed=v.safeParse(commandSchema,command);
  if(!parsed.success)throw new ApiError('INVALID_REQUEST');
  const input=parsed.output;
  const boundMember=input.action==='send_reply'||input.action==='cancel_reply';
  if(boundMember&&(typeof expectedMemberId!=='string'||!v.is(id,expectedMemberId)||expectedMemberId!==expectedMemberId.trim()||!expectedMemberId.isWellFormed()||/[\u0000-\u001f\u007f]/.test(expectedMemberId)))throw new ApiError('INVALID_REQUEST');
  const confirmedHash=input.action==='send_reply'&&input.previewRequestId
    ?[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input.body)))].map(byte=>byte.toString(16).padStart(2,'0')).join(''):null;
  return request(`${base}/commands`,v.pipe(v.object({
    companyId:v.literal(companyId),conversationId:v.literal(conversationId),
    receipt:receiptSchema,control:controlSchema,
  }),v.check(value=>{
    const receipt=value.receipt,applied=normalize(receipt.appliedState),current=value.control.state;
    if(receipt.commandId!==input.commandId||receipt.expectedVersion!==input.expectedVersion||receipt.action!==input.action||applied.version!==input.expectedVersion+1
      ||receipt.actorMemberId!==value.control.viewerMemberId||current.version<applied.version)return false;
    if(input.action==='set_work_status'&&(receipt.action!=='set_work_status'||receipt.workStatus!==input.workStatus||applied.workStatus!==input.workStatus))return false;
    if(input.action==='transfer'&&(receipt.action!=='transfer'||receipt.targetMemberId!==input.targetMemberId||receipt.reason!==input.reason||applied.assignedMemberId!==input.targetMemberId))return false;
    if(input.action==='add_note'&&(receipt.action!=='add_note'||receipt.body!==input.body))return false;
    if(input.action==='send_reply'){
      if(receipt.action!=='send_reply'||receipt.body!==input.body||receipt.intentId!==input.commandId||receipt.actorMemberId!==expectedMemberId||receipt.previewRequestId!==input.previewRequestId)return false;
      if(input.previewRequestId?(receipt.translation?.requestId!==input.previewRequestId||receipt.translation?.confirmedBodyHash!==confirmedHash):receipt.translation!==undefined)return false;
    }
    if(input.action==='cancel_reply'&&(receipt.action!=='cancel_reply'||receipt.targetIntentId!==input.targetIntentId||receipt.actorMemberId!==expectedMemberId))return false;
    // A replay can return an older receipt alongside the current state. Never replace the latter with the receipt.
    return current.version>applied.version||Object.entries(applied).every(([key,field])=>current[key as keyof ConversationControlState]===field);
  })),{method:'POST',body:JSON.stringify(input),...(boundMember?{headers:{'X-DingBell-Member-Id':encodeURIComponent(expectedMemberId!)}}:{})}).catch(error=>{
    // Unknown write errors do not prove the controller rejected the original intent.
    const known=['INVALID_REQUEST','CONVERSATION_CHANGED','OUTBOUND_DISABLED','CAPABILITY_UNVERIFIED','REPLY_UNAVAILABLE','PREVIEW_UNAVAILABLE','REPLY_NOT_CANCELABLE','CONTROL_NOT_CONFIGURED',
      'COMMAND_CONFLICT','UNAUTHENTICATED','FORBIDDEN','NOT_FOUND','ORIGIN_REJECTED','RATE_LIMITED'];
    if(boundMember&&error instanceof ApiError&&!known.includes(error.code))throw new ApiError('OPERATION_UNCONFIRMED',error.requestId);
    throw error;
  });
}
