import { storeAccess, type StoreActor } from '../stores/storage.ts';

const productIdPattern=/^(0|[1-9][0-9]{0,39})$/;
const maximumTime=8_640_000_000_000_000;
export class InvalidCommerceCursor extends Error {constructor(){super('INVALID_COMMERCE_CURSOR');this.name='InvalidCommerceCursor';}}

type ProductRow={id:string;storeId:string;storeName:string;listing:string;facts:string|null;listObservedAt:number;factsObservedAt:number|null;state:string;error:string|null};
type PostingRow={postingNumber:string;storeId:string;storeName:string;orderId:string;orderNumber:string;listFacts:string|null;detailFacts:string|null;listObservedAt:number|null;detailObservedAt:number|null;state:string;error:string|null};
type ProductCursor={v:1;kind:'products';orgId:string;storeId:string;id:string};
type PostingCursor={v:1;kind:'fbs-postings';orgId:string;storeId:string;orderNumber:string|null;observedAt:number;postingNumber:string};

function base64url(bytes:Uint8Array){return btoa(Array.from(bytes,byte=>String.fromCharCode(byte)).join('')).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
function encode(value:unknown){return base64url(new TextEncoder().encode(JSON.stringify(value)));}
function decode(value:string):unknown{
  if(!value||value.length>4096||!/^[A-Za-z0-9_-]+$/.test(value))throw new InvalidCommerceCursor();
  try{const bytes=Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),character=>character.charCodeAt(0));if(base64url(bytes)!==value)throw new Error();return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));}
  catch{throw new InvalidCommerceCursor();}
}
function object(value:string|null){if(value===null)return null;const parsed=JSON.parse(value) as unknown;if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('INVALID_COMMERCE_DATA');return parsed as Record<string,unknown>;}
function text(value:unknown,nullable=false){if(value===null&&nullable)return null;if(typeof value!=='string')throw new Error('INVALID_COMMERCE_DATA');return value;}
function nullableBoolean(value:unknown){if(value===null||value===undefined)return null;if(typeof value!=='boolean')throw new Error('INVALID_COMMERCE_DATA');return value;}
function nullableDecimal(value:unknown){if(value===null||value===undefined)return null;if(typeof value!=='string'||!/^[0-9]+(?:\.[0-9]+)?$/.test(value))throw new Error('INVALID_COMMERCE_DATA');return value;}
function productImage(value:unknown){if(typeof value!=='string'||!value||value.length>2048)throw new Error('INVALID_COMMERCE_DATA');try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!/(^|\.)ozone\.ru$/i.test(url.hostname))throw new Error();}catch{throw new Error('INVALID_COMMERCE_DATA');}return value;}
function productDTO(row:ProductRow){
  const listing=object(row.listing)!;const facts=object(row.facts);
  const id=text(listing.id);if(id!==row.id||!productIdPattern.test(id))throw new Error('INVALID_COMMERCE_DATA');
  const offerId=text(facts?.offerId??listing.offerId),sku=text(facts?.sku??listing.sku,true),name=text(facts?.name??null,true);
  const archived=nullableBoolean(facts?.archived??listing.archived),hasFboStocks=nullableBoolean(listing.hasFboStocks),hasFbsStocks=nullableBoolean(listing.hasFbsStocks);
  const price=nullableDecimal(facts?.price),currency=text(facts?.currency??null,true),rawImages=facts?.images??[];
  if(!Array.isArray(rawImages)||rawImages.length>20)throw new Error('INVALID_COMMERCE_DATA');const images=rawImages.map(productImage),primaryImage=facts?.primaryImage===undefined||facts.primaryImage===null?images[0]??null:productImage(facts.primaryImage);if(primaryImage!==null&&!images.includes(primaryImage))throw new Error('INVALID_COMMERCE_DATA');
  if(!['pending','complete','error'].includes(row.state))throw new Error('INVALID_COMMERCE_DATA');
  return {id:row.id,store:{id:row.storeId,name:row.storeName},offerId,name,sku,archived,hasFboStocks,hasFbsStocks,price,currency,primaryImage,images,
    state:row.state as 'pending'|'complete'|'error',error:row.error,listObservedAt:new Date(row.listObservedAt).toISOString(),factsObservedAt:row.factsObservedAt===null?null:new Date(row.factsObservedAt).toISOString()};
}
function productDetailDTO(row:ProductRow){const dto=productDTO(row),facts=object(row.facts),raw=facts?.sources??[];if(!Array.isArray(raw))throw new Error('INVALID_COMMERCE_DATA');const sources=raw.map(value=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_COMMERCE_DATA');const source=value as Record<string,unknown>;return {sku:text(source.sku),source:text(source.source)};});return {...dto,sources};}
function postingDTO(row:PostingRow){
  const raw=object(row.detailFacts)??object(row.listFacts);if(!['pending','complete','error'].includes(row.state))throw new Error('INVALID_COMMERCE_DATA');
  if(raw&&text(raw.postingNumber)!==row.postingNumber)throw new Error('INVALID_COMMERCE_DATA');
  const products=raw?.products;if(products!==undefined&&!Array.isArray(products))throw new Error('INVALID_COMMERCE_DATA');
  const observedAt=row.detailObservedAt??row.listObservedAt;
  return {postingNumber:row.postingNumber,store:{id:row.storeId,name:row.storeName},orderId:row.orderId,orderNumber:row.orderNumber,
    status:raw?text(raw.status):null,productCount:Array.isArray(products)?products.length:0,trackingNumber:raw?text(raw.trackingNumber??null,true):null,
    inProcessAt:raw?text(raw.inProcessAt??null,true):null,shipmentDate:raw?text(raw.shipmentDate??null,true):null,deliveringDate:raw?text(raw.deliveringDate??null,true):null,
    state:row.state as 'pending'|'complete'|'error',error:row.error,source:row.detailFacts!==null?'details' as const:row.listFacts!==null?'list' as const:'pending' as const,
    observedAt:observedAt===null?null:new Date(observedAt).toISOString()};
}
function postingDetailDTO(row:PostingRow){const dto=postingDTO(row),raw=object(row.detailFacts)??object(row.listFacts),items=raw?.products??[];if(!Array.isArray(items))throw new Error('INVALID_COMMERCE_DATA');const products=items.map(value=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_COMMERCE_DATA');const item=value as Record<string,unknown>;const quantity=item.quantity;if(typeof quantity!=='number'||!Number.isSafeInteger(quantity)||quantity<0)throw new Error('INVALID_COMMERCE_DATA');return {sku:text(item.sku),offerId:text(item.offerId),name:text(item.name??null,true),quantity,price:nullableDecimal(item.price),currency:text(item.currency??null,true)};});return {...dto,products};}
function productCursor(value:string|undefined,actor:StoreActor,storeId:string){if(value===undefined)return undefined;const parsed=decode(value) as Partial<ProductCursor>;if(parsed?.v!==1||parsed.kind!=='products'||parsed.orgId!==actor.orgId||parsed.storeId!==storeId||typeof parsed.id!=='string'||!productIdPattern.test(parsed.id))throw new InvalidCommerceCursor();return parsed as ProductCursor;}
function postingCursor(value:string|undefined,actor:StoreActor,storeId:string,orderNumber?:string){if(value===undefined)return undefined;const parsed=decode(value) as Partial<PostingCursor>;if(parsed?.v!==1||parsed.kind!=='fbs-postings'||parsed.orgId!==actor.orgId||parsed.storeId!==storeId||parsed.orderNumber!==(orderNumber??null)||typeof parsed.postingNumber!=='string'||!parsed.postingNumber||parsed.postingNumber.length>256||typeof parsed.observedAt!=='number'||!Number.isSafeInteger(parsed.observedAt)||parsed.observedAt<0||parsed.observedAt>maximumTime)throw new InvalidCommerceCursor();return parsed as PostingCursor;}

export async function listCommerceProducts(db:D1Database,actor:StoreActor,storeId:string,cursor:string|undefined,limit:number){
  const edge=productCursor(cursor,actor,storeId);const rows=(await db.prepare(`SELECT product.id,store.id AS storeId,store.name AS storeName,product.listing,product.facts,product.list_observed_at AS listObservedAt,
    product.facts_observed_at AS factsObservedAt,product.detail_state AS state,product.detail_error AS error FROM product JOIN store ON store.id=product.store_id AND store.organization_id=product.organization_id
    WHERE product.organization_id=? AND product.store_id=? AND product.id>? AND ${storeAccess('store.organization_id',false)} ORDER BY product.id LIMIT ?`)
    .bind(actor.orgId,storeId,edge?.id??'',actor.actorUserId,actor.sessionId,limit+1).all<ProductRow>()).results;
  const items=rows.slice(0,limit).map(productDTO),last=items.at(-1);return {items,nextCursor:rows.length>limit&&last?encode({v:1,kind:'products',orgId:actor.orgId,storeId,id:last.id} satisfies ProductCursor):null};
}
export async function readCommerceProduct(db:D1Database,actor:StoreActor,storeId:string,id:string){
  const row=await db.prepare(`SELECT product.id,store.id AS storeId,store.name AS storeName,product.listing,product.facts,product.list_observed_at AS listObservedAt,
    product.facts_observed_at AS factsObservedAt,product.detail_state AS state,product.detail_error AS error FROM product JOIN store ON store.id=product.store_id AND store.organization_id=product.organization_id
    WHERE product.organization_id=? AND product.store_id=? AND product.id=? AND ${storeAccess('store.organization_id',false)}`).bind(actor.orgId,storeId,id,actor.actorUserId,actor.sessionId).first<ProductRow>();
  return row?productDetailDTO(row):null;
}
export async function listFbsPostings(db:D1Database,actor:StoreActor,storeId:string,cursor:string|undefined,limit:number,orderNumber?:string){
  const edge=postingCursor(cursor,actor,storeId,orderNumber),where=[`posting.organization_id=?`,`posting.store_id=?`,storeAccess('store.organization_id',false)],values:(string|number)[]=[actor.orgId,storeId,actor.actorUserId,actor.sessionId];
  if(orderNumber!==undefined){where.push('posting.order_number=?');values.push(orderNumber);}
  if(edge){where.push(`(COALESCE(posting.detail_observed_at,posting.list_observed_at,0)<? OR (COALESCE(posting.detail_observed_at,posting.list_observed_at,0)=? AND posting.posting_number<?))`);values.push(edge.observedAt,edge.observedAt,edge.postingNumber);}
  const rows=(await db.prepare(`SELECT posting.posting_number AS postingNumber,store.id AS storeId,store.name AS storeName,posting.order_id AS orderId,posting.order_number AS orderNumber,
    posting.list_facts AS listFacts,posting.detail_facts AS detailFacts,posting.list_observed_at AS listObservedAt,posting.detail_observed_at AS detailObservedAt,
    posting.detail_state AS state,posting.detail_error AS error FROM fbs_posting AS posting JOIN store ON store.id=posting.store_id AND store.organization_id=posting.organization_id
    WHERE ${where.join(' AND ')} ORDER BY COALESCE(posting.detail_observed_at,posting.list_observed_at,0) DESC,posting.posting_number DESC LIMIT ?`).bind(...values,limit+1).all<PostingRow>()).results;
  const items=rows.slice(0,limit).map(postingDTO),lastRow=rows[Math.min(limit,rows.length)-1],last=items.at(-1),observedAt=lastRow?(lastRow.detailObservedAt??lastRow.listObservedAt??0):0;
  return {items,nextCursor:rows.length>limit&&last?encode({v:1,kind:'fbs-postings',orgId:actor.orgId,storeId,orderNumber:orderNumber??null,observedAt,postingNumber:last.postingNumber} satisfies PostingCursor):null};
}
export async function readFbsPosting(db:D1Database,actor:StoreActor,storeId:string,postingNumber:string){
  const row=await db.prepare(`SELECT posting.posting_number AS postingNumber,store.id AS storeId,store.name AS storeName,posting.order_id AS orderId,posting.order_number AS orderNumber,
    posting.list_facts AS listFacts,posting.detail_facts AS detailFacts,posting.list_observed_at AS listObservedAt,posting.detail_observed_at AS detailObservedAt,
    posting.detail_state AS state,posting.detail_error AS error FROM fbs_posting AS posting JOIN store ON store.id=posting.store_id AND store.organization_id=posting.organization_id
    WHERE posting.organization_id=? AND posting.store_id=? AND posting.posting_number=? AND ${storeAccess('store.organization_id',false)}`)
    .bind(actor.orgId,storeId,postingNumber,actor.actorUserId,actor.sessionId).first<PostingRow>();return row?postingDetailDTO(row):null;
}
