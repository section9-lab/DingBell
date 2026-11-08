import { sqlHasRole, sqlManagesCompany, NOW_MS } from '../../platform/database/sql.ts';
import { MAX_TIMESTAMP_MS } from '../../shared/time.ts';
import * as v from 'valibot';
import {noPushMessageReview} from '../ozon-push/barrier.ts';
import { storeColumns, type StoreRecord } from '../stores/storage.ts';
import { replySnapshotSchema } from './reply-state.ts';
import type { ControlScope } from './control-types.ts';
import type { ReplySnapshot } from './reply-types.ts';

const identifier=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const timestamp=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(MAX_TIMESTAMP_MS));
const scopeSchema=v.strictObject({organizationId:identifier,storeId:identifier,conversationId:identifier,controllerId:identifier});
function parameters(scope:ControlScope){if(!v.is(scopeSchema,scope))throw new RangeError('INVALID_REPLY_SCOPE');return [scope.controllerId,scope.organizationId,scope.storeId,scope.conversationId];}
export interface ReplyDispatchContext { store:StoreRecord;outboundEnabled:boolean;platformThreadId:string;platformType:string;replyAvailable:boolean }
export async function readReplyDispatchContext(db:D1Database,scope:ControlScope,actorUserId:string,actorMemberId:string):Promise<ReplyDispatchContext|null>{
  const bound=parameters(scope);
  if(!v.is(identifier,actorUserId)||!v.is(identifier,actorMemberId))throw new RangeError('INVALID_REPLY_ACTOR');
  const row=await db.prepare(`SELECT ${storeColumns},conversation.platform_thread_id AS platformThreadId,conversation.platform_type AS platformType,
    CASE WHEN store.expires_at>${NOW_MS} AND store.outbound_enabled=1 AND
      EXISTS (SELECT 1 FROM json_each(store.capabilities)
        WHERE json_extract(value,'$.code')='auth' AND json_extract(value,'$.status')='available') THEN 1 ELSE 0 END AS replyAvailable
    FROM conversation_control AS control JOIN conversation ON conversation.id=control.conversation_id AND conversation.organization_id=control.organization_id AND conversation.store_id=control.store_id
    JOIN store ON store.id=conversation.store_id AND store.organization_id=conversation.organization_id
    JOIN member AS actor ON actor.organization_id=store.organization_id AND actor.user_id=? AND actor.id=?
    JOIN user AS caller ON caller.id=actor.user_id
    WHERE control.controller_id=? AND control.organization_id=? AND control.store_id=? AND control.conversation_id=? AND caller.email_verified=1
      AND (${sqlManagesCompany('actor.role')} OR (${sqlHasRole('actor.role','member')} AND EXISTS (SELECT 1 FROM store_grant AS permission
        WHERE permission.organization_id=store.organization_id AND permission.store_id=store.id AND permission.member_id=actor.id)))`)
    .bind(actorUserId,actorMemberId,...bound).first<StoreRecord & {outboundEnabled:number;platformThreadId:string;platformType:string;replyAvailable:number}>();
  if(!row)return null;
  const {platformThreadId,platformType,replyAvailable,...store}=row;
  return {store,outboundEnabled:row.outboundEnabled===1,platformThreadId,platformType,replyAvailable:replyAvailable===1};
}
// This reads the channel only; an AI run still needs its separate, current authority review.
export async function readAiReplyDispatchContext(db:D1Database,scope:ControlScope):Promise<ReplyDispatchContext|null>{
  const row=await db.prepare(`SELECT ${storeColumns},conversation.platform_thread_id AS platformThreadId,conversation.platform_type AS platformType,
    CASE WHEN store.expires_at>${NOW_MS} AND store.outbound_enabled=1 AND ${noPushMessageReview('conversation')} AND
      EXISTS (SELECT 1 FROM json_each(store.capabilities)
        WHERE json_extract(value,'$.code')='auth' AND json_extract(value,'$.status')='available') THEN 1 ELSE 0 END AS replyAvailable
    FROM conversation_control AS control JOIN conversation ON conversation.id=control.conversation_id AND conversation.organization_id=control.organization_id AND conversation.store_id=control.store_id
    JOIN store ON store.id=conversation.store_id AND store.organization_id=conversation.organization_id
    WHERE control.controller_id=? AND control.organization_id=? AND control.store_id=? AND control.conversation_id=?`)
    .bind(...parameters(scope)).first<StoreRecord & {outboundEnabled:number;platformThreadId:string;platformType:string;replyAvailable:number}>();
  if(!row)return null;
  const {platformThreadId,platformType,replyAvailable,...store}=row;
  return {store,outboundEnabled:row.outboundEnabled===1,platformThreadId,platformType,replyAvailable:replyAvailable===1};
}
export async function projectReplyEvents(db:D1Database,scope:ControlScope,snapshots:ReplySnapshot[],now:number):Promise<void>{
  const bound=parameters(scope);
  if(!v.is(timestamp,now)||!Array.isArray(snapshots)||snapshots.length>20)throw new RangeError('INVALID_REPLY_BATCH');
  const statements:D1PreparedStatement[]=[];
  for(const snapshot of snapshots){
    const parsed=v.safeParse(replySnapshotSchema,snapshot);if(!parsed.success)throw new RangeError('INVALID_REPLY_SNAPSHOT');
    const {intent,attempt}=parsed.output;
    statements.push(db.prepare(`INSERT INTO send_intent(controller_id,organization_id,store_id,conversation_id,id,schema_version,command_id,actor_user_id,actor_member_id,ai_run_id,body,body_hash,platform_thread_id,credential_version,control_epoch,state,revision,created_at,updated_at,due_at,last_error,projected_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(controller_id,id) DO UPDATE SET
      state=excluded.state,revision=excluded.revision,updated_at=excluded.updated_at,due_at=excluded.due_at,last_error=excluded.last_error,projected_at=excluded.projected_at
      WHERE excluded.revision>send_intent.revision`).bind(...bound,intent.id,intent.schemaVersion,intent.commandId,intent.actorUserId,intent.actorMemberId,intent.schemaVersion===2?intent.runId:null,intent.body,intent.bodyHash,intent.platformThreadId,intent.credentialVersion,intent.controlEpoch,intent.state,intent.revision,intent.createdAt,intent.updatedAt,intent.dueAt,intent.lastError,now));
    if(attempt)statements.push(db.prepare(`INSERT INTO send_attempt(controller_id,organization_id,store_id,conversation_id,id,intent_id,revision,state,started_at,deadline_at,finished_at,http_status,provider_result,error_code,projected_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(controller_id,id) DO UPDATE SET
      revision=excluded.revision,state=excluded.state,finished_at=excluded.finished_at,http_status=excluded.http_status,provider_result=excluded.provider_result,error_code=excluded.error_code,projected_at=excluded.projected_at
      WHERE excluded.revision>send_attempt.revision`).bind(...bound,attempt.id,attempt.intentId,intent.revision,attempt.state,attempt.startedAt,attempt.deadlineAt,attempt.finishedAt,attempt.httpStatus,attempt.providerResult,attempt.errorCode,now));
    // 平台送达成功后立即在本地时间线回显这条出站消息。platform_message_id 用
    // 'sent:' 前缀占位；聊天同步拉回同一条消息时会把真实平台 id 补到这一行，
    // 因此时间线不依赖同步回填，也不会出现重复消息。
    if(attempt?.state==='sent'&&attempt.providerResult==='success')statements.push(db.prepare(
      `INSERT INTO message (id, organization_id, store_id, conversation_id, platform_message_id,
         sender_id, sender_type, direction, content, is_image, is_read, order_number, sku,
         event_at, received_at, ingest_mode)
       VALUES (?, ?, ?, ?, ?, NULL, 'Seller', 'outbound', ?, 0, 0, NULL, NULL, ?, ?, 'incremental')
       ON CONFLICT(store_id, conversation_id, platform_message_id) DO NOTHING`)
      .bind(crypto.randomUUID(),bound[1],bound[2],bound[3],`sent:${intent.id}`,JSON.stringify([intent.body]),attempt.finishedAt??intent.createdAt,now));
  }
  if(statements.length)await db.batch(statements);
}
