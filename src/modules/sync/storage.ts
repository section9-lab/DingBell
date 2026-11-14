import { NOW_MS } from '../../platform/database/sql.ts';
import { MAX_TIMESTAMP_MS } from '../../shared/time.ts';
import {pushCoordinatorRuntime,pushJobCondition} from '../ozon-push/storage.ts';
import { storeAccess, storeColumns } from '../stores/storage.ts';
import { prepareProductSyncSeed } from '../products/sync-seed.ts';
import { prepareFbsSyncSeed, prepareFboSyncSeed,prepareFbpSyncSeed } from '../orders/sync-seed.ts';
import type { StoreActor, StoreRecord } from '../stores/storage.ts';
import type { StoreCoordinatorRecord, StoreSyncRecord, SyncCursor, SyncLease, SyncPage, SyncScope, SyncSource, SyncSourceRecord, SyncSQL } from './types.ts';

const nowSQL = NOW_MS;
const stateColumns = `store.organization_id AS orgId,store.id AS storeId,? AS source,COALESCE(authority.enabled,0) AS enabled,
  COALESCE(authority.epoch,0) AS epoch,COALESCE(coordinator.fence,0) AS fence,authority.credential_version AS credentialVersion,
  MAX(COALESCE(authority.due_at,0),COALESCE(coordinator.blocked_until,0)) AS dueAt,authority.last_success_at AS lastSuccessAt,authority.last_error AS lastError,
  COALESCE(authority.failures,0) AS failures,authority.last_attempt_at AS lastAttemptAt,
  CASE WHEN coordinator.lease_source=authority.source THEN coordinator.lease_until ELSE NULL END AS leaseUntil,coordinator.blocked_until AS blockedUntil`;
const stateFrom = `FROM store LEFT JOIN store_coordinator AS coordinator ON coordinator.store_id=store.id
  LEFT JOIN store_sync_source AS authority ON authority.store_id=store.id AND authority.source=?`;
const validSource = `authority.enabled=1 AND store.status NOT IN ('paused','disconnected') AND store.credential_version=authority.credential_version`;
function sourceValue(source: SyncSource) { if (source!=='chat' && source!=='products' && source!=='fbs_postings' && source!=='fbo_postings' && source!=='fbp_postings') throw new Error('INVALID_SYNC_SOURCE'); return source; }
function state(row: StoreSyncRecord | null): StoreSyncRecord | null { return row ? {...row,enabled:!!row.enabled,conversationCount:row.conversationCount??0,messageCount:row.messageCount??0} : null; }
/** Display-only totals. Kept out of the per-page commit path, where the scan dominated D1 reads. */
async function readCounts(db:D1Database,storeId:string,orgId:string):Promise<{conversationCount:number;messageCount:number}> {
  return await db.prepare(`SELECT (SELECT count(*) FROM conversation WHERE conversation.store_id=? AND conversation.organization_id=?) AS conversationCount,
    (SELECT count(*) FROM message WHERE message.store_id=? AND message.organization_id=?) AS messageCount`)
    .bind(storeId,orgId,storeId,orgId).first<{conversationCount:number;messageCount:number}>() ?? {conversationCount:0,messageCount:0};
}
async function readState(db:D1Database,scope:SyncScope,source:SyncSource) {
  return state(await db.prepare(`SELECT ${stateColumns} ${stateFrom} WHERE store.id=? AND store.organization_id=?`)
    .bind(source,source,scope.storeId,scope.orgId).first<StoreSyncRecord>());
}
export async function getSyncSource(db:D1Database,actor:StoreActor,storeId:string,source:SyncSource):Promise<SyncSourceRecord|null> {
  sourceValue(source);
  const current=state(await db.prepare(`SELECT ${stateColumns} ${stateFrom} WHERE store.id=? AND store.organization_id=? AND ${storeAccess('store.organization_id',false)}`)
    .bind(source,source,storeId,actor.orgId,actor.actorUserId,actor.sessionId).first<StoreSyncRecord>());
  return current ? {...current,...await readCounts(db,storeId,actor.orgId)} : null;
}
export async function getStoreSync(db:D1Database,actor:StoreActor,storeId:string):Promise<StoreSyncRecord|null> {
  return await getSyncSource(db,actor,storeId,'chat') as StoreSyncRecord|null;
}
export function syncPageCondition(lease:SyncScope,token:string):SyncSQL {
  return {sql:'EXISTS (SELECT 1 FROM store_coordinator WHERE store_id=? AND organization_id=? AND commit_token=?)',values:[lease.storeId,lease.orgId,token]};
}
export function syncLeaseCondition(lease:SyncLease):SyncSQL {
  sourceValue(lease.source);
  const push=lease.push?pushJobCondition({...lease,...lease.push}):{sql:'1',values:[]};
  return {sql:`EXISTS (SELECT 1 FROM store_coordinator AS held JOIN store_sync_source AS authority
    ON authority.store_id=held.store_id AND authority.organization_id=held.organization_id AND authority.source=held.lease_source
    JOIN store ON store.id=held.store_id AND store.organization_id=held.organization_id
    WHERE held.store_id=? AND held.organization_id=? AND authority.source=? AND authority.epoch=? AND held.fence=?
      AND held.lease_token=? AND held.lease_until>${nowSQL} AND ${validSource} AND store.revision=? AND store.credential_version=?) AND (${push.sql})`,
    values:[lease.storeId,lease.orgId,lease.source,lease.epoch,lease.fence,lease.token,lease.storeRevision,lease.credentialVersion,...push.values]};
}
export function prepareSyncPageGate(db:D1Database,lease:SyncLease,token:string,extra:SyncSQL={sql:'1',values:[]}) {
  const live=syncLeaseCondition(lease);
  return db.prepare(`UPDATE store_coordinator SET commit_token=? WHERE store_id=? AND organization_id=? AND ${live.sql} AND (${extra.sql})`)
    .bind(token,lease.storeId,lease.orgId,...live.values,...extra.values);
}
export function prepareSyncPageFinish(db:D1Database,lease:SyncLease,token:string,due:SyncSQL,options:{success?:boolean}={}):D1PreparedStatement[] {
  const accepted=syncPageCondition(lease,token);
  const success=options.success!==false;
  return [
    db.prepare(`UPDATE store_sync_source SET due_at=MAX((${due.sql}),COALESCE((SELECT blocked_until FROM store_coordinator WHERE store_id=store_sync_source.store_id),0)),
      ${success?`last_error=NULL,failures=0,last_success_at=${nowSQL},`:''}updated_at=${nowSQL}
      WHERE store_id=? AND organization_id=? AND source=? AND ${accepted.sql}`).bind(...due.values,lease.storeId,lease.orgId,lease.source,...accepted.values),
    db.prepare(`UPDATE store_coordinator SET commit_token=NULL,lease_source=NULL,lease_token=NULL,lease_until=NULL
      WHERE store_id=? AND organization_id=? AND commit_token=? RETURNING store_id`).bind(lease.storeId,lease.orgId,token),
  ];
}

export async function setSyncSourceEnabled(db:D1Database,actor:StoreActor,storeId:string,source:SyncSource,expectedEpoch:number,enabled:boolean):Promise<SyncSourceRecord|null> {
  sourceValue(source);
  const token=crypto.randomUUID(),scope={orgId:actor.orgId,storeId},accepted=syncPageCondition(scope,token);
  const capability=source==='chat'?'chats_read':source==='products'?'products_read':source==='fbs_postings'?'orders_fbs_read':source==='fbo_postings'?'orders_fbo_read':'orders_fbp_read';
  const capabilitySQL=enabled?`AND store.status IN ('verified','partial') AND store.credential_ciphertext IS NOT NULL AND store.expires_at>${nowSQL}
    AND (SELECT count(DISTINCT json_extract(value,'$.code')) FROM json_each(store.capabilities)
      WHERE json_extract(value,'$.status')='available' AND json_extract(value,'$.code') IN ('auth','${capability}'))=2`:'';
  const statements=[
    db.prepare(`INSERT INTO store_coordinator (store_id,organization_id,commit_token)
      SELECT store.id,store.organization_id,? FROM store WHERE store.id=? AND store.organization_id=?
      AND COALESCE((SELECT epoch FROM store_sync_source WHERE store_id=store.id AND source=?),0)=?
      AND ${storeAccess('store.organization_id')} ${capabilitySQL}
      ON CONFLICT(store_id) DO UPDATE SET commit_token=excluded.commit_token`).bind(token,storeId,actor.orgId,source,expectedEpoch,actor.actorUserId,actor.sessionId),
    db.prepare(`INSERT INTO store_sync_source (store_id,organization_id,source,enabled,epoch,credential_version,due_at,updated_at)
      SELECT store.id,store.organization_id,?,?,?,store.credential_version,MAX(${nowSQL},COALESCE(coordinator.blocked_until,0)),${nowSQL}
      FROM store JOIN store_coordinator AS coordinator ON coordinator.store_id=store.id WHERE store.id=? AND ${accepted.sql}
      ON CONFLICT(store_id,source) DO UPDATE SET enabled=excluded.enabled,epoch=excluded.epoch,credential_version=excluded.credential_version,
        due_at=excluded.due_at,last_error=NULL,failures=0,updated_at=excluded.updated_at`)
      .bind(source,enabled?1:0,expectedEpoch+1,storeId,...accepted.values),
    db.prepare(`UPDATE store_coordinator SET fence=fence+CASE WHEN lease_source=? THEN 1 ELSE 0 END,
      lease_token=CASE WHEN lease_source=? THEN NULL ELSE lease_token END,lease_until=CASE WHEN lease_source=? THEN NULL ELSE lease_until END,
      lease_source=CASE WHEN lease_source=? THEN NULL ELSE lease_source END WHERE store_id=? AND organization_id=? AND commit_token=?`)
      .bind(source,source,source,source,storeId,actor.orgId,token),
  ];
  if(enabled && source==='chat') statements.push(db.prepare(`INSERT INTO sync_cursor (organization_id,store_id,thread_id,stream,cursor,revision,due_at,completed)
    SELECT organization_id,store_id,'','discovery',NULL,0,${nowSQL},0 FROM store_sync_source WHERE store_id=? AND source='chat' AND ${accepted.sql}
    ON CONFLICT DO NOTHING`).bind(storeId,...accepted.values));
  if(enabled && source==='products') statements.push(...prepareProductSyncSeed(db,scope,expectedEpoch+1,accepted));
  if(enabled && source==='fbs_postings') statements.push(...prepareFbsSyncSeed(db,scope,expectedEpoch+1,accepted));
  if(enabled && source==='fbo_postings') statements.push(...prepareFboSyncSeed(db,scope,expectedEpoch+1,accepted));
  if(enabled && source==='fbp_postings') statements.push(...prepareFbpSyncSeed(db,scope,expectedEpoch+1,accepted));
  statements.push(db.prepare(`SELECT ${stateColumns} ${stateFrom} WHERE store.id=? AND store.organization_id=? AND coordinator.commit_token=?`)
    .bind(source,source,storeId,actor.orgId,token));
  statements.push(db.prepare('UPDATE store_coordinator SET commit_token=NULL WHERE store_id=? AND organization_id=? AND commit_token=?').bind(storeId,actor.orgId,token));
  const results=await db.batch(statements);
  return state(results.at(-2)!.results[0] as unknown as StoreSyncRecord ?? null);
}
export async function setStoreSyncEnabled(db:D1Database,actor:StoreActor,storeId:string,expectedEpoch:number,enabled:boolean):Promise<StoreSyncRecord|null> {
  return await setSyncSourceEnabled(db,actor,storeId,'chat',expectedEpoch,enabled) as StoreSyncRecord|null;
}
export async function getSyncRuntime(db:D1Database,scope:SyncScope,source:SyncSource='chat'):Promise<{state:SyncSourceRecord;store:StoreRecord}|null> {
  sourceValue(source);
  const store=await db.prepare(`SELECT ${storeColumns} FROM store JOIN store_sync_source AS authority ON authority.store_id=store.id
    WHERE store.id=? AND store.organization_id=? AND authority.source=? AND ${validSource}`).bind(scope.storeId,scope.orgId,source).first<StoreRecord>();
  if(!store)return null;
  const current=await readState(db,scope,source);
  return current?.enabled?{state:current,store}:null;
}
/**
 * Stores that still need a periodic discovery wake-up: an enabled source is due and the store has
 * no Push cutover. The coordinator itself refuses to poll after a cutover, so this only restores
 * discovery for stores that never configured Push.
 */
export function listStoresAwaitingDiscovery(db:D1Database,limit:number) {
  return db.prepare(`SELECT DISTINCT authority.organization_id AS orgId,authority.store_id AS storeId
    FROM store_sync_source AS authority
    JOIN store ON store.id=authority.store_id AND store.organization_id=authority.organization_id
    JOIN store_coordinator AS coordinator ON coordinator.store_id=authority.store_id AND coordinator.organization_id=authority.organization_id
    WHERE ${validSource} AND authority.due_at<=${nowSQL}
      AND (coordinator.blocked_until IS NULL OR coordinator.blocked_until<=${nowSQL})
      AND (coordinator.lease_until IS NULL OR coordinator.lease_until<=${nowSQL})
      AND NOT EXISTS(SELECT 1 FROM store_push_endpoint WHERE store_id=authority.store_id AND organization_id=authority.organization_id AND cutover_at IS NOT NULL)
    ORDER BY authority.due_at LIMIT ?`).bind(limit).all<SyncScope>();
}

export async function getStoreCoordinatorRuntime(db:D1Database,scope:SyncScope):Promise<StoreCoordinatorRecord|null> {
  const push=await pushCoordinatorRuntime(db,scope);if(push.handled)return push.runtime;
  return db.prepare(`SELECT store.organization_id AS orgId,store.id AS storeId,MAX(MIN(authority.due_at),COALESCE(coordinator.blocked_until,0)) AS dueAt,
    coordinator.lease_until AS leaseUntil,coordinator.blocked_until AS blockedUntil FROM store JOIN store_coordinator AS coordinator ON coordinator.store_id=store.id
    JOIN store_sync_source AS authority ON authority.store_id=store.id WHERE store.id=? AND store.organization_id=? AND ${validSource}
    GROUP BY store.id`).bind(scope.storeId,scope.orgId).first<StoreCoordinatorRecord>();
}
export async function claimSyncLease(db:D1Database,scope:SyncScope & {source?:SyncSource;token:string;leaseMs?:number;push?:SyncLease['push']}):Promise<SyncLease|null> {
  if(scope.source)sourceValue(scope.source);
  const duration=Math.max(1_000,Math.min(scope.leaseMs??20_000,60_000)),marker=crypto.randomUUID();
  const gate=scope.push?pushJobCondition({...scope,...scope.push}):{sql:'NOT EXISTS(SELECT 1 FROM store_push_endpoint WHERE store_id=store_coordinator.store_id AND cutover_at IS NOT NULL)',values:[]};
  const candidate=`SELECT authority.source FROM store_sync_source AS authority JOIN store ON store.id=authority.store_id
    WHERE authority.store_id=store_coordinator.store_id AND authority.organization_id=store_coordinator.organization_id
      AND ${validSource} AND (?=1 OR authority.due_at<=${nowSQL}) AND (? IS NULL OR authority.source=?) AND (${gate.sql})
    ORDER BY COALESCE(authority.last_attempt_at,-1),authority.due_at,authority.source LIMIT 1`;
  const wanted=scope.source??null;
  const results=await db.batch([
    db.prepare(`UPDATE store_coordinator SET fence=fence+1,lease_source=(${candidate}),lease_token=?,lease_until=${nowSQL}+?,commit_token=?
      WHERE store_id=? AND organization_id=? AND (blocked_until IS NULL OR blocked_until<=${nowSQL})
      AND (lease_until IS NULL OR lease_until<=${nowSQL}) AND EXISTS (${candidate})`)
      .bind(scope.push?1:0,wanted,wanted,...gate.values,scope.token,duration,marker,scope.storeId,scope.orgId,scope.push?1:0,wanted,wanted,...gate.values),
    db.prepare(`UPDATE store_sync_source SET last_attempt_at=${nowSQL} WHERE store_id=? AND organization_id=? AND source=(
      SELECT lease_source FROM store_coordinator WHERE store_id=? AND organization_id=? AND commit_token=?)`).bind(scope.storeId,scope.orgId,scope.storeId,scope.orgId,marker),
    db.prepare(`SELECT coordinator.organization_id AS orgId,coordinator.store_id AS storeId,coordinator.lease_source AS source,authority.epoch,
      coordinator.fence,coordinator.lease_token AS token,store.revision AS storeRevision,store.credential_version AS credentialVersion
      FROM store_coordinator AS coordinator JOIN store_sync_source AS authority ON authority.store_id=coordinator.store_id AND authority.source=coordinator.lease_source
      JOIN store ON store.id=coordinator.store_id WHERE coordinator.store_id=? AND coordinator.organization_id=? AND coordinator.commit_token=?`)
      .bind(scope.storeId,scope.orgId,marker),
    db.prepare('UPDATE store_coordinator SET commit_token=NULL WHERE store_id=? AND organization_id=? AND commit_token=?').bind(scope.storeId,scope.orgId,marker),
  ]);
  const lease=results[2]!.results[0] as unknown as SyncLease|undefined;
  return lease?{...lease,...(scope.push?{push:scope.push}:{})}:null;
}
export async function getDueSyncCursor(db:D1Database,lease:SyncLease):Promise<SyncCursor|null> {
  if(lease.source!=='chat')return null;
  const live=syncLeaseCondition(lease);
  const row=await db.prepare(`SELECT store_id AS storeId,thread_id AS threadId,stream,cursor,recent_cursors AS recentCursors,revision,due_at AS dueAt,completed
    FROM sync_cursor WHERE store_id=? AND organization_id=? AND completed=0 AND due_at<=${nowSQL} AND ${live.sql}
    ORDER BY CASE WHEN stream='discovery' THEN 0 WHEN stream='backfill' THEN 1 ELSE 2 END,
      CASE WHEN stream='incremental' AND EXISTS (SELECT 1 FROM conversation AS current WHERE current.id=sync_cursor.conversation_id AND current.last_message_id IS NOT sync_cursor.cursor) THEN 0 ELSE 1 END,
      due_at,stream,thread_id LIMIT 1`)
    .bind(lease.storeId,lease.orgId,...live.values).first<Omit<SyncCursor,'recentCursors'> & {recentCursors:string}>();
  return row?{...row,completed:!!row.completed,recentCursors:JSON.parse(row.recentCursors) as string[]}:null;
}

export async function commitSyncPage(db: D1Database, lease: SyncLease, page: SyncPage) {
  if(lease.source!=='chat')throw new Error('INVALID_SYNC_SOURCE');
  const chats = page.chats ?? [], messages = page.messages ?? [], seeds = page.seeds ?? [];
  if (page.cursor.storeId!==lease.storeId || chats.length>100 || messages.length>100 || seeds.length>200
    || messages.some(message=>typeof message.platformMessageId!=='string' || message.platformThreadId!==page.cursor.threadId)
    || (page.canonicalHead!==undefined&&page.canonicalHead!==null&&!messages.some(message=>message.platformMessageId===page.canonicalHead))
    || (page.ingestAsHistory&&(!lease.push||messages.some(message=>message.liveObserved)))
    || (page.cursor.stream==='discovery' && messages.length>0)
    || (page.cursor.stream!=='discovery' && (chats.length>0 || seeds.length>0))
    || (page.bootstrapSnapshot && (page.cursor.stream!=='incremental' || page.cursor.cursor!==null || page.completed || page.continuing
      || messages.some(message=>message.liveObserved) || page.nextCursor!==(messages[0]?.platformMessageId ?? null)))
    || (page.restartBackfill && (!page.bootstrapSnapshot || !page.restartBackfill.cursor || page.restartBackfill.cursor!==messages.at(-1)?.platformMessageId))
    || seeds.some(seed=>!chats.some(chat=>chat.platformThreadId===seed.threadId))
    || chats.some(chat=>typeof chat.platformThreadId!=='string'
      || chat.unreadCount!==undefined&&(!Number.isSafeInteger(chat.unreadCount)||chat.unreadCount<0)
      || chat.firstUnreadMessageId!==undefined&&chat.firstUnreadMessageId!==null&&!/^\d+$/.test(chat.firstUnreadMessageId))) throw new Error('INVALID_SYNC_PAGE');
  if (new TextEncoder().encode(JSON.stringify(page)).length>1_048_576) throw new Error('SYNC_PAGE_TOO_LARGE');
  const current = await db.prepare('SELECT cursor,recent_cursors AS recentCursors FROM sync_cursor WHERE store_id=? AND organization_id=? AND thread_id=? AND stream=? AND revision=?')
    .bind(lease.storeId,lease.orgId,page.cursor.threadId,page.cursor.stream,page.cursor.revision).first<{cursor:string|null;recentCursors:string}>();
  if (!current) return null;
  if (page.bootstrapSnapshot && current.cursor!==null) throw new Error('INVALID_SYNC_PAGE');
  const ingestMode = page.bootstrapSnapshot||page.ingestAsHistory ? 'backfill' : page.cursor.stream;
  const recent = JSON.parse(current.recentCursors) as string[];
  if (page.continuing && (page.nextCursor===null || page.nextCursor===current.cursor)
    || page.nextCursor!==null && page.nextCursor!==current.cursor && recent.includes(page.nextCursor)) throw new Error('cursor_stalled');
  const history = page.continuing && page.nextCursor!==null ? [...recent,...(current.cursor===null ? [] : [current.cursor])].slice(-8) : [];
  const token = crypto.randomUUID();
  const condition=syncPageCondition(lease,token),accepted=condition.sql,acceptedValues=condition.values;
  const chatJSON = JSON.stringify(chats.map(chat=>({...chat,id:crypto.randomUUID()})));
  // 本工作区发出的消息已经以 'sent:' 占位 id 落库（见 reply 投影）。平台把同一条
  // 消息返回时，把真实平台 id 补到最早的匹配回显行上，而不是插入重复消息。
  // 匹配按发送时间顺序逐条配对，时间相差超过 10 分钟视为不同消息。
  let inboundMessages=messages,mergeClaims:{messageId:string;echoId:string;message:typeof messages[number]}[]=[];
  if(messages.some(message=>message.direction==='outbound')){
    const echoes=(await db.prepare(`SELECT message.id,message.content,message.event_at AS eventAt FROM message
      JOIN conversation ON conversation.id=message.conversation_id AND conversation.organization_id=message.organization_id AND conversation.store_id=message.store_id
      WHERE message.store_id=? AND message.organization_id=? AND conversation.platform_thread_id=?
        AND message.direction='outbound' AND message.platform_message_id LIKE 'sent:%'
      ORDER BY message.event_at,message.id LIMIT 100`).bind(lease.storeId,lease.orgId,page.cursor.threadId)
      .all<{id:string;eventAt:number;content:string}>()).results;
    const known=new Set((await db.prepare(`SELECT message.platform_message_id AS id FROM message JOIN conversation ON conversation.id=message.conversation_id AND conversation.store_id=message.store_id AND conversation.organization_id=message.organization_id
      WHERE message.store_id=? AND message.organization_id=? AND conversation.platform_thread_id=? AND message.platform_message_id IN (SELECT value FROM json_each(?))`).bind(lease.storeId,lease.orgId,page.cursor.threadId,JSON.stringify(messages.map(message=>message.platformMessageId))).all<{id:string}>()).results.map(row=>row.id));
    const pending=[...echoes];inboundMessages=[];mergeClaims=[];
    for(const message of [...messages].sort((left,right)=>left.eventAt-right.eventAt)){
      if(message.direction!=='outbound'||known.has(message.platformMessageId)){inboundMessages.push(message);continue;}
      const index=pending.findIndex(echo=>echo.content===JSON.stringify(message.content)&&Math.abs(echo.eventAt-message.eventAt)<=600_000);
      if(index<0){inboundMessages.push(message);continue;}
      const [echo]=pending.splice(index,1);mergeClaims.push({messageId:message.platformMessageId,echoId:echo.id,message});
    }
  }
  const messageJSON = JSON.stringify(messages.map(message=>({...message,id:crypto.randomUUID()})));
  const insertJSON = JSON.stringify(inboundMessages.map(message=>({...message,id:crypto.randomUUID()})));
  const results = await db.batch([
    // The transaction's first write is the only time-sensitive authorization gate.
    // Later statements share its unguessable token, so expiry cannot import half a page.
    prepareSyncPageGate(db,lease,token,{sql:'EXISTS (SELECT 1 FROM sync_cursor WHERE store_id=? AND organization_id=? AND thread_id=? AND stream=? AND revision=? AND completed=0)',
      values:[lease.storeId,lease.orgId,page.cursor.threadId,page.cursor.stream,page.cursor.revision]}),
    db.prepare(`INSERT INTO conversation (id,organization_id,store_id,channel_type,platform_thread_id,platform_type,platform_status,platform_created_at,last_message_id,imported_at)
      SELECT json_extract(value,'$.id'),?,?,'private',json_extract(value,'$.platformThreadId'),json_extract(value,'$.type'),json_extract(value,'$.status'),
        json_extract(value,'$.createdAt'),json_extract(value,'$.lastMessageId'),${nowSQL} FROM json_each(?) WHERE ${accepted}
      ON CONFLICT(store_id,channel_type,platform_thread_id) DO UPDATE SET platform_type=excluded.platform_type,platform_status=excluded.platform_status,last_message_id=excluded.last_message_id`)
      .bind(lease.orgId,lease.storeId,chatJSON,...acceptedValues),
    ...(chats.length ? [
        // The chat list carries the platform's unread facts. Catch local read flags up without
        // touching messages newer than the listed last message or reversing a read receipt.
        db.prepare(`UPDATE message SET is_read=1
          WHERE store_id=? AND organization_id=? AND direction IN ('inbound','unknown') AND is_read=0 AND platform_message_id NOT GLOB '*[^0-9]*'
            AND EXISTS (SELECT 1 FROM json_each(?) AS chat
              JOIN conversation AS current ON current.id=message.conversation_id AND current.store_id=message.store_id AND current.organization_id=message.organization_id
              WHERE json_extract(chat.value,'$.platformThreadId')=current.platform_thread_id
                AND ((json_extract(chat.value,'$.unreadCount')=0
                    AND (json_extract(chat.value,'$.lastMessageId') IS NULL
                      OR length(message.platform_message_id)<length(json_extract(chat.value,'$.lastMessageId'))
                      OR (length(message.platform_message_id)=length(json_extract(chat.value,'$.lastMessageId'))
                        AND message.platform_message_id<=json_extract(chat.value,'$.lastMessageId'))))
                  OR (json_extract(chat.value,'$.firstUnreadMessageId') IS NOT NULL AND json_extract(chat.value,'$.firstUnreadMessageId')<>'0'
                    AND (length(message.platform_message_id)<length(json_extract(chat.value,'$.firstUnreadMessageId'))
                      OR (length(message.platform_message_id)=length(json_extract(chat.value,'$.firstUnreadMessageId'))
                        AND message.platform_message_id<json_extract(chat.value,'$.firstUnreadMessageId'))))))
            AND ${accepted}`)
          .bind(lease.storeId,lease.orgId,chatJSON,...acceptedValues),
    ] : []),
    db.prepare(`INSERT INTO message (id,organization_id,store_id,conversation_id,platform_message_id,sender_id,sender_type,direction,content,is_image,is_read,order_number,sku,event_at,received_at,ingest_mode)
      SELECT json_extract(item.value,'$.id'),?,?,conversation.id,json_extract(item.value,'$.platformMessageId'),json_extract(item.value,'$.senderId'),
        json_extract(item.value,'$.senderType'),json_extract(item.value,'$.direction'),json_extract(item.value,'$.content'),json_extract(item.value,'$.isImage'),
        json_extract(item.value,'$.isRead'),json_extract(item.value,'$.orderNumber'),json_extract(item.value,'$.sku'),json_extract(item.value,'$.eventAt'),${nowSQL},CASE WHEN ?=1 AND COALESCE(json_extract(item.value,'$.liveObserved'),0)=0 THEN 'backfill' ELSE ? END
      FROM json_each(?) AS item JOIN conversation ON conversation.store_id=? AND conversation.organization_id=? AND conversation.channel_type='private'
        AND conversation.platform_thread_id=json_extract(item.value,'$.platformThreadId') WHERE ${accepted} ON CONFLICT DO NOTHING`)
      .bind(lease.orgId,lease.storeId,lease.push?1:0,ingestMode,insertJSON,lease.storeId,lease.orgId,...acceptedValues),
    // 把平台返回的真实消息 id 补到本地回显行上；时间、已读与正文以平台为准。
    ...mergeClaims.map(({messageId,echoId,message})=>db.prepare(
      `UPDATE message SET platform_message_id=?,sender_id=?,sender_type=?,content=?,is_image=?,is_read=?,order_number=?,sku=?,event_at=?,received_at=MAX(received_at,${nowSQL}),ingest_mode='incremental'
        WHERE id=? AND store_id=? AND organization_id=? AND platform_message_id LIKE 'sent:%' AND ${accepted}`)
      .bind(messageId,message.senderId??null,message.senderType,JSON.stringify(message.content),message.isImage?1:0,message.isRead?1:0,
        message.orderNumber??null,message.sku??null,message.eventAt,echoId,lease.storeId,lease.orgId,...acceptedValues)),
    ...(page.canonicalHead!==undefined?[db.prepare(`INSERT INTO ozon_push_chat_head(conversation_id,organization_id,store_id,message_id,push_event_id,observed_at)
      SELECT conversation.id,conversation.organization_id,conversation.store_id,(SELECT id FROM message WHERE conversation_id=conversation.id AND organization_id=conversation.organization_id AND store_id=conversation.store_id AND platform_message_id=?),?,${nowSQL}
      FROM conversation WHERE organization_id=? AND store_id=? AND platform_thread_id=? AND ${accepted}
      ON CONFLICT(conversation_id) DO UPDATE SET message_id=excluded.message_id,push_event_id=excluded.push_event_id,observed_at=excluded.observed_at`).bind(page.canonicalHead,lease.push?.id??null,lease.orgId,lease.storeId,page.cursor.threadId,...acceptedValues)]:[]),
    ...(lease.push?[
      db.prepare(`INSERT INTO ozon_push_live_message(message_id,organization_id,store_id,conversation_id,push_event_id,observed_at)
        SELECT message.id,message.organization_id,message.store_id,message.conversation_id,event.id,${nowSQL} FROM json_each(?) AS item
        JOIN conversation ON conversation.store_id=? AND conversation.organization_id=? AND conversation.platform_thread_id=json_extract(item.value,'$.platformThreadId')
        JOIN message ON message.conversation_id=conversation.id AND message.store_id=conversation.store_id AND message.organization_id=conversation.organization_id AND message.platform_message_id=json_extract(item.value,'$.platformMessageId')
        JOIN ozon_push_event AS event ON event.id=? AND event.store_id=message.store_id AND event.organization_id=message.organization_id
        JOIN store_push_endpoint AS endpoint ON endpoint.store_id=event.store_id AND endpoint.organization_id=event.organization_id
        WHERE ${accepted} AND json_extract(item.value,'$.liveObserved')=1 AND event.notification_type='TYPE_NEW_MESSAGE' AND event.simulated=0 AND event.source='chat'
          AND json_extract(event.hint,'$.messageId')=message.platform_message_id AND json_extract(event.hint,'$.chatId')=conversation.platform_thread_id
          AND message.direction='inbound' AND message.event_at>=endpoint.cutover_at AND message.event_at<=event.received_at+120000
        ON CONFLICT(message_id) DO NOTHING`).bind(messageJSON,lease.storeId,lease.orgId,lease.push.id,...acceptedValues),
      db.prepare(`UPDATE message SET ingest_mode='incremental' WHERE store_id=? AND organization_id=? AND ingest_mode='backfill'
        AND EXISTS(SELECT 1 FROM ozon_push_live_message WHERE message_id=message.id AND push_event_id=?) AND ${accepted}`).bind(lease.storeId,lease.orgId,lease.push.id,...acceptedValues),
    ]:[]),
    db.prepare(`INSERT INTO ingest_event (id,schema_version,organization_id,store_id,conversation_id,message_id,state,live_observed_at,trace_id,created_at)
      SELECT message.id,1,message.organization_id,message.store_id,message.conversation_id,message.id,
        CASE WHEN json_extract(item.value,'$.liveObserved')=1 AND ?='incremental' AND (message.platform_message_id IS NOT ? OR EXISTS(SELECT 1 FROM ozon_push_live_message WHERE message_id=message.id AND push_event_id=?)) AND message.direction='inbound' THEN 'pending'
          WHEN message.ingest_mode='backfill' THEN 'historical' ELSE 'observed' END,
        CASE WHEN json_extract(item.value,'$.liveObserved')=1 AND ?='incremental' AND (message.platform_message_id IS NOT ? OR EXISTS(SELECT 1 FROM ozon_push_live_message WHERE message_id=message.id AND push_event_id=?)) THEN ${nowSQL} ELSE NULL END,?,${nowSQL}
      FROM message JOIN conversation ON conversation.id=message.conversation_id AND conversation.store_id=message.store_id
        AND conversation.organization_id=message.organization_id AND conversation.platform_thread_id=?
      JOIN json_each(?) AS item ON json_extract(item.value,'$.platformMessageId')=message.platform_message_id
      WHERE message.store_id=? AND message.organization_id=?
        AND message.platform_message_id IN (SELECT json_extract(value,'$.platformMessageId') FROM json_each(?))
        AND ${accepted} ON CONFLICT(message_id) DO UPDATE SET
        state=CASE WHEN ingest_event.state IN ('historical','observed') AND excluded.state='pending' AND excluded.live_observed_at IS NOT NULL
          AND (ingest_event.state='historical' OR EXISTS(SELECT 1 FROM ozon_push_live_message WHERE message_id=ingest_event.message_id AND push_event_id=?)) THEN 'pending' ELSE ingest_event.state END,
        live_observed_at=COALESCE(ingest_event.live_observed_at,excluded.live_observed_at)`)
      .bind(ingestMode,page.cursor.cursor,lease.push?.id??null,ingestMode,page.cursor.cursor,lease.push?.id??null,token,page.cursor.threadId,messageJSON,lease.storeId,lease.orgId,messageJSON,...acceptedValues,lease.push?.id??null),
    ...(lease.push?[db.prepare(`UPDATE ozon_push_event SET requires_review=0 WHERE store_id=? AND organization_id=? AND requires_review=1 AND json_extract(hint,'$.chatId')=?
      AND json_extract(hint,'$.messageId') IN (SELECT json_extract(value,'$.platformMessageId') FROM json_each(?)) AND ${accepted}`).bind(lease.storeId,lease.orgId,page.cursor.threadId,messageJSON,...acceptedValues)]:[]),
    db.prepare(`UPDATE message SET is_read=(SELECT json_extract(value,'$.isRead') FROM json_each(?) WHERE json_extract(value,'$.platformMessageId')=message.platform_message_id)
      WHERE store_id=? AND organization_id=? AND conversation_id IN(SELECT id FROM conversation WHERE store_id=? AND organization_id=? AND platform_thread_id=?)
      AND platform_message_id IN(SELECT json_extract(value,'$.platformMessageId') FROM json_each(?)) AND ${accepted}
      AND is_read IS NOT (SELECT json_extract(value,'$.isRead') FROM json_each(?) WHERE json_extract(value,'$.platformMessageId')=message.platform_message_id)`)
      .bind(messageJSON,lease.storeId,lease.orgId,lease.storeId,lease.orgId,page.cursor.threadId,messageJSON,...acceptedValues,messageJSON),
    db.prepare(`UPDATE conversation SET last_message_at=(SELECT MAX(event_at) FROM message WHERE message.conversation_id=conversation.id)
      WHERE store_id=? AND id IN (SELECT conversation_id FROM message WHERE store_id=? AND platform_message_id IN (SELECT json_extract(value,'$.platformMessageId') FROM json_each(?)))
      AND ${accepted}`).bind(lease.storeId,lease.storeId,messageJSON,...acceptedValues),
    db.prepare(`INSERT INTO sync_cursor (organization_id,store_id,thread_id,stream,conversation_id,cursor,revision,due_at,completed)
      SELECT ?,?,json_extract(item.value,'$.threadId'),json_extract(item.value,'$.stream'),conversation.id,json_extract(item.value,'$.cursor'),0,
        json_extract(item.value,'$.dueAt'),COALESCE(json_extract(item.value,'$.completed'),0)
      FROM json_each(?) AS item JOIN conversation ON conversation.store_id=? AND conversation.organization_id=?
        AND conversation.platform_thread_id=json_extract(item.value,'$.threadId') WHERE ${accepted} ON CONFLICT DO NOTHING`)
      .bind(lease.orgId,lease.storeId,JSON.stringify(seeds),lease.storeId,lease.orgId,...acceptedValues),
    // The chat list states each chat's newest message id, so a chat whose newest id
    // differs from the incremental cursor has something unread: pull its next history
    // page forward to now instead of waiting for the idle sweep. Without this the
    // per-chat interval has to stay short enough for every conversation, which with a
    // few dozen chats exceeds the platform rate budget and delays genuinely new
    // messages behind the backlog.
    // Pull forward without losing priority: a chat that is already due keeps its
    // original due time, so repeated discovery cycles cannot push it behind the
    // whole backlog again.
    ...(seeds.length ? [db.prepare(`UPDATE sync_cursor SET due_at=MIN(due_at,${nowSQL})
      WHERE store_id=? AND organization_id=? AND stream='incremental' AND completed=0 AND ${accepted}
        AND EXISTS (SELECT 1 FROM conversation AS current WHERE current.id=sync_cursor.conversation_id
          AND current.last_message_id IS NOT sync_cursor.cursor)`)
      .bind(lease.storeId,lease.orgId,...acceptedValues)] : []),
    db.prepare(`INSERT INTO sync_cursor (organization_id,store_id,thread_id,stream,conversation_id,cursor,revision,due_at,completed)
      SELECT source.organization_id,source.store_id,source.thread_id,'backfill',source.conversation_id,?,0,${nowSQL}+1000,0
      FROM sync_cursor AS source WHERE source.store_id=? AND source.organization_id=? AND source.thread_id=? AND source.stream='incremental'
        AND ?=1 AND ${accepted}
      ON CONFLICT(store_id,stream,thread_id) DO UPDATE SET cursor=excluded.cursor,recent_cursors='[]',revision=sync_cursor.revision+1,due_at=excluded.due_at,completed=0`)
      .bind(page.restartBackfill?.cursor ?? null,lease.storeId,lease.orgId,page.cursor.threadId,page.restartBackfill?1:0,...acceptedValues),
    db.prepare(`UPDATE sync_cursor SET cursor=?,recent_cursors=?,revision=revision+1,due_at=?,completed=? WHERE store_id=? AND thread_id=? AND stream=? AND revision=? AND ${accepted}`)
      .bind(page.nextCursor,JSON.stringify(history),page.nextDueAt,page.completed?1:0,lease.storeId,page.cursor.threadId,page.cursor.stream,page.cursor.revision,...acceptedValues),
    ...prepareSyncPageFinish(db,lease,token,{sql:`COALESCE((SELECT MIN(due_at) FROM sync_cursor WHERE store_id=? AND organization_id=? AND completed=0),${nowSQL}+60000)`,values:[lease.storeId,lease.orgId]}),
  ]);
  return results.at(-1)!.results.length ? readState(db,lease,'chat') : null;
}


export async function finishSyncFailure(db:D1Database,lease:SyncLease,input:{code:string;nextDueAt:number;disable?:boolean;disableAll?:boolean;blockedUntil?:number}) {
  const blocked=input.blockedUntil===undefined?null:Math.max(0,Math.min(MAX_TIMESTAMP_MS,input.blockedUntil));
  const due=Math.max(0,Math.min(MAX_TIMESTAMP_MS,input.nextDueAt)),token=crypto.randomUUID(),accepted=syncPageCondition(lease,token);
  const disabled=input.disable||input.disableAll;
  const results=await db.batch([
    prepareSyncPageGate(db,lease,token),
    db.prepare(`UPDATE store_sync_source SET last_error=?,failures=failures+1,due_at=MAX(?,COALESCE(?,0),COALESCE((SELECT blocked_until FROM store_coordinator WHERE store_id=store_sync_source.store_id),0)),
      enabled=CASE WHEN ? THEN 0 ELSE enabled END,epoch=epoch+CASE WHEN ? THEN 1 ELSE 0 END,updated_at=${nowSQL}
      WHERE store_id=? AND organization_id=? AND (source=? OR ?=1) AND ${accepted.sql}`)
      .bind(input.code,due,blocked,disabled?1:0,disabled?1:0,lease.storeId,lease.orgId,lease.source,input.disableAll?1:0,...accepted.values),
    db.prepare(`UPDATE store_coordinator SET blocked_until=CASE WHEN ? IS NULL THEN blocked_until ELSE MAX(COALESCE(blocked_until,0),?) END,
      lease_source=NULL,lease_token=NULL,lease_until=NULL,commit_token=NULL WHERE store_id=? AND organization_id=? AND commit_token=? RETURNING store_id`)
      .bind(blocked,blocked,lease.storeId,lease.orgId,token),
  ]);
  return !!results.at(-1)!.results.length;
}
export async function releaseSyncLease(db:D1Database,lease:SyncLease,nextDueAt:number) {
  const token=crypto.randomUUID(),accepted=syncPageCondition(lease,token);
  const results=await db.batch([
    prepareSyncPageGate(db,lease,token),
    db.prepare(`UPDATE store_sync_source SET due_at=MAX(?,COALESCE((SELECT blocked_until FROM store_coordinator WHERE store_id=store_sync_source.store_id),0)),updated_at=${nowSQL}
      WHERE store_id=? AND organization_id=? AND source=? AND ${accepted.sql}`).bind(nextDueAt,lease.storeId,lease.orgId,lease.source,...accepted.values),
    db.prepare('UPDATE store_coordinator SET lease_source=NULL,lease_token=NULL,lease_until=NULL,commit_token=NULL WHERE store_id=? AND organization_id=? AND commit_token=? RETURNING store_id')
      .bind(lease.storeId,lease.orgId,token),
  ]);
  return !!results.at(-1)!.results.length;
}
export async function getStoreSendCooldown(db:D1Database,scope:SyncScope):Promise<{status:string;blockedUntil:number|null}|null> {
  return db.prepare(`SELECT store.status,coordinator.blocked_until AS blockedUntil FROM store
    LEFT JOIN store_coordinator AS coordinator ON coordinator.store_id=store.id AND coordinator.organization_id=store.organization_id
    WHERE store.id=? AND store.organization_id=?`).bind(scope.storeId,scope.orgId).first();
}
export async function recordStoreSendCooldown(db:D1Database,scope:SyncScope,until:number):Promise<boolean> {
  if(!Number.isSafeInteger(until)||until<0||until>MAX_TIMESTAMP_MS)throw new Error('Invalid send cooldown.');
  const row=await db.prepare(`INSERT INTO store_coordinator(store_id,organization_id,blocked_until)
    SELECT id,organization_id,? FROM store WHERE id=? AND organization_id=?
    ON CONFLICT(store_id) DO UPDATE SET blocked_until=MAX(COALESCE(store_coordinator.blocked_until,0),excluded.blocked_until)
    WHERE store_coordinator.organization_id=excluded.organization_id RETURNING store_id`)
    .bind(until,scope.storeId,scope.orgId).first();
  return !!row;
}
