import type { OzonFbsPosting } from './ozon.ts';
import type { FbsCounts, FbsDetailsWork, FbsListWork, FbsWork } from './types.ts';
import { storeAccess,type StoreActor } from '../stores/storage.ts';
import { prepareSyncPageFinish,prepareSyncPageGate,syncLeaseCondition,syncPageCondition } from '../sync/storage.ts';
import type { SyncLease,SyncSQL } from '../sync/types.ts';

const nowSQL="CAST(unixepoch('subsecond') * 1000 AS INTEGER)";
const hour=3_600_000,windowMaximum=31*86_400_000,roundInterval=300_000,detailInterval=900_000;
function validTime(now:number){if(!Number.isSafeInteger(now)||now<0||now>8_640_000_000_000_000)throw new Error('INVALID_FBS_TIME');}
function bounded(value:unknown){if(new TextEncoder().encode(JSON.stringify(value)).length>1_048_576)throw new Error('FBS_PAGE_TOO_LARGE');}
function facts(value:OzonFbsPosting){
  if(typeof value.postingNumber!=='string'||!value.postingNumber.trim()||value.postingNumber.length>256||typeof value.orderId!=='string'||!/^(0|[1-9][0-9]{0,39})$/.test(value.orderId)||!Array.isArray(value.products))throw new Error('INVALID_FBS_PAGE');
  return {postingNumber:value.postingNumber,orderId:value.orderId,orderNumber:value.orderNumber,status:value.status,
    products:value.products.map(item=>{
      if(typeof item.sku!=='string'||!/^(0|[1-9][0-9]{0,39})$/.test(item.sku)||item.price!==null&&(typeof item.price!=='string'||!/^[0-9]+(?:\.[0-9]+)?$/.test(item.price)))throw new Error('INVALID_FBS_PAGE');
      return {sku:item.sku,offerId:item.offerId,name:item.name,quantity:item.quantity,price:item.price,currency:item.currency};
    }),inProcessAt:value.inProcessAt,shipmentDate:value.shipmentDate,deliveringDate:value.deliveringDate,trackingNumber:value.trackingNumber};
}
function due(lease:SyncLease):SyncSQL{return {sql:`(SELECT MIN(at) FROM (
  SELECT due_at AS at FROM fbs_sync_window WHERE store_id=? AND organization_id=? AND epoch=?
  UNION ALL SELECT detail_due_at AS at FROM fbs_posting WHERE store_id=? AND organization_id=? AND detail_epoch=? AND detail_state IN ('pending','complete')))`,
  values:[lease.storeId,lease.orgId,lease.epoch,lease.storeId,lease.orgId,lease.epoch]};}
function detailGuard(lease:SyncLease,work:FbsDetailsWork):SyncSQL{return {sql:`EXISTS (SELECT 1 FROM fbs_posting WHERE store_id=? AND organization_id=? AND posting_number=?
  AND detail_epoch=? AND detail_generation=? AND detail_revision=? AND detail_state IN ('pending','complete'))`,values:[lease.storeId,lease.orgId,work.postingNumber,work.epoch,work.generation,work.revision]};}
interface WindowRow {storeId:string;epoch:number;generation:number;revision:number;historyStart:number;since:number;to:number;cursor:string|null;recentCursors:string;state:string;dueAt:number;lastKind:string;lastCompletedTo:number|null}

export async function getDueFbsWork(db:D1Database,lease:SyncLease,now=Date.now()):Promise<FbsWork|null>{
  if(lease.source!=='fbs_postings')return null;validTime(now);
  const live=syncLeaseCondition(lease);
  const read=()=>db.prepare(`SELECT store_id AS storeId,epoch,generation,revision,history_start AS historyStart,since,"to",cursor,recent_cursors AS recentCursors,state,
    due_at AS dueAt,last_kind AS lastKind,last_completed_to AS lastCompletedTo FROM fbs_sync_window WHERE store_id=? AND organization_id=? AND epoch=? AND ${live.sql}`)
    .bind(lease.storeId,lease.orgId,lease.epoch,...live.values).first<WindowRow>();
  let window=await read();if(!window)return null;
  if(window.state==='waiting'&&window.dueAt<=now&&window.lastCompletedTo!==null&&now>window.lastCompletedTo){
    const since=Math.max(window.historyStart,window.lastCompletedTo-hour),to=Math.min(now,since+windowMaximum),token=crypto.randomUUID(),accepted=syncPageCondition(lease,token);
    // Persist the complete filter before the request. Preparing a window retains the caller's lease.
    await db.batch([
      prepareSyncPageGate(db,lease,token,{sql:"EXISTS (SELECT 1 FROM fbs_sync_window WHERE store_id=? AND organization_id=? AND epoch=? AND revision=? AND state='waiting')",values:[lease.storeId,lease.orgId,lease.epoch,window.revision]}),
      db.prepare(`UPDATE fbs_sync_window SET since=?,"to"=?,cursor=NULL,recent_cursors='[]',state='active',generation=generation+1,revision=revision+1,due_at=?
        WHERE store_id=? AND organization_id=? AND ${accepted.sql}`).bind(since,to,now,lease.storeId,lease.orgId,...accepted.values),
      db.prepare('UPDATE store_coordinator SET commit_token=NULL WHERE store_id=? AND organization_id=? AND commit_token=?').bind(lease.storeId,lease.orgId,token),
    ]);
    window=await read();if(!window)return null;
  }
  const posting=await db.prepare(`SELECT posting_number AS postingNumber,detail_generation AS generation,detail_revision AS revision,detail_due_at AS dueAt FROM fbs_posting
    WHERE store_id=? AND organization_id=? AND detail_epoch=? AND detail_state IN ('pending','complete') AND detail_due_at<=? AND ${live.sql}
    ORDER BY detail_due_at,posting_number LIMIT 1`).bind(lease.storeId,lease.orgId,lease.epoch,now,...live.values).first<{postingNumber:string;generation:number;revision:number;dueAt:number}>();
  if(window.state==='active'&&window.dueAt<=now&&(!posting||window.lastKind==='details'))return {kind:'list',storeId:lease.storeId,epoch:lease.epoch,generation:window.generation,revision:window.revision,
    since:new Date(window.since).toISOString(),to:new Date(window.to).toISOString(),cursor:window.cursor,recentCursors:JSON.parse(window.recentCursors),dueAt:window.dueAt};
  if(posting)return {kind:'details',storeId:lease.storeId,epoch:lease.epoch,...posting};
  const token=crypto.randomUUID(),accepted=syncPageCondition(lease,token),next=due(lease);
  // Keep the next real deadline when the shared runner releases this otherwise idle lease.
  await db.batch([
    prepareSyncPageGate(db,lease,token),
    db.prepare(`UPDATE fbs_sync_window SET due_at=MAX(due_at,?,last_completed_to+1) WHERE store_id=? AND organization_id=?
      AND state='waiting' AND last_completed_to>=? AND ${accepted.sql}`).bind(now+roundInterval,lease.storeId,lease.orgId,now,...accepted.values),
    db.prepare(`UPDATE store_sync_source SET due_at=MAX((${next.sql}),?,COALESCE((SELECT blocked_until FROM store_coordinator WHERE store_id=store_sync_source.store_id),0)),updated_at=${nowSQL}
      WHERE store_id=? AND organization_id=? AND source='fbs_postings' AND ${accepted.sql}`).bind(...next.values,now+1000,lease.storeId,lease.orgId,...accepted.values),
    db.prepare('UPDATE store_coordinator SET commit_token=NULL WHERE store_id=? AND organization_id=? AND commit_token=?').bind(lease.storeId,lease.orgId,token),
  ]);
  return null;
}

export async function commitFbsList(db:D1Database,lease:SyncLease,work:FbsListWork,page:{postings:OzonFbsPosting[];cursor:string|null;hasNext:boolean},now=Date.now()):Promise<boolean>{
  if(lease.source!=='fbs_postings'||work.kind!=='list'||work.storeId!==lease.storeId||work.epoch!==lease.epoch)return false;validTime(now);
  if(!Array.isArray(page.postings)||page.postings.length>100||typeof page.hasNext!=='boolean'||page.cursor!==null&&(typeof page.cursor!=='string'||page.cursor.length>4096))throw new Error('INVALID_FBS_PAGE');
  const unique=new Map<string,ReturnType<typeof facts>>();
  for(const posting of page.postings){const value=facts(posting),previous=unique.get(value.postingNumber);if(previous&&JSON.stringify(previous)!==JSON.stringify(value))throw new Error('INVALID_FBS_PAGE');unique.set(value.postingNumber,value);}
  const rows=[...unique.values()].map(value=>({id:crypto.randomUUID(),postingNumber:value.postingNumber,facts:value}));bounded(rows);
  const current=await db.prepare('SELECT cursor,recent_cursors AS recentCursors FROM fbs_sync_window WHERE store_id=? AND organization_id=? AND epoch=? AND generation=? AND revision=? AND since=? AND "to"=? AND state=\'active\'')
    .bind(lease.storeId,lease.orgId,work.epoch,work.generation,work.revision,Date.parse(work.since),Date.parse(work.to)).first<{cursor:string|null;recentCursors:string}>();
  if(!current||current.cursor!==work.cursor)return false;
  const recent=JSON.parse(current.recentCursors) as string[];
  if(page.hasNext&&(!rows.length||!page.cursor||page.cursor===current.cursor||recent.includes(page.cursor)))throw new Error('cursor_stalled');
  const token=crypto.randomUUID(),accepted=syncPageCondition(lease,token),rowsJSON=JSON.stringify(rows);
  const reset="(fbs_posting.detail_epoch<>excluded.detail_epoch OR fbs_posting.list_facts IS NOT excluded.list_facts)";
  const nextDueAt=now+(page.hasNext||now-Date.parse(work.to)>=roundInterval?1000:roundInterval);
  const result=await db.batch([
    prepareSyncPageGate(db,lease,token,{sql:"EXISTS (SELECT 1 FROM fbs_sync_window WHERE store_id=? AND organization_id=? AND epoch=? AND generation=? AND revision=? AND state='active')",values:[lease.storeId,lease.orgId,work.epoch,work.generation,work.revision]}),
    db.prepare(`INSERT INTO fbs_posting(posting_number,organization_id,store_id,order_id,order_number,detail_epoch,detail_generation,detail_due_at)
      SELECT json_extract(value,'$.postingNumber'),?,?,json_extract(value,'$.facts.orderId'),json_extract(value,'$.facts.orderNumber'),?,?,? FROM json_each(?) WHERE ${accepted.sql}
      ON CONFLICT(store_id,posting_number) DO NOTHING`).bind(lease.orgId,lease.storeId,lease.epoch,work.generation,now,rowsJSON,...accepted.values),
    db.prepare(`INSERT INTO fbs_posting_observation(id,organization_id,store_id,posting_number,source,facts,observed_at)
      SELECT json_extract(item.value,'$.id'),?,?,posting.posting_number,'list',json_extract(item.value,'$.facts'),? FROM json_each(?) AS item
      JOIN fbs_posting AS posting ON posting.store_id=? AND posting.organization_id=? AND posting.posting_number=json_extract(item.value,'$.postingNumber')
      WHERE posting.list_facts IS NOT json_extract(item.value,'$.facts') AND ${accepted.sql}`).bind(lease.orgId,lease.storeId,now,rowsJSON,lease.storeId,lease.orgId,...accepted.values),
    db.prepare(`INSERT INTO fbs_posting(posting_number,organization_id,store_id,order_id,order_number,list_facts,list_observed_at,detail_epoch,detail_generation,detail_due_at)
      SELECT json_extract(value,'$.postingNumber'),?,?,json_extract(value,'$.facts.orderId'),json_extract(value,'$.facts.orderNumber'),json_extract(value,'$.facts'),?,?,?,? FROM json_each(?) WHERE ${accepted.sql}
      ON CONFLICT(store_id,posting_number) DO UPDATE SET order_id=excluded.order_id,order_number=excluded.order_number,list_facts=excluded.list_facts,list_observed_at=excluded.list_observed_at,
        detail_epoch=excluded.detail_epoch,detail_generation=excluded.detail_generation,
        detail_revision=fbs_posting.detail_revision+CASE WHEN ${reset} OR fbs_posting.detail_generation<>excluded.detail_generation THEN 1 ELSE 0 END,
        detail_state=CASE WHEN ${reset} THEN 'pending' ELSE fbs_posting.detail_state END,detail_attempt=CASE WHEN ${reset} THEN 0 ELSE fbs_posting.detail_attempt END,
        detail_due_at=CASE WHEN ${reset} THEN excluded.detail_due_at ELSE fbs_posting.detail_due_at END,detail_error=CASE WHEN ${reset} THEN NULL ELSE fbs_posting.detail_error END`)
      .bind(lease.orgId,lease.storeId,now,lease.epoch,work.generation,now,rowsJSON,...accepted.values),
    db.prepare(`UPDATE fbs_sync_window SET cursor=?,recent_cursors=?,revision=revision+1,state=?,last_completed_to=CASE WHEN ? THEN last_completed_to ELSE "to" END,due_at=?,last_kind='list'
      WHERE store_id=? AND organization_id=? AND ${accepted.sql}`).bind(page.hasNext?page.cursor:null,JSON.stringify(page.hasNext?[...recent,...(current.cursor?[current.cursor]:[])].slice(-8):[]),page.hasNext?'active':'waiting',page.hasNext?1:0,nextDueAt,lease.storeId,lease.orgId,...accepted.values),
    ...prepareSyncPageFinish(db,lease,token,due(lease)),
  ]);return !!result.at(-1)!.results.length;
}

export async function commitFbsDetails(db:D1Database,lease:SyncLease,work:FbsDetailsWork,posting:OzonFbsPosting,now=Date.now()):Promise<boolean>{
  if(lease.source!=='fbs_postings'||work.kind!=='details'||work.storeId!==lease.storeId||work.epoch!==lease.epoch)return false;validTime(now);
  const value=facts(posting);if(value.postingNumber!==work.postingNumber)throw new Error('INVALID_FBS_PAGE');bounded(value);
  const valueJSON=JSON.stringify(value),token=crypto.randomUUID(),accepted=syncPageCondition(lease,token);
  const result=await db.batch([
    prepareSyncPageGate(db,lease,token,detailGuard(lease,work)),
    db.prepare(`INSERT INTO fbs_posting_observation(id,organization_id,store_id,posting_number,source,facts,observed_at)
      SELECT ?,organization_id,store_id,posting_number,'details',?,? FROM fbs_posting WHERE store_id=? AND organization_id=? AND posting_number=? AND detail_facts IS NOT ? AND ${accepted.sql}`)
      .bind(crypto.randomUUID(),valueJSON,now,lease.storeId,lease.orgId,work.postingNumber,valueJSON,...accepted.values),
    db.prepare(`UPDATE fbs_posting SET detail_facts=?,detail_observed_at=?,detail_revision=detail_revision+1,detail_state='complete',detail_attempt=0,detail_error=NULL,detail_due_at=?
      WHERE store_id=? AND organization_id=? AND posting_number=? AND ${accepted.sql}`).bind(valueJSON,now,now+detailInterval,lease.storeId,lease.orgId,work.postingNumber,...accepted.values),
    db.prepare(`UPDATE fbs_sync_window SET last_kind='details' WHERE store_id=? AND organization_id=? AND ${accepted.sql}`).bind(lease.storeId,lease.orgId,...accepted.values),
    ...prepareSyncPageFinish(db,lease,token,due(lease)),
  ]);return !!result.at(-1)!.results.length;
}

export async function commitFbsDetailFailure(db:D1Database,lease:SyncLease,work:FbsDetailsWork,code:string,now=Date.now()):Promise<boolean>{
  if(lease.source!=='fbs_postings'||work.kind!=='details'||work.storeId!==lease.storeId||work.epoch!==lease.epoch)return false;validTime(now);
  if(!['network_error','provider_unavailable','timed_out','invalid_response'].includes(code))throw new Error('INVALID_FBS_DETAIL_FAILURE');
  const token=crypto.randomUUID(),accepted=syncPageCondition(lease,token);
  const result=await db.batch([
    prepareSyncPageGate(db,lease,token,detailGuard(lease,work)),
    db.prepare(`UPDATE fbs_posting SET detail_attempt=detail_attempt+1,detail_revision=detail_revision+1,detail_due_at=?,detail_error=?,
      detail_state=CASE WHEN detail_attempt+1>=3 THEN 'error' ELSE 'pending' END WHERE store_id=? AND organization_id=? AND posting_number=? AND ${accepted.sql}`)
      .bind(now+30_000,code,lease.storeId,lease.orgId,work.postingNumber,...accepted.values),
    db.prepare(`UPDATE fbs_sync_window SET last_kind='details' WHERE store_id=? AND organization_id=? AND ${accepted.sql}`).bind(lease.storeId,lease.orgId,...accepted.values),
    ...prepareSyncPageFinish(db,lease,token,due(lease),{success:false}),
  ]);return !!result.at(-1)!.results.length;
}

export async function getFbsCounts(db:D1Database,actor:StoreActor,storeId:string):Promise<FbsCounts|null>{
  return db.prepare(`SELECT
    (SELECT COUNT(*) FROM fbs_posting WHERE store_id=store.id AND organization_id=store.organization_id) AS postingCount,
    (SELECT COUNT(*) FROM fbs_posting WHERE store_id=store.id AND organization_id=store.organization_id AND detail_facts IS NOT NULL) AS readyCount,
    (SELECT COUNT(*) FROM fbs_posting WHERE store_id=store.id AND organization_id=store.organization_id AND (detail_state='pending' OR detail_state='complete' AND detail_due_at<=${nowSQL})) AS pendingCount,
    (SELECT COUNT(*) FROM fbs_posting WHERE store_id=store.id AND organization_id=store.organization_id AND detail_state='error') AS failedCount,
    window.history_start AS historyStart,window.since AS windowSince,window."to" AS windowTo,window.last_completed_to AS lastCompletedTo
    FROM store LEFT JOIN fbs_sync_window AS window ON window.store_id=store.id AND window.organization_id=store.organization_id
    WHERE store.id=? AND store.organization_id=? AND ${storeAccess('store.organization_id',false)}`).bind(storeId,actor.orgId,actor.actorUserId,actor.sessionId).first<FbsCounts>();
}
