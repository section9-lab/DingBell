import type { OrderTimeSource } from '../../shared/order-time.ts';
import { isOzonImageHost } from '../../shared/ozon-image.ts';
import { MAX_TIMESTAMP_MS } from '../../shared/time.ts';
import { type StoreActor, storeAccess } from '../stores/storage.ts';
import type { SourcingDTO } from './sourcing.ts';

export { type SourcingInput, writeProductSourcing } from './sourcing.ts';

const productIdPattern = /^(0|[1-9][0-9]{0,39})$/;
const maximumTime = MAX_TIMESTAMP_MS;
export class InvalidCommerceCursor extends Error {
  constructor() {
    super('INVALID_COMMERCE_CURSOR');
    this.name = 'InvalidCommerceCursor';
  }
}

type ProductRow = {
  id: string;
  storeId: string;
  storeName: string;
  listing: string;
  facts: string | null;
  listObservedAt: number;
  factsObservedAt: number | null;
  state: string;
  error: string | null;
  supplySource: string | null;
  purchaseUrl: string | null;
  purchasePrice: string | null;
  purchaseCurrency: string | null;
  sourcingUpdatedAt: number | null;
  sourcingUpdatedByName: string | null;
  costingPurchasePrice: string | null;
  costingPurchaseCurrency: string | null;
  costingLabelFee: string | null;
  costingWeightGrams: number | null;
  costingCommissionRate: string | null;
  costingListPrice: string | null;
  costingPromoDiscount: string | null;
  costingSupplySource: string | null;
  costingValidFrom: number | null;
};
// Current open costing version from the merchant spreadsheet. Read-only here: editing happens in
// the accounting config, this projection just makes the cost model visible on the product page.
type CostingDTO = {
  purchasePrice: string;
  purchaseCurrency: string;
  labelFee: string | null;
  weightGrams: number | null;
  commissionRate: string | null;
  listPrice: string | null;
  promoDiscount: string | null;
  supplySource: string | null;
  validFrom: string;
};
export type FulfillmentType = 'fbs' | 'fbo' | 'fbp';
export type FulfillmentFilter = FulfillmentType | 'all';
type PostingRow = {
  orderDate: string | null;
  orderTime: string | null;
  orderTimeSource: OrderTimeSource | null;
  sortTime: number;
  fulfillmentType: FulfillmentType;
  productImages: string | null;
  postingNumber: string;
  storeId: string;
  storeName: string;
  orderId: string;
  orderNumber: string;
  listFacts: string | null;
  detailFacts: string | null;
  listObservedAt: number | null;
  detailObservedAt: number | null;
  state: string;
  error: string | null;
};
type ProductCursor = { v: 1; kind: 'products'; orgId: string; storeId: string; id: string };
type PostingCursor = {
  v: 3;
  kind: 'order-postings';
  orgId: string;
  storeId: string;
  fulfillment: FulfillmentFilter;
  orderNumber: string | null;
  query: string | null;
  from: number | null;
  to: number | null;
  orderTime: number;
  postingNumber: string;
  fulfillmentType: FulfillmentType;
};
// Keyword search matches order and parcel numbers; the instant range is half-open [from,to).
export type PostingRange = { query?: string; from?: number; to?: number };
export const postingFactsSQL = `CASE WHEN posting.detail_facts IS NOT NULL AND (posting.list_facts IS NULL OR posting.detail_observed_at>=posting.list_observed_at) THEN posting.detail_facts ELSE posting.list_facts END`;
// Preserve a business timestamp when a newer status-only snapshot omits it.
// FBS does not report order_date; disclose processing/creation sources rather
// than excluding that entire fulfillment mode or pretending it is checkout.
const postingTimeFieldSQL = (
  field: 'orderDate' | 'createdAt' | 'inProcessAt',
) => `COALESCE(json_extract(${postingFactsSQL},'$.${field}'),
  CASE WHEN json_extract(posting.detail_facts,'$.orderId')=posting.order_id THEN json_extract(posting.detail_facts,'$.${field}') END,
  CASE WHEN json_extract(posting.list_facts,'$.orderId')=posting.order_id THEN json_extract(posting.list_facts,'$.${field}') END)`;
const postingOrderDateSQL = postingTimeFieldSQL('orderDate');
const postingCreatedAtSQL = `CASE WHEN posting.fulfillment_type='fbo' THEN ${postingTimeFieldSQL('createdAt')} END`;
const postingProcessingAtSQL = postingTimeFieldSQL('inProcessAt');
export const postingBusinessTimeSQL = `COALESCE(${postingOrderDateSQL},${postingCreatedAtSQL},${postingProcessingAtSQL})`;
const postingTimeSourceSQL = `CASE WHEN ${postingOrderDateSQL} IS NOT NULL THEN 'order_date' WHEN ${postingCreatedAtSQL} IS NOT NULL THEN 'created_at' WHEN ${postingProcessingAtSQL} IS NOT NULL THEN 'in_process_at' END`;
const postingOrderTimeSQL = `CAST(ROUND((julianday(${postingBusinessTimeSQL})-2440587.5)*86400000) AS INTEGER)`;
const postingSortTimeSQL = `COALESCE(${postingOrderTimeSQL},${-maximumTime})`; // Truly unknown business dates sort last.

function base64url(bytes: Uint8Array) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
function encode(value: unknown) {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}
function decode(value: string): unknown {
  if (!value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new InvalidCommerceCursor();
  try {
    const bytes = Uint8Array.from(
      atob(value.replaceAll('-', '+').replaceAll('_', '/')),
      (character) => character.charCodeAt(0),
    );
    if (base64url(bytes) !== value) throw new Error();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new InvalidCommerceCursor();
  }
}
function object(value: string | null) {
  if (value === null) return null;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('INVALID_COMMERCE_DATA');
  return parsed as Record<string, unknown>;
}
function text(value: unknown, nullable = false) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string') throw new Error('INVALID_COMMERCE_DATA');
  return value;
}
function nullableBoolean(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'boolean') throw new Error('INVALID_COMMERCE_DATA');
  return value;
}
function nullableDecimal(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^[0-9]+(?:\.[0-9]+)?$/.test(value))
    throw new Error('INVALID_COMMERCE_DATA');
  return value;
}
function productImage(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > 2048)
    throw new Error('INVALID_COMMERCE_DATA');
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !isOzonImageHost(url.hostname)
    )
      throw new Error();
  } catch {
    throw new Error('INVALID_COMMERCE_DATA');
  }
  return value;
}
function sourcingDTO(row: ProductRow): SourcingDTO | null {
  if (row.sourcingUpdatedAt === null) return null;
  const supplySource = text(row.supplySource, true),
    purchaseUrl = text(row.purchaseUrl, true),
    purchasePrice = row.purchasePrice === null ? null : nullableDecimal(row.purchasePrice),
    purchaseCurrency = text(row.purchaseCurrency, true);
  if ((purchasePrice === null) !== (purchaseCurrency === null))
    throw new Error('INVALID_COMMERCE_DATA');
  if (purchaseUrl !== null && (!/^https?:\/\//.test(purchaseUrl) || purchaseUrl.length > 2048))
    throw new Error('INVALID_COMMERCE_DATA');
  // Spreadsheet imports and deleted accounts can legitimately have no user join.
  // Attribution is optional metadata, not a reason to hide the entire product page.
  const updatedByName = row.sourcingUpdatedByName?.trim() || '导入记录（原操作人不可用）';
  return {
    supplySource,
    purchaseUrl,
    purchasePrice,
    purchaseCurrency,
    updatedAt: new Date(row.sourcingUpdatedAt).toISOString(),
    updatedByName,
  };
}
function costingDTO(row: ProductRow): CostingDTO | null {
  if (
    row.costingValidFrom === null ||
    row.costingPurchasePrice === null ||
    row.costingPurchaseCurrency === null
  )
    return null;
  const purchasePrice = nullableDecimal(row.costingPurchasePrice),
    purchaseCurrency = text(row.costingPurchaseCurrency);
  if (purchasePrice === null || purchaseCurrency === null) return null;
  return {
    purchasePrice,
    purchaseCurrency,
    labelFee: text(row.costingLabelFee, true),
    weightGrams: row.costingWeightGrams,
    commissionRate: text(row.costingCommissionRate, true),
    listPrice: text(row.costingListPrice, true),
    promoDiscount: text(row.costingPromoDiscount, true),
    supplySource: text(row.costingSupplySource, true),
    validFrom: new Date(row.costingValidFrom).toISOString(),
  };
}
function productDTO(row: ProductRow) {
  const listing = object(row.listing)!;
  const facts = object(row.facts);
  const id = text(listing.id);
  if (id !== row.id || !productIdPattern.test(id)) throw new Error('INVALID_COMMERCE_DATA');
  const offerId = text(facts?.offerId ?? listing.offerId),
    sku = text(facts?.sku ?? listing.sku, true),
    name = text(facts?.name ?? null, true);
  const archived = nullableBoolean(facts?.archived ?? listing.archived),
    hasFboStocks = nullableBoolean(listing.hasFboStocks),
    hasFbsStocks = nullableBoolean(listing.hasFbsStocks);
  const createdAt =
    facts?.createdAt === undefined || facts.createdAt === null ? null : text(facts.createdAt, true);
  const price = nullableDecimal(facts?.price),
    currency = text(facts?.currency ?? null, true),
    rawImages = facts?.images ?? [];
  if (!Array.isArray(rawImages) || rawImages.length > 20) throw new Error('INVALID_COMMERCE_DATA');
  const images = rawImages.map(productImage),
    primaryImage =
      facts?.primaryImage === undefined || facts.primaryImage === null
        ? (images[0] ?? null)
        : productImage(facts.primaryImage);
  if (primaryImage !== null && !images.includes(primaryImage))
    throw new Error('INVALID_COMMERCE_DATA');
  if (!['pending', 'complete', 'error'].includes(row.state))
    throw new Error('INVALID_COMMERCE_DATA');
  return {
    id: row.id,
    store: { id: row.storeId, name: row.storeName },
    offerId,
    name,
    sku,
    archived,
    hasFboStocks,
    hasFbsStocks,
    price,
    currency,
    primaryImage,
    images,
    createdAt,
    sourcing: sourcingDTO(row),
    costing: costingDTO(row),
    state: row.state as 'pending' | 'complete' | 'error',
    error: row.error,
    listObservedAt: new Date(row.listObservedAt).toISOString(),
    factsObservedAt:
      row.factsObservedAt === null ? null : new Date(row.factsObservedAt).toISOString(),
  };
}
function productDetailDTO(row: ProductRow) {
  const dto = productDTO(row),
    facts = object(row.facts),
    raw = facts?.sources ?? [];
  if (!Array.isArray(raw)) throw new Error('INVALID_COMMERCE_DATA');
  const sources = raw.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('INVALID_COMMERCE_DATA');
    const source = value as Record<string, unknown>;
    return { sku: text(source.sku), source: text(source.source) };
  });
  return { ...dto, sources };
}
// Only associate images through an unambiguous SKU in the same company/store.
// These correlated subqueries run for the bounded page, not for every order in the store.
function postingImagesSQL(firstOnly = false) {
  return `(SELECT json_group_array(json_object('position',item.key,'primaryImage',(
  SELECT CASE WHEN COUNT(DISTINCT product.id)=1 THEN MAX(COALESCE(json_extract(product.facts,'$.primaryImage'),json_extract(product.facts,'$.images[0]'))) END
  FROM product_sku alias JOIN product ON product.id=alias.product_id AND product.store_id=alias.store_id AND product.organization_id=alias.organization_id
  WHERE alias.organization_id=posting.organization_id AND alias.store_id=posting.store_id AND alias.sku=json_extract(item.value,'$.sku')
  ))) FROM json_each(${postingFactsSQL},'$.products') item${firstOnly ? ' WHERE item.key=0' : ''})`;
}
function postingImage(row: PostingRow, index: number): string | null {
  const images = JSON.parse(row.productImages ?? '[]') as {
      position: number;
      primaryImage: unknown;
    }[],
    value = images.find((image) => image.position === index)?.primaryImage;
  if (value === null || value === undefined) return null;
  try {
    return productImage(value);
  } catch {
    return null;
  }
}
function selectedPosting(row: PostingRow) {
  const details =
    row.detailFacts !== null &&
    (row.listFacts === null || (row.detailObservedAt ?? 0) >= (row.listObservedAt ?? 0));
  return {
    raw: object(details ? row.detailFacts : row.listFacts),
    source: details
      ? ('details' as const)
      : row.listFacts !== null
        ? ('list' as const)
        : ('pending' as const),
    observedAt: details ? row.detailObservedAt : row.listObservedAt,
  };
}
function postingDTO(row: PostingRow) {
  const { raw, source, observedAt } = selectedPosting(row);
  if (!['pending', 'complete', 'error'].includes(row.state))
    throw new Error('INVALID_COMMERCE_DATA');
  if (raw && text(raw.postingNumber) !== row.postingNumber)
    throw new Error('INVALID_COMMERCE_DATA');
  const products = raw?.products;
  if (products !== undefined && !Array.isArray(products)) throw new Error('INVALID_COMMERCE_DATA');
  return {
    orderDate: text(row.orderDate, true),
    orderTime: text(row.orderTime, true),
    orderTimeSource: row.orderTimeSource,
    ...(row.fulfillmentType === 'fbp'
      ? { substatus: text(raw?.substatus ?? null, true), statusIsCode: raw?.statusIsCode === true }
      : {}),
    fulfillmentType: row.fulfillmentType,
    postingNumber: row.postingNumber,
    store: { id: row.storeId, name: row.storeName },
    orderId: row.orderId,
    orderNumber: row.orderNumber,
    status: raw ? text(raw.status) : null,
    productCount: Array.isArray(products) ? products.length : 0,
    previewProduct:
      Array.isArray(products) && products.length
        ? {
            sku: text(products[0].sku),
            name: text(products[0].name ?? null, true),
            primaryImage: postingImage(row, 0),
          }
        : null,
    trackingNumber: raw ? text(raw.trackingNumber ?? null, true) : null,
    inProcessAt: raw ? text(raw.inProcessAt ?? null, true) : null,
    shipmentDate: raw ? text(raw.shipmentDate ?? null, true) : null,
    deliveringDate: raw ? text(raw.deliveringDate ?? null, true) : null,
    state: row.state as 'pending' | 'complete' | 'error',
    error: row.error,
    source,
    observedAt: observedAt === null ? null : new Date(observedAt).toISOString(),
  };
}
function postingDetailDTO(row: PostingRow) {
  const dto = postingDTO(row),
    { raw } = selectedPosting(row),
    items = raw?.products ?? [];
  if (!Array.isArray(items)) throw new Error('INVALID_COMMERCE_DATA');
  const products = items.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('INVALID_COMMERCE_DATA');
    const item = value as Record<string, unknown>;
    const quantity = item.quantity;
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 0)
      throw new Error('INVALID_COMMERCE_DATA');
    return {
      sku: text(item.sku),
      offerId: text(item.offerId),
      name: text(item.name ?? null, true),
      quantity,
      price: nullableDecimal(item.price),
      currency: text(item.currency ?? null, true),
      primaryImage: postingImage(row, index),
    };
  });
  return { ...dto, products };
}
function productCursor(value: string | undefined, actor: StoreActor, storeId: string) {
  if (value === undefined) return undefined;
  const parsed = decode(value) as Partial<ProductCursor>;
  if (
    parsed?.v !== 1 ||
    parsed.kind !== 'products' ||
    parsed.orgId !== actor.orgId ||
    parsed.storeId !== storeId ||
    typeof parsed.id !== 'string' ||
    !productIdPattern.test(parsed.id)
  )
    throw new InvalidCommerceCursor();
  return parsed as ProductCursor;
}
export type ProductBoolFilter = 'yes' | 'no' | 'empty';
export type ProductFilters = {
  name?: string;
  nameEmpty?: boolean;
  offerId?: string;
  sku?: string;
  priceMin?: number;
  priceMax?: number;
  priceEmpty?: boolean;
  state?: 'pending' | 'complete' | 'error';
  archived?: ProductBoolFilter;
  fbo?: ProductBoolFilter;
  fbs?: ProductBoolFilter;
  sourcing?: 'filled' | 'empty';
  costing?: 'filled' | 'empty';
  listedFrom?: number;
  listedTo?: number;
  listedEmpty?: boolean;
};
// Product facts live inside JSON columns; tri-state booleans expose the platform's
// "not provided" (NULL) as a filterable value instead of collapsing it into "no".
function productFilterSQL(filters: ProductFilters) {
  const where: string[] = [],
    values: (string | number)[] = [];
  const like = (sql: string, input: string) => {
    where.push(`${sql} LIKE ? ESCAPE '\\'`);
    values.push(`%${likePattern(input)}%`);
  };
  if (filters.name !== undefined) like(`json_extract(product.facts,'$.name')`, filters.name);
  if (filters.nameEmpty) where.push(`json_extract(product.facts,'$.name') IS NULL`);
  if (filters.offerId !== undefined)
    like(
      `COALESCE(json_extract(product.facts,'$.offerId'),json_extract(product.listing,'$.offerId'))`,
      filters.offerId,
    );
  if (filters.sku !== undefined)
    like(
      `COALESCE(json_extract(product.facts,'$.sku'),json_extract(product.listing,'$.sku'))`,
      filters.sku,
    );
  if (filters.priceEmpty) where.push(`json_extract(product.facts,'$.price') IS NULL`);
  if (filters.priceMin !== undefined) {
    where.push(`CAST(json_extract(product.facts,'$.price') AS REAL)>=?`);
    values.push(filters.priceMin);
  }
  if (filters.priceMax !== undefined) {
    where.push(`CAST(json_extract(product.facts,'$.price') AS REAL)<=?`);
    values.push(filters.priceMax);
  }
  if (filters.state !== undefined) {
    where.push('product.detail_state=?');
    values.push(filters.state);
  }
  const triState = (sql: string, choice: ProductBoolFilter) =>
    where.push(choice === 'yes' ? `${sql}=1` : choice === 'no' ? `${sql}=0` : `${sql} IS NULL`);
  if (filters.archived)
    triState(
      `COALESCE(json_extract(product.facts,'$.archived'),json_extract(product.listing,'$.archived'))`,
      filters.archived,
    );
  if (filters.fbo) triState(`json_extract(product.listing,'$.hasFboStocks')`, filters.fbo);
  if (filters.fbs) triState(`json_extract(product.listing,'$.hasFbsStocks')`, filters.fbs);
  if (filters.sourcing)
    where.push(
      filters.sourcing === 'filled'
        ? 'sourcing.updated_at IS NOT NULL'
        : 'sourcing.updated_at IS NULL',
    );
  if (filters.costing)
    where.push(
      filters.costing === 'filled'
        ? '(costing.valid_from IS NOT NULL AND costing.purchase_price IS NOT NULL)'
        : '(costing.valid_from IS NULL OR costing.purchase_price IS NULL)',
    );
  // The marketplace creation instant lives in the detail facts ("created_at");
  // julianday stays NULL when the facts have not synced the timestamp yet.
  const listedAtSQL = `CAST(ROUND((julianday(json_extract(product.facts,'$.createdAt'))-2440587.5)*86400000) AS INTEGER)`;
  if (filters.listedEmpty) where.push(`json_extract(product.facts,'$.createdAt') IS NULL`);
  if (filters.listedFrom !== undefined) {
    where.push(`${listedAtSQL}>=?`);
    values.push(filters.listedFrom);
  }
  if (filters.listedTo !== undefined) {
    where.push(`${listedAtSQL}<?`);
    values.push(filters.listedTo);
  }
  return { where, values };
}
function postingCursor(
  value: string | undefined,
  actor: StoreActor,
  storeId: string,
  fulfillment: FulfillmentFilter,
  orderNumber: string | undefined,
  range: PostingRange,
) {
  if (value === undefined) return undefined;
  const parsed = decode(value) as Partial<PostingCursor>;
  if (
    parsed?.v !== 3 ||
    parsed.kind !== 'order-postings' ||
    parsed.fulfillment !== fulfillment ||
    !['fbs', 'fbo', 'fbp'].includes(parsed.fulfillmentType ?? '') ||
    parsed.orgId !== actor.orgId ||
    parsed.storeId !== storeId ||
    parsed.orderNumber !== (orderNumber ?? null) ||
    parsed.query !== (range.query ?? null) ||
    parsed.from !== (range.from ?? null) ||
    parsed.to !== (range.to ?? null) ||
    typeof parsed.postingNumber !== 'string' ||
    !parsed.postingNumber ||
    parsed.postingNumber.length > 256 ||
    typeof parsed.orderTime !== 'number' ||
    !Number.isSafeInteger(parsed.orderTime) ||
    parsed.orderTime < -maximumTime ||
    parsed.orderTime > maximumTime
  )
    throw new InvalidCommerceCursor();
  return parsed as PostingCursor;
}
function likePattern(query: string) {
  return `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

const sourcingColumns = `sourcing.supply_source AS supplySource,sourcing.purchase_url AS purchaseUrl,sourcing.purchase_price AS purchasePrice,sourcing.purchase_currency AS purchaseCurrency,
  sourcing.updated_at AS sourcingUpdatedAt,sourcing_user.name AS sourcingUpdatedByName,
  costing.purchase_price AS costingPurchasePrice,costing.purchase_currency AS costingPurchaseCurrency,costing.label_fee AS costingLabelFee,costing.weight_grams AS costingWeightGrams,
  costing.commission_rate AS costingCommissionRate,costing.list_price AS costingListPrice,costing.promo_discount AS costingPromoDiscount,costing.supply_source AS costingSupplySource,
  costing.valid_from AS costingValidFrom`;
const productFrom = `FROM product JOIN store ON store.id=product.store_id AND store.organization_id=product.organization_id
  LEFT JOIN product_sourcing sourcing ON sourcing.organization_id=product.organization_id AND sourcing.store_id=product.store_id AND sourcing.product_id=product.id
  LEFT JOIN user sourcing_user ON sourcing_user.id=sourcing.updated_by
  LEFT JOIN product_costing costing ON costing.organization_id=product.organization_id AND costing.store_id=product.store_id AND costing.product_id=product.id AND costing.valid_to IS NULL`;
export async function listCommerceProducts(
  db: D1Database,
  actor: StoreActor,
  storeId: string,
  cursor: string | undefined,
  limit: number,
  filters: ProductFilters = {},
) {
  const edge = productCursor(cursor, actor, storeId),
    filterSQL = productFilterSQL(filters),
    filteredWhere = filterSQL.where.length ? ` AND ${filterSQL.where.join(' AND ')}` : '';
  const rows = (
    await db
      .prepare(`SELECT product.id,store.id AS storeId,store.name AS storeName,product.listing,product.facts,product.list_observed_at AS listObservedAt,
    product.facts_observed_at AS factsObservedAt,product.detail_state AS state,product.detail_error AS error,${sourcingColumns} ${productFrom}
    WHERE product.organization_id=? AND product.store_id=? AND product.id>?${filteredWhere} AND ${storeAccess('store.organization_id', false)} ORDER BY product.id LIMIT ?`)
      .bind(
        actor.orgId,
        storeId,
        edge?.id ?? '',
        ...filterSQL.values,
        actor.actorUserId,
        actor.sessionId,
        limit + 1,
      )
      .all<ProductRow>()
  ).results;
  const total =
    (
      await db
        .prepare(
          `SELECT COUNT(*) AS total ${productFrom} WHERE product.organization_id=? AND product.store_id=?${filteredWhere} AND ${storeAccess('store.organization_id', false)}`,
        )
        .bind(actor.orgId, storeId, ...filterSQL.values, actor.actorUserId, actor.sessionId)
        .first<{ total: number }>()
    )?.total ?? 0;
  const items = rows.slice(0, limit).map(productDTO),
    last = items.at(-1);
  return {
    items,
    totalProducts: total,
    totalPages: Math.ceil(total / limit),
    nextCursor:
      rows.length > limit && last
        ? encode({
            v: 1,
            kind: 'products',
            orgId: actor.orgId,
            storeId,
            id: last.id,
          } satisfies ProductCursor)
        : null,
  };
}
export async function readCommerceProduct(
  db: D1Database,
  actor: StoreActor,
  storeId: string,
  id: string,
) {
  const row = await db
    .prepare(`SELECT product.id,store.id AS storeId,store.name AS storeName,product.listing,product.facts,product.list_observed_at AS listObservedAt,
    product.facts_observed_at AS factsObservedAt,product.detail_state AS state,product.detail_error AS error,${sourcingColumns} ${productFrom}
    WHERE product.organization_id=? AND product.store_id=? AND product.id=? AND ${storeAccess('store.organization_id', false)}`)
    .bind(actor.orgId, storeId, id, actor.actorUserId, actor.sessionId)
    .first<ProductRow>();
  return row ? productDetailDTO(row) : null;
}
export async function listOrderPostings(
  db: D1Database,
  actor: StoreActor,
  storeId: string,
  cursor: string | undefined,
  limit: number,
  orderNumber?: string,
  fulfillment: FulfillmentFilter = 'all',
  range: PostingRange = {},
) {
  const edge = postingCursor(cursor, actor, storeId, fulfillment, orderNumber, range),
    where = [
      `posting.organization_id=?`,
      `posting.store_id=?`,
      storeAccess('store.organization_id', false),
    ],
    values: (string | number)[] = [actor.orgId, storeId, actor.actorUserId, actor.sessionId];
  if (orderNumber !== undefined) {
    where.push('posting.order_number=?');
    values.push(orderNumber);
  }
  if (fulfillment !== 'all') {
    where.push('posting.fulfillment_type=?');
    values.push(fulfillment);
  }
  if (range.query !== undefined) {
    const pattern = likePattern(range.query);
    where.push(
      `(posting.order_number LIKE ? ESCAPE '\\' OR posting.posting_number LIKE ? ESCAPE '\\')`,
    );
    values.push(pattern, pattern);
  }
  const timeWhere: string[] = [],
    timeValues: number[] = [];
  if (range.from !== undefined) {
    timeWhere.push(`${postingOrderTimeSQL}>=?`);
    timeValues.push(range.from);
  }
  if (range.to !== undefined) {
    timeWhere.push(`${postingOrderTimeSQL}<?`);
    timeValues.push(range.to);
  }
  const edgeWhere = edge
    ? `WHERE (${postingSortTimeSQL}<? OR (${postingSortTimeSQL}=? AND (posting.posting_number<? OR (posting.posting_number=? AND posting.fulfillment_type<?))))`
    : '';
  const result = (
    await db
      .prepare(`WITH scoped AS NOT MATERIALIZED (
      SELECT posting.*,store.name AS store_name FROM commerce_posting posting JOIN store ON store.id=posting.store_id AND store.organization_id=posting.organization_id WHERE ${where.join(' AND ')}
    ), filtered AS NOT MATERIALIZED (SELECT * FROM scoped posting${timeWhere.length ? ' WHERE ' + timeWhere.join(' AND ') : ''}),
    undated AS (SELECT COUNT(*) AS undatedPostings FROM scoped posting WHERE ${postingOrderTimeSQL} IS NULL),
    totals AS (SELECT COUNT(*) AS totalPostings,COUNT(DISTINCT order_id) AS totalOrders FROM filtered),
    page AS (SELECT * FROM filtered posting ${edgeWhere} ORDER BY ${postingSortTimeSQL} DESC,posting.posting_number DESC,posting.fulfillment_type DESC LIMIT ?)
    SELECT posting.fulfillment_type AS fulfillmentType,posting.posting_number AS postingNumber,posting.store_id AS storeId,posting.store_name AS storeName,posting.order_id AS orderId,posting.order_number AS orderNumber,
      posting.list_facts AS listFacts,posting.detail_facts AS detailFacts,posting.list_observed_at AS listObservedAt,posting.detail_observed_at AS detailObservedAt,
      posting.detail_state AS state,posting.detail_error AS error,${postingOrderDateSQL} AS orderDate,${postingBusinessTimeSQL} AS orderTime,${postingTimeSourceSQL} AS orderTimeSource,${postingSortTimeSQL} AS sortTime,totals.totalOrders,totals.totalPostings,undated.undatedPostings,${postingImagesSQL(true)} AS productImages
    FROM totals CROSS JOIN undated LEFT JOIN page posting ON 1=1
    ORDER BY ${postingSortTimeSQL} DESC,posting.posting_number DESC,posting.fulfillment_type DESC`)
      .bind(
        ...values,
        ...timeValues,
        ...(edge
          ? [
              edge.orderTime,
              edge.orderTime,
              edge.postingNumber,
              edge.postingNumber,
              edge.fulfillmentType,
            ]
          : []),
        limit + 1,
      )
      .all<PostingRow & { totalOrders: number; totalPostings: number; undatedPostings: number }>()
  ).results;
  const totalOrders = result[0]?.totalOrders ?? 0,
    totalPostings = result[0]?.totalPostings ?? 0,
    rows = result.filter((row) => row.postingNumber !== null);
  const items = rows.slice(0, limit).map(postingDTO),
    lastRow = rows[Math.min(limit, rows.length) - 1],
    last = items.at(-1),
    orderTime = lastRow?.sortTime ?? -maximumTime;
  return {
    items,
    totalOrders,
    totalPostings,
    undatedPostings: result[0]?.undatedPostings ?? 0,
    totalPages: Math.ceil(totalPostings / limit),
    nextCursor:
      rows.length > limit && last
        ? encode({
            v: 3,
            kind: 'order-postings',
            orgId: actor.orgId,
            storeId,
            fulfillment,
            orderNumber: orderNumber ?? null,
            query: range.query ?? null,
            from: range.from ?? null,
            to: range.to ?? null,
            orderTime,
            postingNumber: last.postingNumber,
            fulfillmentType: last.fulfillmentType,
          } satisfies PostingCursor)
        : null,
  };
}
export async function readOrderPosting(
  db: D1Database,
  actor: StoreActor,
  storeId: string,
  postingNumber: string,
  fulfillmentType: FulfillmentType,
) {
  // Old FBS detail links retain their original snapshot even if the exact parcel is later proven FBP.
  const table =
    fulfillmentType === 'fbs'
      ? "(SELECT 'fbs' AS fulfillment_type,* FROM fbs_posting)"
      : 'commerce_posting';
  const row = await db
    .prepare(`SELECT posting.fulfillment_type AS fulfillmentType,posting.posting_number AS postingNumber,store.id AS storeId,store.name AS storeName,posting.order_id AS orderId,posting.order_number AS orderNumber,
    posting.list_facts AS listFacts,posting.detail_facts AS detailFacts,posting.list_observed_at AS listObservedAt,posting.detail_observed_at AS detailObservedAt,
    posting.detail_state AS state,posting.detail_error AS error,${postingOrderDateSQL} AS orderDate,${postingBusinessTimeSQL} AS orderTime,${postingTimeSourceSQL} AS orderTimeSource,${postingSortTimeSQL} AS sortTime,${postingImagesSQL()} AS productImages FROM ${table} AS posting JOIN store ON store.id=posting.store_id AND store.organization_id=posting.organization_id
    WHERE posting.organization_id=? AND posting.store_id=? AND posting.posting_number=? AND posting.fulfillment_type=? AND ${storeAccess('store.organization_id', false)}`)
    .bind(actor.orgId, storeId, postingNumber, fulfillmentType, actor.actorUserId, actor.sessionId)
    .first<PostingRow>();
  return row ? postingDetailDTO(row) : null;
}
// Compatibility for existing FBS callers; the order center uses the unified interface.
export const listFbsPostings = (
  db: D1Database,
  actor: StoreActor,
  storeId: string,
  cursor: string | undefined,
  limit: number,
  orderNumber?: string,
) => listOrderPostings(db, actor, storeId, cursor, limit, orderNumber, 'fbs');
export const readFbsPosting = (
  db: D1Database,
  actor: StoreActor,
  storeId: string,
  postingNumber: string,
) => readOrderPosting(db, actor, storeId, postingNumber, 'fbs');
