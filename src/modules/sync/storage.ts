import { storeAccess, storeColumns } from '../stores/storage.ts';
import { prepareProductSyncSeed } from '../products/sync-seed.ts';
import { prepareFbsSyncSeed } from '../orders/sync-seed.ts';
import type { StoreActor, StoreRecord } from '../stores/storage.ts';
import type { StoreCoordinatorRecord, StoreSyncRecord, SyncCursor, SyncLease, SyncPage, SyncScope, SyncSource, SyncSourceRecord, SyncSQL } from './types.ts';

const nowSQL = "CAST(unixepoch('subsecond') * 1000 AS INTEGER)";
const stateColumns = `store.organization_id AS orgId,store.id AS storeId,? AS source,COALESCE(authority.enabled,0) AS enabled,
  COALESCE(authority.epoch,0) AS epoch,COALESCE(coordinator.fence,0) AS fence,authority.credential_version AS credentialVersion,
  MAX(COALESCE(authority.due_at,0),COALESCE(coordinator.blocked_until,0)) AS dueAt,authority.last_success_at AS lastSuccessAt,authority.last_error AS lastError,
  COALESCE(authority.failures,0) AS failures,authority.last_attempt_at AS lastAttemptAt,
  CASE WHEN coordinator.lease_source=authority.source THEN coordinator.lease_until ELSE NULL END AS leaseUntil,coordinator.blocked_until AS blockedUntil,
  (SELECT count(*) FROM conversation WHERE conversation.store_id=store.id) AS conversationCount,
  (SELECT count(*) FROM message WHERE message.store_id=store.id) AS messageCount`;
const stateFrom = `FROM store LEFT JOIN store_coordinator AS coordinator ON coordinator.store_id=store.id
  LEFT JOIN store_sync_source AS authority ON authority.store_id=store.id AND authority.source=?`;
const validSource = `authority.enabled=1 AND store.status NOT IN ('paused','disconnected') AND store.credential_version=authority.credential_version`;
function sourceValue(source: SyncSource) { if (source!=='chat' && source!=='products' && source!=='fbs_postings') throw new Error('INVALID_SYNC_SOURCE'); return source; }
function state(row: StoreSyncRecord | null): StoreSyncRecord | null { return row ? {...row,enabled:!!row.enabled} : null; }
async function readState(db:D1Database,scope:SyncScope,source:SyncSource) {
  return state(await db.prepare(`SELECT ${stateColumns} ${stateFrom} WHERE store.id=? AND store.organization_id=?`)
    .bind(source,source,scope.storeId,scope.orgId).first<StoreSyncRecord>());
}
export async function getSyncSource(db:D1Database,actor:StoreActor,storeId:string,source:SyncSource):Promise<SyncSourceRecord|null> {
  sourceValue(source);
  return state(await db.prepare(`SELECT ${stateColumns} ${stateFrom} WHERE store.id=? AND store.organization_id=? AND ${storeAccess('store.organization_id',false)}`)
    .bind(source,source,storeId,actor.orgId,actor.actorUserId,actor.sessionId).first<StoreSyncRecord>());
}
export async function getStoreSync(db:D1Database,actor:StoreActor,storeId:string):Promise<StoreSyncRecord|null> {
  return await getSyncSource(db,actor,storeId,'chat') as StoreSyncRecord|null;
}
export function syncPageCondition(lease:SyncScope,token:string):SyncSQL {
  return {sql:'EXISTS (SELECT 1 FROM store_coordinator WHERE store_id=? AND organization_id=? AND commit_token=?)',values:[lease.storeId,lease.orgId,token]};
}
export function syncLeaseCondition(lease:SyncLease):SyncSQL {
  sourceValue(lease.source);
  return {sql:`EXISTS (SELECT 1 FROM store_coordinator AS held JOIN store_sync_source AS authority
    ON authority.store_id=held.store_id AND authority.organization_id=held.organization_id AND authority.source=held.lease_source
    JOIN store ON store.id=held.store_id AND store.organization_id=held.organization_id
    WHERE held.store_id=? AND held.organization_id=? AND authority.source=? AND authority.epoch=? AND held.fence=?
      AND held.lease_token=? AND held.lease_until>${nowSQL} AND ${validSource} AND store.revision=? AND store.credential_version=?)`,
    values:[lease.storeId,lease.orgId,lease.source,lease.epoch,lease.fence,lease.token,lease.storeRevision,lease.credentialVersion]};
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
  const capability=source==='chat'?'chats_read':source==='products'?'products_read':'orders_fbs_read';
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
export async function getStoreCoordinatorRuntime(db:D1Database,scope:SyncScope):Promise<StoreCoordinatorRecord|null> {
  return db.prepare(`SELECT store.organization_id AS orgId,store.id AS storeId,MAX(MIN(authority.due_at),COALESCE(coordinator.blocked_until,0)) AS dueAt,
    coordinator.lease_until AS leaseUntil,coordinator.blocked_until AS blockedUntil FROM store JOIN store_coordinator AS coordinator ON coordinator.store_id=store.id
    JOIN store_sync_source AS authority ON authority.store_id=store.id WHERE store.id=? AND store.organization_id=? AND ${validSource}
    GROUP BY store.id`).bind(scope.storeId,scope.orgId).first<StoreCoordinatorRecord>();
}
export async function claimSyncLease(db:D1Database,scope:SyncScope & {source?:SyncSource;token:string;leaseMs?:number}):Promise<SyncLease|null> {
  if(scope.source)sourceValue(scope.source);
  const duration=Math.max(1_000,Math.min(scope.leaseMs??20_000,60_000)),marker=crypto.randomUUID();
  const candidate=`SELECT authority.source FROM store_sync_source AS authority JOIN store ON store.id=authority.store_id
    WHERE authority.store_id=store_coordinator.store_id AND authority.organization_id=store_coordinator.organization_id
      AND ${validSource} AND authority.due_at<=${nowSQL} AND (? IS NULL OR authority.source=?)
    ORDER BY COALESCE(authority.last_attempt_at,-1),authority.due_at,authority.source LIMIT 1`;
  const wanted=scope.source??null;
  const results=await db.batch([
    db.prepare(`UPDATE store_coordinator SET fence=fence+1,lease_source=(${candidate}),lease_token=?,lease_until=${nowSQL}+?,commit_token=?
      WHERE store_id=? AND organization_id=? AND (blocked_until IS NULL OR blocked_until<=${nowSQL})
      AND (lease_until IS NULL OR lease_until<=${nowSQL}) AND EXISTS (${candidate})`)
      .bind(wanted,wanted,scope.token,duration,marker,scope.storeId,scope.orgId,wanted,wanted),
    db.prepare(`UPDATE store_sync_source SET last_attempt_at=${nowSQL} WHERE store_id=? AND organization_id=? AND source=(
      SELECT lease_source FROM store_coordinator WHERE store_id=? AND organization_id=? AND commit_token=?)`).bind(scope.storeId,scope.orgId,scope.storeId,scope.orgId,marker),
    db.prepare(`SELECT coordinator.organization_id AS orgId,coordinator.store_id AS storeId,coordinator.lease_source AS source,authority.epoch,
      coordinator.fence,coordinator.lease_token AS token,store.revision AS storeRevision,store.credential_version AS credentialVersion
      FROM store_coordinator AS coordinator JOIN store_sync_source AS authority ON authority.store_id=coordinator.store_id AND authority.source=coordinator.lease_source
      JOIN store ON store.id=coordinator.store_id WHERE coordinator.store_id=? AND coordinator.organization_id=? AND coordinator.commit_token=?`)
      .bind(scope.storeId,scope.orgId,marker),
    db.prepare('UPDATE store_coordinator SET commit_token=NULL WHERE store_id=? AND organization_id=? AND commit_token=?').bind(scope.storeId,scope.orgId,marker),
  ]);
  return results[2]!.results[0] as unknown as SyncLease ?? null;
}
export async function getDueSyncCursor(db:D1Database,lease:SyncLease):Promise<SyncCursor|null> {
  if(lease.source!=='chat')return null;
  const live=syncLeaseCondition(lease);
  const row=await db.prepare(`SELECT store_id AS storeId,thread_id AS threadId,stream,cursor,recent_cursors AS recentCursors,revision,due_at AS dueAt,completed
    FROM sync_cursor WHERE store_id=? AND organization_id=? AND completed=0 AND due_at<=${nowSQL} AND ${live.sql}
    ORDER BY CASE WHEN stream='discovery' THEN 0 ELSE 1 END,due_at,stream,thread_id LIMIT 1`)
    .bind(lease.storeId,lease.orgId,...live.values).first<Omit<SyncCursor,'recentCursors'> & {recentCursors:string}>();
  return row?{...row,completed:!!row.completed,recentCursors:JSON.parse(row.recentCursors) as string[]}:null;
}

export async function commitSyncPage(db: D1Database, lease: SyncLease, page: SyncPage) {
  if(lease.source!=='chat')throw new Error('INVALID_SYNC_SOURCE');
  const chats = page.chats ?? [], messages = page.messages ?? [], seeds = page.seeds ?? [];
  if (page.cursor.storeId!==lease.storeId || chats.length>100 || messages.length>100 || seeds.length>200
    || messages.some(message=>typeof message.platformMessageId!=='string' || message.platformThreadId!==page.cursor.threadId)
    || (page.cursor.stream==='discovery' && messages.length>0)
    || (page.cursor.stream!=='discovery' && (chats.length>0 || seeds.length>0))
    || (page.bootstrapSnapshot && (page.cursor.stream!=='incremental' || page.cursor.cursor!==null || page.completed || page.continuing
      || messages.some(message=>message.liveObserved) || page.nextCursor!==(messages[0]?.platformMessageId ?? null)))
    || (page.restartBackfill && (!page.bootstrapSnapshot || !page.restartBackfill.cursor || page.restartBackfill.cursor!==messages.at(-1)?.platformMessageId))
    || seeds.some(seed=>!chats.some(chat=>chat.platformThreadId===seed.threadId))
    || chats.some(chat=>typeof chat.platformThreadId!=='string')) throw new Error('INVALID_SYNC_PAGE');
  if (new TextEncoder().encode(JSON.stringify(page)).length>1_048_576) throw new Error('SYNC_PAGE_TOO_LARGE');
  const current = await db.prepare('SELECT cursor,recent_cursors AS recentCursors FROM sync_cursor WHERE store_id=? AND organization_id=? AND thread_id=? AND stream=? AND revision=?')
    .bind(lease.storeId,lease.orgId,page.cursor.threadId,page.cursor.stream,page.cursor.revision).first<{cursor:string|null;recentCursors:string}>();
  if (!current) return null;
  if (page.bootstrapSnapshot && current.cursor!==null) throw new Error('INVALID_SYNC_PAGE');
  const ingestMode = page.bootstrapSnapshot ? 'backfill' : page.cursor.stream;
  const recent = JSON.parse(current.recentCursors) as string[];
  if (page.continuing && (page.nextCursor===null || page.nextCursor===current.cursor)
    || page.nextCursor!==null && page.nextCursor!==current.cursor && recent.includes(page.nextCursor)) throw new Error('cursor_stalled');
  const history = page.continuing && page.nextCursor!==null ? [...recent,...(current.cursor===null ? [] : [current.cursor])].slice(-8) : [];
  const token = crypto.randomUUID();
  const condition=syncPageCondition(lease,token),accepted=condition.sql,acceptedValues=condition.values;
  const chatJSON = JSON.stringify(chats.map(chat=>({...chat,id:crypto.randomUUID()})));
  const messageJSON = JSON.stringify(messages.map(message=>({...message,id:crypto.randomUUID()})));
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
    db.prepare(`INSERT INTO message (id,organization_id,store_id,conversation_id,platform_message_id,sender_id,sender_type,direction,content,is_image,is_read,order_number,sku,event_at,received_at,ingest_mode)
      SELECT json_extract(item.value,'$.id'),?,?,conversation.id,json_extract(item.value,'$.platformMessageId'),json_extract(item.value,'$.senderId'),
        json_extract(item.value,'$.senderType'),json_extract(item.value,'$.direction'),json_extract(item.value,'$.content'),json_extract(item.value,'$.isImage'),
        json_extract(item.value,'$.isRead'),json_extract(item.value,'$.orderNumber'),json_extract(item.value,'$.sku'),json_extract(item.value,'$.eventAt'),${nowSQL},?
      FROM json_each(?) AS item JOIN conversation ON conversation.store_id=? AND conversation.organization_id=? AND conversation.channel_type='private'
        AND conversation.platform_thread_id=json_extract(item.value,'$.platformThreadId') WHERE ${accepted} ON CONFLICT DO NOTHING`)
      .bind(lease.orgId,lease.storeId,ingestMode,messageJSON,lease.storeId,lease.orgId,...acceptedValues),
    db.prepare(`INSERT INTO ingest_event (id,schema_version,organization_id,store_id,conversation_id,message_id,state,live_observed_at,trace_id,created_at)
      SELECT message.id,1,message.organization_id,message.store_id,message.conversation_id,message.id,
        CASE WHEN json_extract(item.value,'$.liveObserved')=1 AND ?='incremental' AND message.platform_message_id IS NOT ? AND message.direction='inbound' THEN 'pending'
          WHEN message.ingest_mode='backfill' THEN 'historical' ELSE 'observed' END,
        CASE WHEN json_extract(item.value,'$.liveObserved')=1 AND ?='incremental' AND message.platform_message_id IS NOT ? THEN ${nowSQL} ELSE NULL END,?,${nowSQL}
      FROM json_each(?) AS item JOIN conversation ON conversation.store_id=? AND conversation.organization_id=?
        AND conversation.platform_thread_id=json_extract(item.value,'$.platformThreadId')
      JOIN message ON message.conversation_id=conversation.id AND message.platform_message_id=json_extract(item.value,'$.platformMessageId')
      WHERE ${accepted} ON CONFLICT(message_id) DO UPDATE SET
        state=CASE WHEN ingest_event.state='historical' AND excluded.state='pending' AND excluded.live_observed_at IS NOT NULL THEN 'pending' ELSE ingest_event.state END,
        live_observed_at=COALESCE(ingest_event.live_observed_at,excluded.live_observed_at)`)
      .bind(ingestMode,page.cursor.cursor,ingestMode,page.cursor.cursor,token,messageJSON,lease.storeId,lease.orgId,...acceptedValues),
    db.prepare(`UPDATE conversation SET last_message_at=(SELECT MAX(event_at) FROM message WHERE message.conversation_id=conversation.id)
      WHERE store_id=? AND id IN (SELECT conversation_id FROM message WHERE store_id=? AND platform_message_id IN (SELECT json_extract(value,'$.platformMessageId') FROM json_each(?)))
      AND ${accepted}`).bind(lease.storeId,lease.storeId,messageJSON,...acceptedValues),
    db.prepare(`INSERT INTO sync_cursor (organization_id,store_id,thread_id,stream,conversation_id,cursor,revision,due_at,completed)
      SELECT ?,?,json_extract(item.value,'$.threadId'),json_extract(item.value,'$.stream'),conversation.id,json_extract(item.value,'$.cursor'),0,
        json_extract(item.value,'$.dueAt'),COALESCE(json_extract(item.value,'$.completed'),0)
      FROM json_each(?) AS item JOIN conversation ON conversation.store_id=? AND conversation.organization_id=?
        AND conversation.platform_thread_id=json_extract(item.value,'$.threadId') WHERE ${accepted} ON CONFLICT DO NOTHING`)
      .bind(lease.orgId,lease.storeId,JSON.stringify(seeds),lease.storeId,lease.orgId,...acceptedValues),
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
  const blocked=input.blockedUntil===undefined?null:Math.max(0,Math.min(8_640_000_000_000_000,input.blockedUntil));
  const due=Math.max(0,Math.min(8_640_000_000_000_000,input.nextDueAt)),token=crypto.randomUUID(),accepted=syncPageCondition(lease,token);
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
export async function listDueSyncStores(db:D1Database,limit=50):Promise<SyncScope[]> {
  const rows=await db.prepare(`SELECT store.organization_id AS orgId,store.id AS storeId FROM store
    JOIN store_coordinator AS coordinator ON coordinator.store_id=store.id JOIN store_sync_source AS authority ON authority.store_id=store.id
    WHERE ${validSource} AND authority.due_at<=${nowSQL} AND (coordinator.blocked_until IS NULL OR coordinator.blocked_until<=${nowSQL})
      AND (coordinator.lease_until IS NULL OR coordinator.lease_until<=${nowSQL}) GROUP BY store.id ORDER BY MIN(authority.due_at),store.id LIMIT ?`)
    .bind(Math.max(1,Math.min(limit,100))).all<SyncScope>();
  return rows.results;
}

export async function getStoreSendCooldown(db:D1Database,scope:SyncScope):Promise<{status:string;blockedUntil:number|null}|null> {
  return db.prepare(`SELECT store.status,coordinator.blocked_until AS blockedUntil FROM store
    LEFT JOIN store_coordinator AS coordinator ON coordinator.store_id=store.id AND coordinator.organization_id=store.organization_id
    WHERE store.id=? AND store.organization_id=?`).bind(scope.storeId,scope.orgId).first();
}
export async function recordStoreSendCooldown(db:D1Database,scope:SyncScope,until:number):Promise<boolean> {
  if(!Number.isSafeInteger(until)||until<0||until>8_640_000_000_000_000)throw new Error('Invalid send cooldown.');
  const row=await db.prepare(`INSERT INTO store_coordinator(store_id,organization_id,blocked_until)
    SELECT id,organization_id,? FROM store WHERE id=? AND organization_id=?
    ON CONFLICT(store_id) DO UPDATE SET blocked_until=MAX(COALESCE(store_coordinator.blocked_until,0),excluded.blocked_until)
    WHERE store_coordinator.organization_id=excluded.organization_id RETURNING store_id`)
    .bind(until,scope.storeId,scope.orgId).first();
  return !!row;
}
