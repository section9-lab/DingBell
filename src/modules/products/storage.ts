import { NOW_MS } from '../../platform/database/sql.ts';
import { MAX_TIMESTAMP_MS } from '../../shared/time.ts';
import type { OzonProductDetails, OzonProductListItem } from './ozon.ts';
import type { ProductAttributesWork, ProductCounts, ProductDescriptionWork, ProductDetailsWork, ProductListWork, ProductWork } from './types.ts';
import { storeAccess, type StoreActor } from '../stores/storage.ts';
import { prepareSyncPageFinish, prepareSyncPageGate, syncLeaseCondition, syncPageCondition } from '../sync/storage.ts';
import type { SyncLease, SyncSQL } from '../sync/types.ts';

const nowSQL = NOW_MS;
const decimalId = /^(0|[1-9][0-9]{0,39})$/;
function bounded(value: unknown) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 1_048_576) throw new Error('PRODUCT_PAGE_TOO_LARGE');
}
function future(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP_MS) throw new Error('INVALID_PRODUCT_PAGE');
  return Math.max(value, Date.now() + 1000);
}
function due(lease: SyncLease): SyncSQL {
  return { sql: `(SELECT MIN(at) FROM (
    SELECT due_at AS at FROM product_sync_cursor WHERE store_id=? AND organization_id=? AND epoch=?
    UNION ALL SELECT detail_due_at AS at FROM product WHERE store_id=? AND organization_id=? AND detail_epoch=? AND detail_state='pending'
    UNION ALL SELECT attributes_due_at AS at FROM product_service_profile WHERE store_id=? AND organization_id=? AND attributes_state='pending'
    UNION ALL SELECT description_due_at AS at FROM product_service_profile WHERE store_id=? AND organization_id=? AND description_state='pending'))`,
    values: [lease.storeId,lease.orgId,lease.epoch,lease.storeId,lease.orgId,lease.epoch,lease.storeId,lease.orgId,lease.storeId,lease.orgId] };
}
function listing(item: OzonProductListItem) {
  if (!decimalId.test(item.id) || typeof item.id !== 'string') throw new Error('INVALID_PRODUCT_PAGE');
  return { id:item.id,offerId:item.offerId,sku:item.sku,archived:item.archived,hasFboStocks:item.hasFboStocks,hasFbsStocks:item.hasFbsStocks };
}
function facts(item: OzonProductDetails) {
  if (typeof item.id !== 'string' || !decimalId.test(item.id) || item.price !== null && (typeof item.price !== 'string' || !/^[0-9]+(?:\.[0-9]+)?$/.test(item.price))) throw new Error('INVALID_PRODUCT_PAGE');
  return { id:item.id,offerId:item.offerId,name:item.name,sku:item.sku,sources:item.sources.map(source=>({sku:source.sku,source:source.source})),price:item.price,currency:item.currency,archived:item.archived,createdAt:item.createdAt,primaryImage:item.primaryImage,images:item.images };
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
  // Profile enrichment is a separate, bounded stream. It alternates with details so a large
  // catalog cannot starve descriptions, and a large profile backlog cannot starve discovery.
  const profileWork = async (): Promise<ProductWork | null> => {
    const attributes = await db.prepare(`SELECT product_id AS id,attributes_due_at AS dueAt FROM product_service_profile
      WHERE store_id=? AND organization_id=? AND attributes_state='pending' AND attributes_due_at<=${nowSQL}
      ORDER BY attributes_due_at,product_id LIMIT 10`).bind(lease.storeId,lease.orgId).all<{id:string;dueAt:number}>();
    if (attributes.results.length) return {kind:'attributes',storeId:lease.storeId,epoch:lease.epoch,dueAt:attributes.results[0]!.dueAt,
      items:attributes.results.map(({id})=>({id}))};
    const description = await db.prepare(`SELECT product_id AS id,description_due_at AS dueAt FROM product_service_profile
      WHERE store_id=? AND organization_id=? AND description_state='pending' AND description_due_at<=${nowSQL}
      ORDER BY description_due_at,product_id LIMIT 1`).bind(lease.storeId,lease.orgId).first<{id:string;dueAt:number}>();
    return description ? {kind:'description',storeId:lease.storeId,epoch:lease.epoch,dueAt:description.dueAt,items:[{id:description.id}]} : null;
  };
  // Persisted alternation prevents a large catalog or detail backlog starving the other stream.
  if (cursor.ready && (!pending.results.length || cursor.lastKind === 'details')) {
    return {kind:'list',storeId:cursor.storeId,epoch:cursor.epoch,generation:cursor.generation,revision:cursor.revision,cursor:cursor.cursor,recentCursors:JSON.parse(cursor.recentCursors),dueAt:cursor.dueAt};
  }
  if (pending.results.length) return {kind:'details',storeId:lease.storeId,epoch:lease.epoch,dueAt:pending.results[0].dueAt,
    items:pending.results.map(({id,generation,revision})=>({id,generation,revision}))};
  return await profileWork();
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

/**
 * json_each must stay the outer loop. If SQLite picks `product` as outer, it scans the
 * whole JSON page once per product (417 products x 100 items = 41,669 rows read).
 * CROSS JOIN pins the order so each item is one index seek on (store_id, organization_id, id).
 */
export function productSnapshotInsert(conditionSql: string): string {
  return `INSERT INTO product_source_snapshot (id,organization_id,store_id,product_id,facts,observed_at)
      SELECT json_extract(item.value,'$.snapshotId'),?,?,product.id,json_extract(item.value,'$.facts'),? FROM json_each(?) AS item
      CROSS JOIN product
      WHERE product.id=json_extract(item.value,'$.id') AND product.store_id=? AND product.organization_id=?
        AND product.facts IS NOT json_extract(item.value,'$.facts') AND ${conditionSql}`;
}

/** Same outer-loop rule for the detail-page gate count. */
export function productDetailGate(): string {
  return `(SELECT COUNT(*) FROM json_each(?) AS task CROSS JOIN product
      WHERE product.id=json_extract(task.value,'$.id') AND product.store_id=? AND product.organization_id=? AND product.detail_epoch=? AND product.detail_state='pending'
        AND product.detail_generation=json_extract(task.value,'$.generation') AND product.detail_revision=json_extract(task.value,'$.revision'))=?`;
}

export async function commitProductDetails(db: D1Database, lease: SyncLease, work: ProductDetailsWork, page: { items: OzonProductDetails[] }, retryDueAt: number): Promise<boolean> {
  if (lease.source !== 'products' || work.kind !== 'details' || work.storeId !== lease.storeId || work.epoch !== lease.epoch) return false;
  if (!work.items.length || work.items.length > 100 || page.items.length > work.items.length || new Set(work.items.map(row=>row.id)).size !== work.items.length) throw new Error('INVALID_PRODUCT_PAGE');
  const rows = page.items.map(item=>({id:item.id,snapshotId:crypto.randomUUID(),facts:facts(item)}));
  if (new Set(rows.map(row=>row.id)).size !== rows.length || rows.some(row=>!work.items.some(task=>task.id===row.id))) throw new Error('INVALID_PRODUCT_PAGE');
  bounded(rows); bounded(work.items);
  const token = crypto.randomUUID(), condition = syncPageCondition(lease,token), observedAt = Date.now(), next = future(retryDueAt);
  const workJSON = JSON.stringify(work.items), factsJSON = JSON.stringify(rows);
  // Stock and model grouping are observed alongside the facts but never inside the immutable snapshot.
  const pinnedJSON = JSON.stringify(page.items.map(item=>({id:item.id,modelId:item.modelId})));
  const stockPinnedJSON = JSON.stringify(page.items.flatMap(item=>item.stock===null?[]:[{id:item.id,hasStock:item.stock.hasStock}]));
  const stockJSON = JSON.stringify(page.items.flatMap(item=>item.stock===null?[]:item.stock.items.map(row=>({productId:item.id,source:row.source,sku:row.sku,present:row.present,reserved:row.reserved}))));
  const results = await db.batch([
    prepareSyncPageGate(db,lease,token,{sql:productDetailGate(),
      values:[workJSON,lease.storeId,lease.orgId,work.epoch,work.items.length]}),
    // A changed public fact (name, images, price, stock flags) invalidates the derived profile.
    // The old text stays visible while the profile queue refreshes it; unchanged facts do not requeue.
    db.prepare(`UPDATE product_service_profile SET attributes_state='pending',attributes_due_at=?,attributes_attempt=0,
      description_state='pending',description_due_at=?,description_attempt=0,updated_at=?
      WHERE store_id=? AND organization_id=? AND product_id IN (
        SELECT product.id FROM product CROSS JOIN json_each(?) item
        WHERE product.id=json_extract(item.value,'$.id') AND product.facts IS NOT json_extract(item.value,'$.facts') AND ${condition.sql})`)
      .bind(observedAt,observedAt,observedAt,lease.storeId,lease.orgId,factsJSON,...condition.values),
    db.prepare(productSnapshotInsert(condition.sql))
      .bind(lease.orgId,lease.storeId,observedAt,factsJSON,lease.storeId,lease.orgId,...condition.values),
    db.prepare(`UPDATE product SET facts=(SELECT json_extract(value,'$.facts') FROM json_each(?) WHERE json_extract(value,'$.id')=product.id),
      facts_observed_at=?,detail_revision=detail_revision+1,detail_state='complete',detail_attempt=0,detail_error=NULL
      WHERE store_id=? AND organization_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${condition.sql}`)
      .bind(factsJSON,observedAt,lease.storeId,lease.orgId,factsJSON,...condition.values),
    // An omitted model_info is unknown, not proof the item left its model, so only a reported id replaces the stored one.
    db.prepare(`UPDATE product SET model_id=COALESCE((SELECT json_extract(value,'$.modelId') FROM json_each(?) WHERE json_extract(value,'$.id')=product.id),product.model_id)
      WHERE store_id=? AND organization_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${condition.sql}`)
      .bind(pinnedJSON,lease.storeId,lease.orgId,pinnedJSON,...condition.values),
    db.prepare(`UPDATE product SET stock_has_stock=COALESCE((SELECT json_extract(value,'$.hasStock') FROM json_each(?) WHERE json_extract(value,'$.id')=product.id),product.stock_has_stock),
      stock_observed_at=? WHERE store_id=? AND organization_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${condition.sql}`)
      .bind(stockPinnedJSON,observedAt,lease.storeId,lease.orgId,stockPinnedJSON,...condition.values),
    // Only products the provider actually reported stock for are replaced; an absent stocks field stays unknown.
    db.prepare(`DELETE FROM product_stock WHERE store_id=? AND organization_id=? AND product_id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${condition.sql}`)
      .bind(lease.storeId,lease.orgId,stockPinnedJSON,...condition.values),
    db.prepare(`INSERT INTO product_stock(organization_id,store_id,product_id,source,sku,present,reserved,observed_at)
      SELECT ?,?,json_extract(value,'$.productId'),json_extract(value,'$.source'),json_extract(value,'$.sku'),json_extract(value,'$.present'),json_extract(value,'$.reserved'),?
      FROM json_each(?) WHERE ${condition.sql}
      ON CONFLICT(store_id,product_id,source,sku) DO UPDATE SET present=excluded.present,reserved=excluded.reserved,observed_at=excluded.observed_at`)
      .bind(lease.orgId,lease.storeId,observedAt,stockJSON,...condition.values),
    db.prepare(`UPDATE product SET detail_attempt=detail_attempt+1,detail_revision=detail_revision+1,
      detail_state=CASE WHEN detail_attempt+1>=3 THEN 'error' ELSE 'pending' END,detail_error='product_details_missing',detail_due_at=?
      WHERE store_id=? AND organization_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))
        AND id NOT IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${condition.sql}`)
      .bind(next,lease.storeId,lease.orgId,workJSON,factsJSON,...condition.values),
    // New details enqueue a customer-safe profile. Existing profiles are not reset by a routine
    // detail refresh; a future explicit refresh can requeue them without rewriting the snapshot.
    db.prepare(`INSERT INTO product_service_profile(organization_id,store_id,product_id,attributes_due_at,description_due_at,updated_at)
      SELECT ?,?,json_extract(value,'$.id'),?,?,? FROM json_each(?) WHERE ${condition.sql}
      ON CONFLICT(store_id,product_id) DO NOTHING`)
      .bind(lease.orgId,lease.storeId,observedAt+60_000,observedAt+60_000,observedAt,factsJSON,...condition.values),
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

export interface ProductAttributesRow {
  id: string;
  attributesJSON: string;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  dimensionUnit: string | null;
  weightG: number | null;
  weightUnit: string | null;
}

/** Commits public characteristics and dimensions for one bounded attributes page. */
export async function commitProductAttributes(db: D1Database, lease: SyncLease, work: ProductAttributesWork, page: { items: ProductAttributesRow[] }, retryDueAt: number): Promise<boolean> {
  if (lease.source !== 'products' || work.kind !== 'attributes' || work.storeId !== lease.storeId || work.epoch !== lease.epoch) return false;
  if (!work.items.length || work.items.length > 10 || page.items.length > work.items.length) throw new Error('INVALID_PRODUCT_PAGE');
  const ids = work.items.map(item => item.id);
  if (new Set(ids).size !== ids.length || page.items.some(item => !ids.includes(item.id)) || new Set(page.items.map(item => item.id)).size !== page.items.length) throw new Error('INVALID_PRODUCT_PAGE');
  bounded(page.items);
  const token = crypto.randomUUID(), condition = syncPageCondition(lease, token), observedAt = Date.now(), next = future(retryDueAt);
  const workJSON = JSON.stringify(work.items), pageJSON = JSON.stringify(page.items);
  const results = await db.batch([
    prepareSyncPageGate(db, lease, token),
    db.prepare(`UPDATE product_service_profile SET
      attributes_json=(SELECT json_extract(value,'$.attributesJSON') FROM json_each(?) WHERE json_extract(value,'$.id')=product_service_profile.product_id),
      length_mm=(SELECT json_extract(value,'$.lengthMm') FROM json_each(?) WHERE json_extract(value,'$.id')=product_service_profile.product_id),
      width_mm=(SELECT json_extract(value,'$.widthMm') FROM json_each(?) WHERE json_extract(value,'$.id')=product_service_profile.product_id),
      height_mm=(SELECT json_extract(value,'$.heightMm') FROM json_each(?) WHERE json_extract(value,'$.id')=product_service_profile.product_id),
      dimension_unit=(SELECT json_extract(value,'$.dimensionUnit') FROM json_each(?) WHERE json_extract(value,'$.id')=product_service_profile.product_id),
      weight_g=(SELECT json_extract(value,'$.weightG') FROM json_each(?) WHERE json_extract(value,'$.id')=product_service_profile.product_id),
      weight_unit=(SELECT json_extract(value,'$.weightUnit') FROM json_each(?) WHERE json_extract(value,'$.id')=product_service_profile.product_id),
      attributes_state='complete',attributes_attempt=0,attributes_due_at=0,observed_at=?,updated_at=?
      WHERE store_id=? AND organization_id=? AND product_id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${condition.sql}`)
      .bind(pageJSON,pageJSON,pageJSON,pageJSON,pageJSON,pageJSON,pageJSON,observedAt,observedAt,lease.storeId,lease.orgId,pageJSON,...condition.values),
    db.prepare(`UPDATE product_service_profile SET attributes_attempt=attributes_attempt+1,
      attributes_state=CASE WHEN attributes_attempt+1>=3 THEN 'unavailable' ELSE 'pending' END,attributes_due_at=?,updated_at=?
      WHERE store_id=? AND organization_id=? AND product_id IN (SELECT json_extract(value,'$.id') FROM json_each(?))
        AND product_id NOT IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${condition.sql}`)
      .bind(next,observedAt,lease.storeId,lease.orgId,workJSON,pageJSON,...condition.values),
    ...prepareSyncPageFinish(db, lease, token, due(lease)),
  ]);
  return !!results.at(-1)!.results.length;
}

/** Records a failed attributes read without turning a transient provider error into a deletion. */
export async function commitProductAttributesFailure(db: D1Database, lease: SyncLease, work: ProductAttributesWork, retryDueAt: number): Promise<boolean> {
  if (lease.source !== 'products' || work.kind !== 'attributes' || work.storeId !== lease.storeId || work.epoch !== lease.epoch) return false;
  const token = crypto.randomUUID(), condition = syncPageCondition(lease, token), observedAt = Date.now(), next = future(retryDueAt), workJSON = JSON.stringify(work.items);
  const results = await db.batch([
    prepareSyncPageGate(db, lease, token),
    db.prepare(`UPDATE product_service_profile SET attributes_attempt=attributes_attempt+1,
      attributes_state=CASE WHEN attributes_attempt+1>=3 THEN 'unavailable' ELSE 'pending' END,attributes_due_at=?,updated_at=?
      WHERE store_id=? AND organization_id=? AND product_id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${condition.sql}`)
      .bind(next,observedAt,lease.storeId,lease.orgId,workJSON,...condition.values),
    ...prepareSyncPageFinish(db, lease, token, due(lease), { success: false }),
  ]);
  return !!results.at(-1)!.results.length;
}

/** Commits one public description. Empty descriptions are marked unavailable, not retried forever. */
export async function commitProductDescription(db: D1Database, lease: SyncLease, work: ProductDescriptionWork, description: string | null): Promise<boolean> {
  if (lease.source !== 'products' || work.kind !== 'description' || work.storeId !== lease.storeId || work.epoch !== lease.epoch || work.items.length !== 1) return false;
  const id = work.items[0]!.id, text = description?.trim() ?? '';
  if (text.length > 8000) throw new Error('INVALID_PRODUCT_PAGE');
  const token = crypto.randomUUID(), condition = syncPageCondition(lease, token), observedAt = Date.now();
  const results = await db.batch([
    prepareSyncPageGate(db, lease, token),
    db.prepare(`UPDATE product_service_profile SET description=?,description_state=?,description_attempt=0,description_due_at=0,observed_at=?,updated_at=?
      WHERE store_id=? AND organization_id=? AND product_id=? AND ${condition.sql}`)
      .bind(text || null, text ? 'complete' : 'unavailable', observedAt, observedAt, lease.storeId, lease.orgId, id, ...condition.values),
    ...prepareSyncPageFinish(db, lease, token, due(lease)),
  ]);
  return !!results.at(-1)!.results.length;
}

export async function commitProductDescriptionFailure(db: D1Database, lease: SyncLease, work: ProductDescriptionWork, retryDueAt: number): Promise<boolean> {
  if (lease.source !== 'products' || work.kind !== 'description' || work.storeId !== lease.storeId || work.epoch !== lease.epoch || work.items.length !== 1) return false;
  const id = work.items[0]!.id, token = crypto.randomUUID(), condition = syncPageCondition(lease, token), observedAt = Date.now(), next = future(retryDueAt);
  const results = await db.batch([
    prepareSyncPageGate(db, lease, token),
    db.prepare(`UPDATE product_service_profile SET description_attempt=description_attempt+1,
      description_state=CASE WHEN description_attempt+1>=3 THEN 'unavailable' ELSE 'pending' END,description_due_at=?,updated_at=?
      WHERE store_id=? AND organization_id=? AND product_id=? AND ${condition.sql}`)
      .bind(next,observedAt,lease.storeId,lease.orgId,id,...condition.values),
    ...prepareSyncPageFinish(db, lease, token, due(lease), { success: false }),
  ]);
  return !!results.at(-1)!.results.length;
}

export async function readCachedAttributeNames(db: D1Database, items: { descriptionCategoryId: string; typeId: string; attributeIds: string[] }[], language: 'RU' | 'EN' | 'ZH_HANS' = 'RU') {
  const pairs = new Map<string, { descriptionCategoryId: string; typeId: string }>();
  for (const item of items) pairs.set(`${item.descriptionCategoryId}:${item.typeId}`, item);
  const names = new Map<string, string>();
  for (const pair of pairs.values()) {
    const rows = (await db.prepare(`SELECT attribute_id AS id,name FROM product_category_attribute
      WHERE description_category_id=? AND type_id=? AND language=?`).bind(pair.descriptionCategoryId, pair.typeId, language).all<{ id: string; name: string }>()).results;
    for (const row of rows) names.set(`${pair.descriptionCategoryId}:${pair.typeId}:${row.id}`, row.name);
  }
  return names;
}

export async function saveCachedAttributeNames(db: D1Database, descriptionCategoryId: string, typeId: string, language: 'RU' | 'EN' | 'ZH_HANS', items: { id: string; name: string }[]) {
  if (!items.length) return;
  const observedAt = Date.now(), rows = JSON.stringify(items);
  await db.prepare(`INSERT INTO product_category_attribute(description_category_id,type_id,language,attribute_id,name,observed_at)
    SELECT ?,?,?,json_extract(value,'$.id'),json_extract(value,'$.name'),? FROM json_each(?) WHERE true
    ON CONFLICT(description_category_id,type_id,language,attribute_id) DO UPDATE SET name=excluded.name,observed_at=excluded.observed_at`)
    .bind(descriptionCategoryId, typeId, language, observedAt, rows).run();
}
