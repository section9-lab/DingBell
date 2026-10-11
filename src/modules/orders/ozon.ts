import { OzonReadError, readOzonJSON, type Credentials } from '../ozon/read.ts';
export { OzonReadError };
export interface OzonFbsPosting {
  postingNumber: string; orderId: string; orderNumber: string; status: string;
  products: { sku: string; offerId: string; name: string | null; quantity: number; price: string | null; currency: string | null }[];
  inProcessAt: string | null; shipmentDate: string | null; deliveringDate: string | null; trackingNumber: string | null;
}
const decimalId = /^(0|[1-9][0-9]{0,39})$/;
function invalid(): never { throw new OzonReadError('invalid_response'); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function text(value: unknown, maximum = 256): string { if (typeof value !== 'string' || !value.trim() || value.length > maximum) invalid(); return value; }
function optionalText(value: unknown, maximum = 256): string | null { return value === undefined || value === null || value === '' ? null : text(value, maximum); }
function id(value: unknown): string { const result = text(value, 40); if (!decimalId.test(result)) invalid(); return result; }
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value.slice(0, 10);
}
function optionalTime(value: unknown): string | null { if (value === undefined || value === null || value === '') return null; if (!timestamp(value)) invalid(); return value; }
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
function posting(value: unknown): OzonFbsPosting {
  const row = object(value);
  if (!Array.isArray(row.products)) invalid();
  return {
    postingNumber: text(row.posting_number), orderId: id(row.order_id), orderNumber: text(row.order_number), status: text(row.status),
    products: row.products.map(value => {
      const item = object(value);
      if (typeof item.quantity !== 'number' || !Number.isSafeInteger(item.quantity) || item.quantity < 0) invalid();
      return { sku: id(item.sku), offerId: text(item.offer_id), name: optionalText(item.name, 4096), quantity: item.quantity, price: price(item.price), currency: currency(item.currency_code) };
    }),
    inProcessAt: optionalTime(row.in_process_at), shipmentDate: optionalTime(row.shipment_date), deliveringDate: optionalTime(row.delivering_date), trackingNumber: optionalText(row.tracking_number),
  };
}

/** A bounded observation window, not a complete incremental status feed. */
export async function listOzonFbsPostings(credentials: Credentials, options: { since: string; to: string; cursor?: string; limit?: number }, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<{ postings: OzonFbsPosting[]; cursor: string | null; hasNext: boolean }> {
  if (!options || !timestamp(options.since) || !timestamp(options.to)) throw new OzonReadError('invalid_request');
  const size = options.limit === undefined ? 50 : options.limit, duration = Date.parse(options.to) - Date.parse(options.since);
  // 31 days is this application's request budget, narrower than Ozon's documented one-year maximum.
  if (duration <= 0 || duration > 31 * 86_400_000 || !Number.isSafeInteger(size) || size < 1 || size > 100
    || options.cursor !== undefined && (typeof options.cursor !== 'string' || !options.cursor || options.cursor.length > 4096)) throw new OzonReadError('invalid_request');
  const value = await readOzonJSON(credentials, '/v4/posting/fbs/list', JSON.stringify({ filter: { since: options.since, to: options.to }, ...(options.cursor === undefined ? {} : { cursor: options.cursor }), limit: size }), fetcher, signal);
  if (!Array.isArray(value.postings) || value.postings.length > size || typeof value.has_next !== 'boolean'
    || value.cursor !== undefined && value.cursor !== null && (typeof value.cursor !== 'string' || value.cursor.length > 4096)) invalid();
  if (value.has_next && (typeof value.cursor !== 'string' || !value.cursor || value.cursor === options.cursor || !value.postings.length)) invalid();
  return { postings: value.postings.map(posting), cursor: value.has_next ? value.cursor as string : null, hasNext: value.has_next };
}

/** Business timestamps are returned as reported; none is treated as a source status version. */
export async function readOzonFbsPosting(credentials: Credentials, options: { postingNumber: string }, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<OzonFbsPosting> {
  if (!options || typeof options.postingNumber !== 'string' || !options.postingNumber.trim() || options.postingNumber.length > 256) throw new OzonReadError('invalid_request');
  const value = await readOzonJSON(credentials, '/v3/posting/fbs/get', JSON.stringify({ posting_number: options.postingNumber }), fetcher, signal);
  const result = posting(value.result);
  if (result.postingNumber !== options.postingNumber) invalid();
  return result;
}
