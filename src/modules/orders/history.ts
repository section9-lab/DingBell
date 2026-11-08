import { NOW_MS } from '../../platform/database/sql.ts';
import type {OrderHistory,OrderHistoryCommand,PostingSource} from '../../shared/order-history.ts';
import {storeAccess,type StoreActor} from '../stores/storage.ts';
import {syncLeaseCondition,syncPageCondition} from '../sync/storage.ts';
import type {SyncLease,SyncSQL} from '../sync/types.ts';
import type {FbsListWork} from './types.ts';
const nowSQL = NOW_MS,windowMaximum=31*86400000,hour=3600000;
type HistoryRow={storeId:string;source:PostingSource;epoch:number;commandRevision:number;generation:number;revision:number;requestedFrom:number;requestedTo:number;coveredFrom:number;since:number;to:number;cursor:string|null;recentCursors:string;state:'active'|'complete'|'cancelled';dueAt:number;pagesRead:number;lastLane:'live'|'history'|'details'};
const columns='history.store_id AS storeId,history.source,history.epoch,history.command_revision AS commandRevision,history.generation,history.revision,history.requested_from AS requestedFrom,history.requested_to AS requestedTo,history.covered_from AS coveredFrom,history.since,history."to",history.cursor,history.recent_cursors AS recentCursors,history.state,history.due_at AS dueAt,history.pages_read AS pagesRead,history.last_lane AS lastLane';
function dto(row:HistoryRow):OrderHistory{return {source:row.source,commandRevision:row.commandRevision,state:row.state,requestedFrom:new Date(row.requestedFrom).toISOString(),requestedTo:new Date(row.requestedTo).toISOString(),coveredFrom:new Date(row.coveredFrom).toISOString(),windowSince:new Date(row.since).toISOString(),windowTo:new Date(row.to).toISOString(),pagesRead:row.pagesRead};}
export async function readPostingHistory(db:D1Database,actor:StoreActor,storeId:string,source:PostingSource){
 const row=await db.prepare(`SELECT ${columns} FROM posting_history_sync history JOIN store ON store.id=history.store_id AND store.organization_id=history.organization_id
 WHERE history.store_id=? AND history.organization_id=? AND history.source=? AND ${storeAccess('store.organization_id',false)}`).bind(storeId,actor.orgId,source,actor.actorUserId,actor.sessionId).first<HistoryRow>();
 return row?dto(row):null;
}
/** A manager command changes only historical work; live windows and imported facts remain intact. */
export async function changePostingHistory(db:D1Database,actor:StoreActor,storeId:string,source:PostingSource,command:OrderHistoryCommand):Promise<OrderHistory|null>{
 const table=source==='fbs_postings'?'fbs_sync_window':source==='fbo_postings'?'fbo_sync_window':'fbp_sync_window';
 const window=await db.prepare(`SELECT history_start AS start FROM ${table} WHERE store_id=? AND organization_id=?`).bind(storeId,actor.orgId).first<{start:number}>();
 if(!window)return null;
 const from=command.operation==='start'?Date.parse(command.since+'T00:00:00Z'):0;
 if(command.operation==='start'&&(!Number.isSafeInteger(from)||from<Date.UTC(2000,0,1)||from>=window.start))throw new RangeError('ORDER_HISTORY_RANGE_INVALID');
 const token=crypto.randomUUID(),accepted=syncPageCondition({orgId:actor.orgId,storeId},token),capability=source==='fbs_postings'?'orders_fbs_read':source==='fbo_postings'?'orders_fbo_read':'orders_fbp_read';
 const enabled=command.operation==='start'?`AND authority.enabled=1 AND authority.credential_version=store.credential_version AND store.status IN ('verified','partial') AND store.credential_ciphertext IS NOT NULL AND store.expires_at>${nowSQL}
 AND (SELECT COUNT(DISTINCT json_extract(value,'$.code')) FROM json_each(store.capabilities) WHERE json_extract(value,'$.status')='available' AND json_extract(value,'$.code') IN ('auth','${capability}'))=2`:'';
 const statements=[db.prepare(`UPDATE store_coordinator SET commit_token=? WHERE store_id=? AND organization_id=? AND EXISTS (
 SELECT 1 FROM store JOIN store_sync_source authority ON authority.store_id=store.id AND authority.organization_id=store.organization_id
 WHERE store.id=store_coordinator.store_id AND store.organization_id=store_coordinator.organization_id AND authority.source=? AND authority.epoch=? ${enabled}
 AND COALESCE((SELECT command_revision FROM posting_history_sync WHERE store_id=store.id AND source=?),0)=? ${command.operation==='cancel'?"AND EXISTS(SELECT 1 FROM posting_history_sync WHERE store_id=store.id AND source=authority.source)":''} AND ${storeAccess('store.organization_id')})`)
 .bind(token,storeId,actor.orgId,source,command.expectedEpoch,source,command.expectedHistoryRevision,actor.actorUserId,actor.sessionId)];
 if(command.operation==='start')statements.push(db.prepare(`INSERT INTO posting_history_sync(store_id,organization_id,source,epoch,requested_from,requested_to,covered_from,since,"to",due_at)
 SELECT ?,?,?,?,?,?,?,?,?,${nowSQL} WHERE ${accepted.sql}
 ON CONFLICT(store_id,source) DO UPDATE SET epoch=excluded.epoch,command_revision=posting_history_sync.command_revision+1,revision=posting_history_sync.revision+1,
 requested_from=MIN(posting_history_sync.requested_from,excluded.requested_from),
 since=CASE WHEN posting_history_sync.state='complete' AND excluded.requested_from<posting_history_sync.covered_from THEN MAX(excluded.requested_from,MIN(posting_history_sync.requested_to,posting_history_sync.covered_from+${hour})-${windowMaximum}) ELSE posting_history_sync.since END,
 "to"=CASE WHEN posting_history_sync.state='complete' AND excluded.requested_from<posting_history_sync.covered_from THEN MIN(posting_history_sync.requested_to,posting_history_sync.covered_from+${hour}) ELSE posting_history_sync."to" END,
 cursor=CASE WHEN posting_history_sync.state='complete' THEN NULL ELSE posting_history_sync.cursor END,
 recent_cursors=CASE WHEN posting_history_sync.state='complete' THEN '[]' ELSE posting_history_sync.recent_cursors END,
 generation=posting_history_sync.generation+CASE WHEN posting_history_sync.state='complete' AND excluded.requested_from<posting_history_sync.covered_from THEN 1 ELSE 0 END,
 state=CASE WHEN posting_history_sync.state='complete' AND excluded.requested_from>=posting_history_sync.covered_from THEN 'complete' ELSE 'active' END,due_at=excluded.due_at`)
 .bind(storeId,actor.orgId,source,command.expectedEpoch,from,window.start,window.start,Math.max(from,window.start-windowMaximum),window.start,...accepted.values));
 else statements.push(db.prepare(`UPDATE posting_history_sync SET state='cancelled',command_revision=command_revision+1,revision=revision+1 WHERE store_id=? AND organization_id=? AND source=? AND ${accepted.sql}`).bind(storeId,actor.orgId,source,...accepted.values));
 statements.push(
 db.prepare(`UPDATE store_coordinator SET fence=fence+CASE WHEN lease_source=? THEN 1 ELSE 0 END,lease_token=CASE WHEN lease_source=? THEN NULL ELSE lease_token END,
 lease_until=CASE WHEN lease_source=? THEN NULL ELSE lease_until END,lease_source=CASE WHEN lease_source=? THEN NULL ELSE lease_source END WHERE store_id=? AND organization_id=? AND commit_token=?`).bind(source,source,source,source,storeId,actor.orgId,token),
 db.prepare(`UPDATE store_sync_source SET due_at=MAX(MIN(due_at,${nowSQL}),COALESCE((SELECT blocked_until FROM store_coordinator WHERE store_id=store_sync_source.store_id),0)) WHERE store_id=? AND organization_id=? AND source=? AND ${accepted.sql}`).bind(storeId,actor.orgId,source,...accepted.values),
 db.prepare(`SELECT ${columns} FROM posting_history_sync history WHERE history.store_id=? AND history.organization_id=? AND history.source=? AND ${accepted.sql}`).bind(storeId,actor.orgId,source,...accepted.values),
 db.prepare('UPDATE store_coordinator SET commit_token=NULL WHERE store_id=? AND organization_id=? AND commit_token=?').bind(storeId,actor.orgId,token));
 const results=await db.batch(statements),row=results.at(-2)!.results[0] as unknown as HistoryRow|undefined;
 return row?dto(row):null;
}
export async function duePostingHistory(db:D1Database,lease:SyncLease,now:number){
 const live=syncLeaseCondition(lease);
 const row=await db.prepare(`SELECT ${columns} FROM posting_history_sync history WHERE history.store_id=? AND history.organization_id=? AND history.source=? AND history.epoch=? AND history.state='active' AND ${live.sql}`).bind(lease.storeId,lease.orgId,lease.source,lease.epoch,...live.values).first<HistoryRow>();
 if(!row)return null;
 const work:FbsListWork|null=row.dueAt<=now?{kind:'list',lane:'history',storeId:lease.storeId,epoch:lease.epoch,generation:row.generation,revision:row.revision,since:new Date(row.since).toISOString(),to:new Date(row.to).toISOString(),cursor:row.cursor,recentCursors:JSON.parse(row.recentCursors),dueAt:row.dueAt}:null;
 return {work,lastLane:row.lastLane};
}
export function historyPageGuard(lease:SyncLease,work:FbsListWork):SyncSQL{return {sql:`EXISTS(SELECT 1 FROM posting_history_sync WHERE store_id=? AND organization_id=? AND source=? AND epoch=? AND generation=? AND revision=? AND since=? AND "to"=? AND state='active')`,values:[lease.storeId,lease.orgId,lease.source,work.epoch,work.generation,work.revision,Date.parse(work.since),Date.parse(work.to)]};}
export function readHistoryPage(db:D1Database,lease:SyncLease,work:FbsListWork){const guard=historyPageGuard(lease,work);return db.prepare(`SELECT cursor,recent_cursors AS recentCursors FROM posting_history_sync WHERE store_id=? AND source=? AND ${guard.sql}`).bind(lease.storeId,lease.source,...guard.values).first<{cursor:string|null;recentCursors:string}>();}
export function historyPageUpdate(db:D1Database,lease:SyncLease,accepted:SyncSQL,page:{hasNext:boolean;cursor:string|null},recent:string[],currentCursor:string|null,now:number){
 return db.prepare(`UPDATE posting_history_sync SET covered_from=CASE WHEN ? THEN covered_from ELSE since END,
 state=CASE WHEN ?=0 AND since<=requested_from THEN 'complete' ELSE 'active' END,
 "to"=CASE WHEN ?=0 AND since>requested_from THEN MIN("to",since+${hour}) ELSE "to" END,
 since=CASE WHEN ?=0 AND since>requested_from THEN MAX(requested_from,since+${hour}-${windowMaximum}) ELSE since END,
 generation=generation+CASE WHEN ?=0 AND since>requested_from THEN 1 ELSE 0 END,
 cursor=?,recent_cursors=?,revision=revision+1,pages_read=pages_read+1,due_at=?,last_lane='history'
 WHERE store_id=? AND organization_id=? AND source=? AND ${accepted.sql}`)
 .bind(...Array(5).fill(page.hasNext?1:0),page.hasNext?page.cursor:null,JSON.stringify(page.hasNext?[...recent,...(currentCursor?[currentCursor]:[])].slice(-8):[]),now+1000,lease.storeId,lease.orgId,lease.source,...accepted.values);
}
export function historyTurn(db:D1Database,lease:SyncLease,accepted:SyncSQL,lane:'live'|'details'){
 return db.prepare(`UPDATE posting_history_sync SET last_lane=? WHERE store_id=? AND organization_id=? AND source=? AND epoch=? AND ${accepted.sql}`).bind(lane,lease.storeId,lease.orgId,lease.source,lease.epoch,...accepted.values);
}
