import { OzonReadError, readOzonJSON, type Credentials } from '../ozon/read.ts';
export { OzonReadError };
export interface OzonFbsPosting {
  postingNumber: string; orderId: string; orderNumber: string; status: string;
  products: { sku: string; offerId: string; name: string | null; quantity: number; price: string | null; currency: string | null; commissionRate?: string }[];
  inProcessAt: string | null; shipmentDate: string | null; deliveringDate: string | null; trackingNumber: string | null;
  orderDate?:string|null; createdAt?:string|null; substatus?:string|null; statusIsCode?:boolean;
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
function productPrice(item: Record<string, unknown>,mode:'fbs'|'fbo'|'fbp',details=false) {
  if(mode==='fbp'&&details)item={...item,price:item.marketplace_seller_price};
  if (item.price && typeof item.price === 'object' && !Array.isArray(item.price)) {
    const current = object(item.price);
    if (typeof current.amount !== 'string' || typeof current.currency !== 'string') invalid();
    return { price: price(current.amount), currency: currency(current.currency) };
  }
  return { price: price(item.price), currency: currency(mode==='fbo'?item.currency_code??item.currency:item.currency_code) };
}
// Retain the dimensionless platform rate. Absolute finance amounts are not mixed into
// sales currency: FBS/FBP can report finance in RUB while seller prices are in CNY.
function platformCommissionRate(row:Record<string,unknown>,item:Record<string,unknown>):string|undefined {
  const data=row.financial_data;if(!data||typeof data!=='object'||Array.isArray(data))return;
  const products=(data as Record<string,unknown>).products;if(!Array.isArray(products))return;
  const matches=products.filter(value=>value&&typeof value==='object'&&!Array.isArray(value)).map(value=>value as Record<string,unknown>)
    .filter(value=>(value.sku??value.product_id)===item.sku&&value.quantity===item.quantity);
  if(matches.length!==1)return;
  const finance=matches[0]!,posting=finance.posting_commission;
  const percent=posting&&typeof posting==='object'&&!Array.isArray(posting)?(posting as Record<string,unknown>).percent:finance.commission_percent;
  if(typeof percent!=='number'||!Number.isFinite(percent)||percent<0||percent>100)return;
  return (percent/100).toFixed(6).replace(/0+$/,'').replace(/\.$/,'');
}
function posting(value: unknown,mode:'fbs'|'fbo'|'fbp',details=false): OzonFbsPosting {
  const row = object(value);
  if (!Array.isArray(row.products)) invalid();
  const coded=mode==='fbp'&&details;
  const status=coded?(typeof row.status==='number'&&Number.isSafeInteger(row.status)&&row.status>=0?String(row.status):typeof row.status==='string'&&decimalId.test(row.status)?row.status:invalid()):text(row.status);
  return {
    postingNumber: text(row.posting_number), orderId: id(row.order_id), orderNumber: text(row.order_number), status,
    products: row.products.map(value => {
      const item = object(value);
      if (typeof item.quantity !== 'number' || !Number.isSafeInteger(item.quantity) || item.quantity < 0) invalid();
      const commissionRate=details?platformCommissionRate(row,item):undefined;
      return { sku: id(item.sku), offerId: text(item.offer_id), name: optionalText(item.name, 4096), quantity: item.quantity, ...productPrice(item,mode,details),...(commissionRate===undefined?{}:{commissionRate}) };
    }),
    inProcessAt: optionalTime(row.in_process_at), shipmentDate: mode==='fbs'?optionalTime(row.shipment_date):null, deliveringDate: mode==='fbs'?optionalTime(row.delivering_date):null, trackingNumber: mode==='fbs'?optionalText(row.tracking_number):null,
    // Retain each business timestamp separately so the read model can disclose
    // its source instead of inventing an order_date for FBS/FBO.
    orderDate:optionalTime(row.order_date),
    ...(mode==='fbo'?{createdAt:optionalTime(row.created_at)}:{}),
    ...(mode==='fbp'?{substatus:optionalText(row.substatus),statusIsCode:coded}:{}),
  };
}

function postingReader(mode:'fbs'|'fbo'|'fbp') {
/** A bounded observation window, not a complete incremental status feed. */
async function listPostings(credentials: Credentials, options: { since: string; to: string; cursor?: string; limit?: number }, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<{ postings: OzonFbsPosting[]; cursor: string | null; hasNext: boolean }> {
  if (!options || !timestamp(options.since) || !timestamp(options.to)) throw new OzonReadError('invalid_request');
  const size = options.limit === undefined ? 50 : options.limit, duration = Date.parse(options.to) - Date.parse(options.since);
  // 31 days is the application's budget. FBS/FBO document a one-year maximum; FBP is beta.
  if (duration <= 0 || duration > 31 * 86_400_000 || !Number.isSafeInteger(size) || size < 1 || size > 100
    || options.cursor !== undefined && (typeof options.cursor !== 'string' || !options.cursor || options.cursor.length > 4096)) throw new OzonReadError('invalid_request');
  const value = await readOzonJSON(credentials, mode==='fbs'?'/v4/posting/fbs/list':mode==='fbo'?'/v3/posting/fbo/list':'/v1/posting/fbp/list', JSON.stringify({ filter: { since: options.since, to: options.to },...(mode==='fbp'?{sort_by:'in_process_at',sort_dir:'ASC'}:{}), ...(options.cursor === undefined ? {} : { cursor: options.cursor }), limit: size }), fetcher, signal);
  const hasNext=mode==='fbp'?typeof value.cursor==='string'&&value.cursor.length>0:value.has_next;
  if (!Array.isArray(value.postings) || value.postings.length > size || typeof hasNext !== 'boolean'
    || value.cursor !== undefined && value.cursor !== null && (typeof value.cursor !== 'string' || value.cursor.length > 4096)) invalid();
  if (hasNext && (typeof value.cursor !== 'string' || !value.cursor || value.cursor === options.cursor || !value.postings.length)) invalid();
  return { postings: value.postings.map(value=>posting(value,mode)), cursor: hasNext ? value.cursor as string : null, hasNext };
}

/** Business timestamps are returned as reported; none is treated as a source status version. */
async function readPosting(credentials: Credentials, options: { postingNumber: string }, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<OzonFbsPosting> {
  if (!options || typeof options.postingNumber !== 'string' || !options.postingNumber.trim() || options.postingNumber.length > 256) throw new OzonReadError('invalid_request');
  const value = await readOzonJSON(credentials, mode==='fbs'?'/v3/posting/fbs/get':mode==='fbo'?'/v2/posting/fbo/get':'/v1/posting/fbp/get', JSON.stringify({ posting_number: options.postingNumber,...(mode==='fbp'?{}:{with:{financial_data:true}}) }), fetcher, signal);
  const result = posting(mode==='fbp'?value.posting:value.result,mode,true);
  if (result.postingNumber !== options.postingNumber) invalid();
  return result;
}
return {listPostings,readPosting};
}
export const {listPostings:listOzonFbsPostings,readPosting:readOzonFbsPosting}=postingReader('fbs');
export const {listPostings:listOzonFboPostings,readPosting:readOzonFboPosting}=postingReader('fbo');
export const {listPostings:listOzonFbpPostings,readPosting:readOzonFbpPosting}=postingReader('fbp');
