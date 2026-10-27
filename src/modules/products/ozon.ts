import { OzonReadError, readOzonJSON, type Credentials } from '../ozon/read.ts';
export { OzonReadError };
export interface OzonProductListItem {
  id: string; offerId: string; sku: string | null; archived: boolean | null;
  hasFboStocks: boolean | null; hasFbsStocks: boolean | null;
}
export interface OzonProductDetails {
  id: string; offerId: string; name: string; sku: string | null;
  sources: { sku: string; source: string }[];
  price: string | null; currency: string | null; archived: boolean | null;
  primaryImage: string | null; images: string[];
}
const decimalId = /^(0|[1-9][0-9]{0,39})$/;
function invalid(): never { throw new OzonReadError('invalid_response'); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function text(value: unknown, maximum = 256): string { if (typeof value !== 'string' || !value || value.length > maximum) invalid(); return value; }
function id(value: unknown): string { const result = text(value, 40); if (!decimalId.test(result)) invalid(); return result; }
function optionalId(value: unknown): string | null { return value === undefined || value === null || value === '' ? null : id(value); }
function optionalBoolean(value: unknown): boolean | null { if (value === undefined || value === null) return null; if (typeof value !== 'boolean') invalid(); return value; }
function price(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 128 || !/^[0-9]+(?:\.[0-9]+)?$/.test(value)) invalid();
  return value;
}
function currency(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) invalid();
  return value;
}
function image(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048) invalid();
  try { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !/(^|\.)ozone\.ru$/i.test(url.hostname)) invalid(); }
  catch { invalid(); }
  return value;
}
function imageList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) invalid();
  return value.map(image);
}

/** lastId and reportedTotal are provider observations, not a complete catalog snapshot. */
export async function listOzonProducts(credentials: Credentials, options: { lastId?: string; limit?: number } = {}, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<{ items: OzonProductListItem[]; lastId: string; reportedTotal: number }> {
  // The application budget is 100; the documented provider maximum is 1000.
  const size = options.limit === undefined ? 50 : options.limit, previous = options.lastId === undefined ? '' : options.lastId;
  if (!Number.isSafeInteger(size) || size < 1 || size > 100 || typeof previous !== 'string' || previous.length > 4096) throw new OzonReadError('invalid_request');
  const value = object((await readOzonJSON(credentials, '/v3/product/list', JSON.stringify({ filter: { visibility: 'ALL' }, last_id: previous, limit: size }), fetcher, signal)).result);
  if (!Array.isArray(value.items) || value.items.length > size || typeof value.last_id !== 'string' || value.last_id.length > 4096 || typeof value.total !== 'number' || !Number.isSafeInteger(value.total) || value.total < 0) invalid();
  // A short page/changed total cannot prove completion. Empty pages are returned as observed.
  if (value.items.length && (!value.last_id || value.last_id === previous)) invalid();
  const items = value.items.map(item => {
    const row = object(item);
    return { id: id(row.product_id), offerId: text(row.offer_id), sku: optionalId(row.sku), archived: optionalBoolean(row.archived), hasFboStocks: optionalBoolean(row.has_fbo_stocks), hasFbsStocks: optionalBoolean(row.has_fbs_stocks) };
  });
  return { items, lastId: value.last_id, reportedTotal: value.total };
}

/** Missing items remain missing: the caller must not infer deletion or publish knowledge. */
export async function readOzonProductDetails(credentials: Credentials, options: { productIds: readonly string[] }, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<{ items: OzonProductDetails[] }> {
  const requested = options.productIds;
  if (!Array.isArray(requested) || !requested.length || requested.length > 100 || requested.some(value => typeof value !== 'string' || !decimalId.test(value)) || new Set(requested).size !== requested.length) throw new OzonReadError('invalid_request');
  const value = await readOzonJSON(credentials, '/v3/product/info/list', JSON.stringify({ product_id: requested }), fetcher, signal);
  if (!Array.isArray(value.items) || value.items.length > requested.length) invalid();
  const seen = new Set<string>();
  const items = value.items.map(item => {
    const row = object(item), productId = id(row.id);
    if (!requested.includes(productId) || seen.has(productId)) invalid();
    seen.add(productId);
    const sources = row.sources ?? [];
    if (!Array.isArray(sources)) invalid();
    const primary=imageList(row.primary_image),images=imageList(row.images),colors=imageList(row.color_image),all=[...new Set([...primary,...images,...colors])].slice(0,20);
    return { id: productId, offerId: text(row.offer_id), name: text(row.name, 4096), sku: optionalId(row.sku),
      sources: sources.map(item => { const source = object(item); return { sku: id(source.sku), source: text(source.source) }; }),
      price: price(row.price), currency: currency(row.currency_code), archived: optionalBoolean(row.is_archived),primaryImage:primary[0]??images[0]??colors[0]??null,images:all };
  });
  return { items };
}
