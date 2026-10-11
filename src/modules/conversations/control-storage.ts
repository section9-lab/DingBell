import * as v from 'valibot';
import {checkedAiReceipt} from './ai-state.ts';
import {checkedAiListeningReceipt} from './ai-listening.ts';
import {checkedInboundReceipt} from './inbound.ts';
import {checkedAiIntakeReceipt,checkedAiDispatchStopReceipt} from './ai-intake.ts';
import {checkedAiSendReceipt} from './ai-reply-receipt.ts';
import { storeAccess } from '../stores/storage.ts';
import { checkedReplyTranslation, controlCommandSchema, normalizeControlState, storedControlStateSchema } from './control-state.ts';
import type { ControlAccess, ControlActor, ControlAssignee, ControlDirectory, ControlOutboxEvent as ControlEvent, ControlReceipt, ControlScope, ControlState, StoredControlState, TransferTarget, TransferTargetsPage } from './control-types.ts';

const identifier=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const timestamp=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(8_640_000_000_000_000));
const scopeSchema=v.strictObject({organizationId:identifier,storeId:identifier,conversationId:identifier,controllerId:identifier});
const receiptMetadataSchema=v.strictObject({actorUserId:identifier,actorMemberId:identifier,appliedState:storedControlStateSchema});
type DirectoryRow=Omit<ControlState,'schemaVersion'|'workStatus'> & {schemaVersion:number;workStatus:string|null;organizationId:string;storeId:string;conversationId:string;controllerId:string;repairDueAt:number};
const columns=`control.organization_id AS organizationId,control.store_id AS storeId,control.conversation_id AS conversationId,control.controller_id AS controllerId,
  control.schema_version AS schemaVersion,control.version,control.control_epoch AS controlEpoch,control.sequence,control.lifecycle,control.reception,
  control.assigned_member_id AS assignedMemberId,control.updated_at AS updatedAt,control.work_status AS workStatus,control.repair_due_at AS repairDueAt`;
const scopeWhere='controller_id=? AND organization_id=? AND store_id=? AND conversation_id=?';
const targetEligibility=`target.organization_id=store.organization_id AND person.email_verified=1
  AND (target.role IN ('owner','admin') OR (target.role='member' AND EXISTS (SELECT 1 FROM store_grant AS permission
    WHERE permission.organization_id=store.organization_id AND permission.store_id=store.id AND permission.member_id=target.id)))`;
function parameters(scope:ControlScope){if(!v.is(scopeSchema,scope))throw new RangeError('INVALID_CONTROL_SCOPE');return [scope.controllerId,scope.organizationId,scope.storeId,scope.conversationId];}
function time(value:number){if(!v.is(timestamp,value))throw new RangeError('INVALID_CONTROL_TIME');}
function accessParameters(actor:ControlActor,conversationId:string){
  if(![actor.orgId,actor.actorUserId,actor.sessionId,conversationId].every(id=>v.is(identifier,id)))throw new RangeError('INVALID_CONTROL_ACCESS');
}
function directory(row:DirectoryRow):ControlDirectory{
  if(row.schemaVersion===1&&row.workStatus!==null)throw new Error('UNSUPPORTED_CONTROL_STATE');
  const state={schemaVersion:row.schemaVersion,version:row.version,controlEpoch:row.controlEpoch,sequence:row.sequence,lifecycle:row.lifecycle,reception:row.reception,assignedMemberId:row.assignedMemberId,updatedAt:row.updatedAt,...(row.schemaVersion===1?{}:{workStatus:row.workStatus})};
  normalizeControlState(state);
  return {scope:{organizationId:row.organizationId,storeId:row.storeId,conversationId:row.conversationId,controllerId:row.controllerId},state:state as StoredControlState,repairDueAt:row.repairDueAt};
}
function canonicalReceipt(value:ControlEvent['receipt']):ControlEvent['receipt']{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new RangeError('INVALID_CONTROL_EVENT');
  if(value.action==='ai_send_reply')return checkedAiSendReceipt(value);
  if(value.action==='ai_listen')return checkedAiListeningReceipt(value);
  if(value.action==='ai_dispatch_stop')return checkedAiDispatchStopReceipt(value);
  if(value.action==='customer_message')return checkedInboundReceipt(value);
  if(value.action==='ai_intake_start'||value.action==='ai_classification')return checkedAiIntakeReceipt(value);
  if(value.action==='ai_start'||value.action==='ai_resume'||value.action==='request_handoff')return checkedAiReceipt(value);
  const {actorUserId,actorMemberId,appliedState,...fields}=value;
  const {authorName,...noteCommand}=fields as typeof fields & {authorName?:unknown};
  const {intentId,translation,...replyCommand}=fields as typeof fields & {intentId?:unknown;translation?:unknown};
  const command=value.action==='add_note'?noteCommand:value.action==='send_reply'?replyCommand:fields;
  if(value.action==='add_note'&&typeof authorName!=='string')throw new RangeError('INVALID_CONTROL_EVENT');
  const parsed=v.safeParse(controlCommandSchema,command),metadata=v.safeParse(receiptMetadataSchema,{actorUserId,actorMemberId,appliedState});
  if(!parsed.success||!metadata.success)throw new RangeError('INVALID_CONTROL_EVENT');
  const raw=metadata.output.appliedState;
  if(raw.version<1||raw.sequence<1||(parsed.output.action==='set_work_status'&&(raw.schemaVersion!==2||raw.lifecycle!=='open'||raw.workStatus!==parsed.output.workStatus)))throw new RangeError('INVALID_CONTROL_EVENT');
  if(parsed.output.action==='transfer'&&(raw.schemaVersion!==2||raw.lifecycle!=='open'||raw.reception!=='human'||raw.assignedMemberId!==parsed.output.targetMemberId))throw new RangeError('INVALID_CONTROL_EVENT');
  if(parsed.output.action==='add_note'&&(raw.schemaVersion!==2||raw.version!==parsed.output.expectedVersion+1))throw new RangeError('INVALID_CONTROL_EVENT');
  if(parsed.output.action==='cancel_reply'&&(raw.schemaVersion!==2||raw.version!==parsed.output.expectedVersion+1))throw new RangeError('INVALID_CONTROL_EVENT');
  if(parsed.output.action==='send_reply'&&(!v.is(identifier,intentId)||intentId!==parsed.output.commandId||raw.schemaVersion!==2||raw.lifecycle!=='open'||raw.reception!=='human'||raw.version!==parsed.output.expectedVersion+1))throw new RangeError('INVALID_CONTROL_EVENT');
  // Keep the original v1 field order: its canonical JSON is already immutable audit data.
  const state={schemaVersion:raw.schemaVersion,version:raw.version,controlEpoch:raw.controlEpoch,sequence:raw.sequence,lifecycle:raw.lifecycle,reception:raw.reception,assignedMemberId:raw.assignedMemberId,updatedAt:raw.updatedAt,...(raw.schemaVersion===2?{workStatus:raw.workStatus}:{})};
  const canonicalMetadata={actorUserId:metadata.output.actorUserId,actorMemberId:metadata.output.actorMemberId,appliedState:state as StoredControlState};
  if(parsed.output.action==='send_reply'){
    const evidence=checkedReplyTranslation(translation,parsed.output.previewRequestId);
    return {...parsed.output,...canonicalMetadata,intentId:intentId as string,...(evidence?{translation:evidence}:{})};
  }
  return parsed.output.action==='add_note'?{...parsed.output,...canonicalMetadata,authorName:authorName as string}:{...parsed.output,...canonicalMetadata};
}
function accessQuery(db:D1Database,actor:ControlActor,conversationId:string,targetMemberId?:string){
  accessParameters(actor,conversationId);
  if(targetMemberId!==undefined&&!v.is(identifier,targetMemberId))throw new RangeError('INVALID_CONTROL_TARGET');
  return db.prepare(`SELECT ${columns},conversation.organization_id AS accessOrganizationId,conversation.store_id AS accessStoreId,conversation.id AS accessConversationId,viewer.id AS memberId,viewer_user.name AS memberName,
    EXISTS (SELECT 1 FROM member AS target JOIN user AS person ON person.id=target.user_id WHERE target.id=? AND ${targetEligibility}) AS targetEligible
    FROM conversation JOIN store ON store.id=conversation.store_id AND store.organization_id=conversation.organization_id
    JOIN member AS viewer ON viewer.organization_id=conversation.organization_id AND viewer.user_id=?
    JOIN user AS viewer_user ON viewer_user.id=viewer.user_id
    LEFT JOIN conversation_control AS control ON control.conversation_id=conversation.id AND control.organization_id=conversation.organization_id AND control.store_id=conversation.store_id
    WHERE conversation.id=? AND conversation.organization_id=? AND ${storeAccess('store.organization_id',false)}`)
    .bind(targetMemberId??null,actor.actorUserId,conversationId,actor.orgId,actor.actorUserId,actor.sessionId);
}
type AccessRow=DirectoryRow & {accessOrganizationId:string;accessStoreId:string;accessConversationId:string;memberId:string;memberName:string;targetEligible:number};
export async function readControlAccess(db:D1Database,actor:ControlActor,conversationId:string,targetMemberId?:string):Promise<ControlAccess|null>{
  const row=await accessQuery(db,actor,conversationId,targetMemberId).first<AccessRow>();
  return row?{organizationId:row.accessOrganizationId,storeId:row.accessStoreId,conversationId:row.accessConversationId,memberId:row.memberId,memberName:row.memberName,targetEligible:row.targetEligible===1,directory:row.controllerId===null?null:directory(row)}:null;
}
export async function readControlAssignee(db:D1Database,actor:ControlActor,conversationId:string,assignedMemberId:string|null,viewerMemberId:string):Promise<{assignee:ControlAssignee|null}|null>{
  accessParameters(actor,conversationId);
  if((assignedMemberId!==null&&!v.is(identifier,assignedMemberId))||!v.is(identifier,viewerMemberId))throw new RangeError('INVALID_CONTROL_ASSIGNEE');
  const row=await db.prepare(`SELECT target.id AS memberId,person.name,CASE WHEN ${targetEligibility} THEN 1 ELSE 0 END AS eligible
    FROM conversation JOIN store ON store.id=conversation.store_id AND store.organization_id=conversation.organization_id
    JOIN member AS viewer ON viewer.organization_id=conversation.organization_id AND viewer.user_id=?
    LEFT JOIN member AS target ON target.id=? AND target.organization_id=store.organization_id
    LEFT JOIN user AS person ON person.id=target.user_id
    WHERE conversation.id=? AND conversation.organization_id=? AND viewer.id=? AND ${storeAccess('store.organization_id',false)}`)
    .bind(actor.actorUserId,assignedMemberId,conversationId,actor.orgId,viewerMemberId,actor.actorUserId,actor.sessionId).first<{memberId:string|null;name:string|null;eligible:number}>();
  if(!row)return null;
  if(assignedMemberId===null)return {assignee:null};
  return {assignee:row.memberId===null||row.name===null?{memberId:assignedMemberId,name:null,status:'removed'}:
    {memberId:assignedMemberId,name:row.name,status:row.eligible===1?'eligible':'ineligible'}};
}
export async function listControlTransferTargets(db:D1Database,actor:ControlActor,conversationId:string,offset:number):Promise<TransferTargetsPage|null>{
  accessParameters(actor,conversationId);
  if(!Number.isSafeInteger(offset)||offset<0||offset>10_000)throw new RangeError('INVALID_CONTROL_OFFSET');
  const row=await db.prepare(`SELECT (SELECT json_group_array(json_object('memberId',id,'name',name,'email',email,'role',role)) FROM (
      SELECT target.id,person.name,person.email,target.role FROM member AS target JOIN user AS person ON person.id=target.user_id
      WHERE ${targetEligibility} ORDER BY target.created_at,target.id LIMIT 101 OFFSET ?)) AS targets
    FROM conversation JOIN store ON store.id=conversation.store_id AND store.organization_id=conversation.organization_id
    WHERE conversation.id=? AND conversation.organization_id=? AND ${storeAccess('store.organization_id',false)}`)
    .bind(offset,conversationId,actor.orgId,actor.actorUserId,actor.sessionId).first<{targets:string}>();
  if(!row)return null;
  const targets=JSON.parse(row.targets) as TransferTarget[];
  return {targets:targets.slice(0,100),nextOffset:targets.length>100&&offset<=9_900?offset+100:null};
}
export async function ensureControlDirectory(db:D1Database,actor:ControlActor,conversationId:string,now:number):Promise<ControlDirectory|null>{
  time(now);const read=accessQuery(db,actor,conversationId);
  const results=await db.batch([
    db.prepare(`INSERT INTO conversation_control(conversation_id,organization_id,store_id,controller_id,repair_due_at,schema_version,work_status)
      SELECT conversation.id,conversation.organization_id,conversation.store_id,?,?,2,'needs_reply' FROM conversation
      JOIN store ON store.id=conversation.store_id AND store.organization_id=conversation.organization_id
      WHERE conversation.id=? AND conversation.organization_id=? AND ${storeAccess('store.organization_id',false)}
      ON CONFLICT(conversation_id) DO UPDATE SET repair_due_at=excluded.repair_due_at`)
      .bind(crypto.randomUUID(),now,conversationId,actor.orgId,actor.actorUserId,actor.sessionId),
    read,
  ]);
  const row=results[1]!.results[0] as unknown as AccessRow|undefined;
  return row?.controllerId?directory(row):null;
}
export async function readControlDirectory(db:D1Database,scope:ControlScope):Promise<ControlDirectory|null>{
  const row=await db.prepare(`SELECT ${columns} FROM conversation_control AS control WHERE ${scopeWhere}`).bind(...parameters(scope)).first<DirectoryRow>();
  return row?directory(row):null;
}
export async function projectControlEvents(db:D1Database,scope:ControlScope,events:ControlEvent[],now:number):Promise<void>{
  const bound=parameters(scope);time(now);
  if(!Array.isArray(events)||events.length>50)throw new RangeError('INVALID_CONTROL_EVENT_BATCH');
  const statements:D1PreparedStatement[]=[];
  for(const event of events){
    if(!event||!v.is(scopeSchema,event.scope)||parameters(event.scope).some((value,index)=>value!==bound[index]))throw new RangeError('CONTROL_SCOPE_MISMATCH');
    const receipt=canonicalReceipt(event.receipt),state=normalizeControlState(receipt.appliedState);
    if(receipt.action==='ai_listen'&&parameters(receipt.listening.scope).some((value,index)=>value!==bound[index]))throw new RangeError('CONTROL_SCOPE_MISMATCH');
    if((receipt.action==='customer_message'||receipt.action==='ai_dispatch_stop')&&parameters(receipt.event.scope).some((value,index)=>value!==bound[index]))throw new RangeError('CONTROL_SCOPE_MISMATCH');
    if((receipt.action==='ai_intake_start'||receipt.action==='ai_classification')&&parameters(receipt.run.scope).some((value,index)=>value!==bound[index]))throw new RangeError('CONTROL_SCOPE_MISMATCH');
    if((receipt.action==='ai_start'||receipt.action==='ai_resume'||receipt.action==='request_handoff')&&parameters(receipt.run.scope).some((value,index)=>value!==bound[index]))throw new RangeError('CONTROL_SCOPE_MISMATCH');
    statements.push(db.prepare(`INSERT INTO conversation_control_event(controller_id,organization_id,store_id,conversation_id,sequence,command_id,actor_user_id,actor_member_id,action,receipt,projected_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(...bound,state.sequence,receipt.commandId,receipt.actorUserId,receipt.actorMemberId,receipt.action,JSON.stringify(receipt),now));
    statements.push(db.prepare(`UPDATE conversation_control SET schema_version=?,version=?,control_epoch=?,sequence=?,lifecycle=?,reception=?,assigned_member_id=?,updated_at=?,work_status=?
      WHERE ${scopeWhere} AND sequence<?`).bind(state.schemaVersion,state.version,state.controlEpoch,state.sequence,state.lifecycle,state.reception,state.assignedMemberId,state.updatedAt,state.workStatus,...bound,state.sequence));
  }
  if(statements.length)await db.batch(statements);
}
export async function listDueControlDirectories(db:D1Database,now:number,limit:number):Promise<ControlScope[]>{
  time(now);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new RangeError('INVALID_CONTROL_LIMIT');
  return (await db.prepare(`SELECT organization_id AS organizationId,store_id AS storeId,conversation_id AS conversationId,controller_id AS controllerId
    FROM conversation_control WHERE repair_due_at<=? ORDER BY repair_due_at,controller_id LIMIT ?`).bind(now,limit).all<ControlScope>()).results;
}
export async function deferControlRepair(db:D1Database,scope:ControlScope,dueAt:number):Promise<void>{
  time(dueAt);await db.prepare(`UPDATE conversation_control SET repair_due_at=? WHERE ${scopeWhere}`).bind(dueAt,...parameters(scope)).run();
}
