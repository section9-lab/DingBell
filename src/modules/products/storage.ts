import type { OzonProductDetails, OzonProductListItem } from './ozon.ts';
import type { ProductCounts, ProductDetailsWork, ProductListWork, ProductWork } from './types.ts';
import { storeAccess, type StoreActor } from '../stores/storage.ts';
import { prepareSyncPageFinish, prepareSyncPageGate, syncLeaseCondition, syncPageCondition } from '../sync/storage.ts';
import type { SyncLease, SyncSQL } from '../sync/types.ts';

const nowSQL = "CAST(unixepoch('subsecond') * 1000 AS INTEGER)";
const decimalId = /^(0|[1-9][0-9]{0,39})$/;
function bounded(value: unknown) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 1_048_576) throw new Error('PRODUCT_PAGE_TOO_LARGE');
}
function future(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) throw new Error('INVALID_PRODUCT_PAGE');
  return Math.max(value, Date.now() + 1000);
}
function due(lease: SyncLease): SyncSQL {
  return { sql: `(SELECT MIN(at) FROM (
    SELECT due_at AS at FROM product_sync_cursor WHERE store_id=? AND organization_id=? AND epoch=?
    UNION ALL SELECT detail_due_at AS at FROM product WHERE store_id=? AND organization_id=? AND detail_epoch=? AND detail_state='pending'))`,
    values: [lease.storeId,lease.orgId,lease.epoch,lease.storeId,lease.orgId,lease.epoch] };
}
function listing(item: OzonProductListItem) {
  if (!decimalId.test(item.id) || typeof item.id !== 'string') throw new Error('INVALID_PRODUCT_PAGE');
  return { id:item.id,offerId:item.offerId,sku:item.sku,archived:item.archived,hasFboStocks:item.hasFboStocks,hasFbsStocks:item.hasFbsStocks };
}
function facts(item: OzonProductDetails) {
  if (typeof item.id !== 'string' || !decimalId.test(item.id) || item.price !== null && (typeof item.price !== 'string' || !/^[0-9]+(?:\.[0-9]+)?$/.test(item.price))) throw new Error('INVALID_PRODUCT_PAGE');
  return { id:item.id,offerId:item.offerId,name:item.name,sku:item.sku,sources:item.sources.map(source=>({sku:source.sku,source:source.source})),price:item.price,currency:item.currency,archived:item.archived,primaryImage:item.primaryImage,images:item.images };
}

export async function getDueProductWork(db: D1Database, lease: SyncLease, limit = 50): Promise<ProductWork | null> {
  if (lease.source !== 'products') return null;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_PRODUCT_LIMIT');
  const guard = syncLeaseCondition(lease);
  const cursor = await db.prepare(`SELECT store_id AS storeId,epoch,generation,revision,cursor,recent_cursors AS recentCursors,due_at AS dueAt,last_kind AS lastKind,
    due_at<=${nowSQL} AS ready FROM product_sync_cursor WHERE store_id=? AND organization_id=? AND epoch=? AND ${guard.sql}`)
    .bind(lease.storeId,lease.orgId,lease.epoch,...guard.values).first<Omit<ProductListWork,'kind'|'recentCursors'> & {recentCursors:string;lastKind:string;ready:number}>();
  if (!cursor) return null;
  const pending = await db.prepare(`SELECT id,detail_generation AS generation,detail_revision AS revision,detail_due_at AS dueAt FROM product
    WHERE store_id=? AND organization_id=? AND detail_epoch=? AND detail_state='pending' AND detail_due_at<=${nowSQL} AND ${guard.sql}
    ORDER BY detail_due_at,id LIMIT ?`).bind(lease.storeId,lease.orgId,lease.epoch,...guard.values,limit).all<{id:string;generation:number;revision:number;dueAt:number}>();
  // Persisted alternation prevents a large catalog or detail backlog starving the other stream.
  if (cursor.ready && (!pending.results.length || cursor.lastKind === 'details')) {
    return {kind:'list',storeId:cursor.storeId,epoch:cursor.epoch,generation:cursor.generation,revision:cursor.revision,cursor:cursor.cursor,recentCursors:JSON.parse(cursor.recentCursors),dueAt:cursor.dueAt};
  }
  return pending.results.length ? {kind:'details',storeId:lease.storeId,epoch:lease.epoch,dueAt:pending.results[0].dueAt,
    items:pending.results.map(({id,generation,revision})=>({id,generation,revision}))} : null;
}

export async function commitProductList(db: D1Database, lease: SyncLease, work: ProductListWork, page: { items: OzonProductListItem[]; lastId: string; reportedTotal: number }, nextDueAt: number): Promise<boolean> {
  if (lease.source !== 'products' || work.kind !== 'list' || work.storeId !== lease.storeId || work.epoch !== lease.epoch) return false;
  if (!Array.isArray(page.items) || page.items.length > 100 || typeof page.lastId !== 'string' || page.lastId.length > 4096 || !Number.isSafeInteger(page.reportedTotal) || page.reportedTotal < 0) throw new Error('INVALID_PRODUCT_PAGE');
  const rows = page.items.map(listing);
  if (new Set(rows.map(row=>row.id)).size !== rows.length) throw new Error('INVALID_PRODUCT_PAGE');
  bounded(rows);
  const current = await db.prepare('SELECT cursor,recent_cursors AS recentCursors FROM product_sync_cursor WHERE store_id=? AND organization_id=? AND epoch=? AND generation=? AND revision=?')
    .bind(lease.storeId,lease.orgId,work.epoch,work.generation,work.revision).first<{cursor:string;recentCursors:string}>();
  if (!current || current.cursor !== work.cursor) return false;
  const recent = JSON.parse(current.recentCursors) as string[];
  if (rows.length && (!page.lastId || page.lastId === current.cursor || recent.includes(page.lastId))) throw new Error('cursor_stalled');
  const observedAt = Date.now(), next = future(nextDueAt), token = crypto.randomUUID(), condition = syncPageCondition(lease,token);
  const reset = `(product.detail_epoch<>excluded.detail_epoch OR product.listing<>excluded.listing OR (product.detail_generation<>excluded.detail_generation AND product.detail_state='complete'))`;
  const results = await db.batch([
    prepareSyncPageGate(db,lease,token,{sql:`EXISTS (SELECT 1 FROM product_sync_cursor WHERE store_id=? AND organization_id=? AND epoch=? AND generation=? AND revision=? AND cursor=?)`,values:[lease.storeId,lease.orgId,work.epoch,work.generation,work.revision,work.cursor]}),
    db.prepare(`INSERT INTO product (id,organization_id,store_id,listing,list_observed_at,detail_epoch,detail_generation,detail_revision,detail_state,detail_attempt,detail_due_at)
      SELECT json_extract(value,'$.id'),?,?,value,?,?,?,0,'pending',0,? FROM json_each(?) WHERE ${condition.sql}
      ON CONFLICT(store_id,id) DO UPDATE SET listing=excluded.listing,list_observed_at=excluded.list_observed_at,
        detail_epoch=excluded.detail_epoch,detail_generation=excluded.detail_generation,
        detail_revision=product.detail_revision+CASE WHEN product.detail_epoch<>excluded.detail_epoch OR product.detail_generation<>excluded.detail_generation OR product.listing<>excluded.listing THEN 1 ELSE 0 END,
        detail_state=CASE WHEN ${reset} THEN 'pending' ELSE product.detail_state END,
        detail_attempt=CASE WHEN ${reset} THEN 0 ELSE product.detail_attempt END,
        detail_due_at=CASE WHEN ${reset} THEN excluded.detail_due_at ELSE product.detail_due_at END,
        detail_error=CASE WHEN ${reset} THEN NULL ELSE product.detail_error END`)
      .bind(lease.orgId,lease.storeId,observedAt,lease.epoch,work.generation,observedAt,JSON.stringify(rows),...condition.values),
    db.prepare(`UPDATE product_sync_cursor SET cursor=?,recent_cursors=?,revision=revision+1,generation=generation+?,due_at=?,last_kind='list',
      last_completed_at=CASE WHEN ? THEN ? ELSE last_completed_at END WHERE store_id=? AND organization_id=? AND ${condition.sql}`)
      .bind(rows.length?page.lastId:'',JSON.stringify(rows.length?[...recent,...(current.cursor?[current.cursor]:[])].slice(-8):[]),rows.length?0:1,next,rows.length?0:1,observedAt,lease.storeId,lease.orgId,...condition.values),
    ...prepareSyncPageFinish(db,lease,token,due(lease)),
  ]);
  return !!results.at(-1)!.results.length;
}

export async function commitProductDetails(db: D1Database, lease: SyncLease, work: ProductDetailsWork, page: { items: OzonProductDetails[] }, retryDueAt: number): Promise<boolean> {
  if (lease.source !== 'products' || work.kind !== 'details' || work.storeId !== lease.storeId || work.epoch !== lease.epoch) return false;
  if (!work.items.length || work.items.length > 100 || page.items.length > work.items.length || new Set(work.items.map(row=>row.id)).size !== work.items.length) throw new Error('INVALID_PRODUCT_PAGE');
  const rows = page.items.map(item=>({id:item.id,snapshotId:crypto.randomUUID(),facts:facts(item)}));
  if (new Set(rows.map(row=>row.id)).size !== rows.length || rows.some(row=>!work.items.some(task=>task.id===row.id))) throw new Error('INVALID_PRODUCT_PAGE');
  bounded(rows); bounded(work.items);
  const token = crypto.randomUUID(), condition = syncPageCondition(lease,token), observedAt = Date.now(), next = future(retryDueAt);
  const workJSON = JSON.stringify(work.items), factsJSON = JSON.stringify(rows);
  const results = await db.batch([
    prepareSyncPageGate(db,lease,token,{sql:`(SELECT COUNT(*) FROM product JOIN json_each(?) AS task ON product.id=json_extract(task.value,'$.id')
      WHERE product.store_id=? AND product.organization_id=? AND product.detail_epoch=? AND product.detail_state='pending'
        AND product.detail_generation=json_extract(task.value,'$.generation') AND product.detail_revision=json_extract(task.value,'$.revision'))=?`,
      values:[workJSON,lease.storeId,lease.orgId,work.epoch,work.items.length]}),
    db.prepare(`INSERT INTO product_source_snapshot (id,organization_id,store_id,product_id,facts,observed_at)
      SELECT json_extract(item.value,'$.snapshotId'),?,?,product.id,json_extract(item.value,'$.facts'),? FROM json_each(?) AS item
      JOIN product ON product.id=json_extract(item.value,'$.id') AND product.store_id=? AND product.organization_id=?
      WHERE product.facts IS NOT json_extract(item.value,'$.facts') AND ${condition.sql}`)
      .bind(lease.orgId,lease.storeId,observedAt,factsJSON,lease.storeId,lease.orgId,...condition.values),
    db.prepare(`UPDATE product SET facts=(SELECT json_extract(value,'$.facts') FROM json_each(?) WHERE json_extract(value,'$.id')=product.id),
      facts_observed_at=?,detail_revision=detail_revision+1,detail_state='complete',detail_attempt=0,detail_error=NULL
      WHERE store_id=? AND organization_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${condition.sql}`)
      .bind(factsJSON,observedAt,lease.storeId,lease.orgId,factsJSON,...condition.values),
    db.prepare(`UPDATE product SET detail_attempt=detail_attempt+1,detail_revision=detail_revision+1,
      detail_state=CASE WHEN detail_attempt+1>=3 THEN 'error' ELSE 'pending' END,detail_error='product_details_missing',detail_due_at=?
      WHERE store_id=? AND organization_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))
        AND id NOT IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${condition.sql}`)
      .bind(next,lease.storeId,lease.orgId,workJSON,factsJSON,...condition.values),
    db.prepare(`UPDATE product_sync_cursor SET last_kind='details' WHERE store_id=? AND organization_id=? AND ${condition.sql}`)
      .bind(lease.storeId,lease.orgId,...condition.values),
    ...prepareSyncPageFinish(db,lease,token,due(lease)),
  ]);
  return !!results.at(-1)!.results.length;
}
export async function getProductCounts(db: D1Database, actor: StoreActor, storeId: string): Promise<ProductCounts | null> {
  return db.prepare(`SELECT
    (SELECT COUNT(*) FROM product WHERE store_id=store.id AND organization_id=store.organization_id) AS productCount,
    (SELECT COUNT(*) FROM product WHERE store_id=store.id AND organization_id=store.organization_id AND facts IS NOT NULL) AS readyCount,
    (SELECT COUNT(*) FROM product WHERE store_id=store.id AND organization_id=store.organization_id AND detail_state='pending') AS pendingCount,
    (SELECT COUNT(*) FROM product WHERE store_id=store.id AND organization_id=store.organization_id AND detail_state='error') AS failedCount
    FROM store WHERE store.id=? AND store.organization_id=? AND ${storeAccess('store.organization_id',false)}`)
    .bind(storeId,actor.orgId,actor.actorUserId,actor.sessionId).first<ProductCounts>();
}
