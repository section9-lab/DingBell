import { storeAccess, type StoreActor } from '../stores/storage.ts';

interface Source {
  storeId:string;viewerMemberId:string;messageId:string;platformMessageId:string;
  orderNumber:string|null;sku:string|null;eventAt:number;receivedAt:number;
}
interface ProductRow {
  id:string;offerId:string;name:string|null;price:string|null;currency:string|null;archived:number|null;
  skuSource:'list'|'details'|'both';listObservedAt:number;factsObservedAt:number|null;
}
interface PostingRow {
  postingNumber:string;orderId:string;status:string|null;trackingNumber:string|null;productCount:number|null;
  source:'list'|'details'|null;observedAt:number|null;listObservedAt:number|null;detailObservedAt:number|null;
}
const time=(value:number|null)=>value===null?null:new Date(value).toISOString();
function identifier(value:string){if(!value.trim()||value.length>256||/[\u0000-\u001f\u007f]/.test(value))throw new RangeError('Invalid identifier.');}

/** References come only from stored platform metadata; callers cannot supply an order number or SKU. */
export async function readMessageContext(db:D1Database,actor:StoreActor,conversationId:string,messageId:string,afterPosting?:string){
  identifier(conversationId);identifier(messageId);if(afterPosting!==undefined)identifier(afterPosting);
  const source=()=>db.prepare(`SELECT store.id AS storeId,member.id AS viewerMemberId,message.id AS messageId,
      message.platform_message_id AS platformMessageId,message.order_number AS orderNumber,message.sku,
      message.event_at AS eventAt,message.received_at AS receivedAt
    FROM message JOIN conversation ON conversation.id=message.conversation_id AND conversation.organization_id=message.organization_id AND conversation.store_id=message.store_id
    JOIN store ON store.id=conversation.store_id AND store.organization_id=conversation.organization_id
    JOIN member ON member.organization_id=store.organization_id AND member.user_id=?
    WHERE message.id=? AND conversation.id=? AND message.organization_id=? AND ${storeAccess('store.organization_id',false)}`)
    .bind(actor.actorUserId,messageId,conversationId,actor.orgId,actor.actorUserId,actor.sessionId).first<Source>();
  const before=await source();if(!before)return null;
  const {storeId,sku,orderNumber}=before;
  const productRows=sku===null?[]:(await db.prepare(`SELECT product.id,COALESCE(json_extract(facts,'$.offerId'),json_extract(listing,'$.offerId')) AS offerId,
      json_extract(facts,'$.name') AS name,json_extract(facts,'$.price') AS price,json_extract(facts,'$.currency') AS currency,
      json_extract(facts,'$.archived') AS archived,product.list_observed_at AS listObservedAt,product.facts_observed_at AS factsObservedAt,
      CASE WHEN MIN(alias.source)!=MAX(alias.source) THEN 'both' ELSE MIN(alias.source) END AS skuSource
    FROM product_sku AS alias JOIN product ON product.id=alias.product_id AND product.store_id=alias.store_id AND product.organization_id=alias.organization_id
    WHERE alias.organization_id=? AND alias.store_id=? AND alias.sku=? GROUP BY product.id ORDER BY product.id LIMIT 2`)
    .bind(actor.orgId,storeId,sku).all<ProductRow>()).results;
  const item=productRows.length===1?productRows[0]:null;
  const product={state:sku===null?'not_provided':productRows.length===0?'not_imported':item?'matched':'ambiguous',
    item:item?{...item,archived:item.archived===null?null:!!item.archived,listObservedAt:time(item.listObservedAt),factsObservedAt:time(item.factsObservedAt)}:null};
  let identities:{orderId:string}[]=[],postings:PostingRow[]=[];
  if(orderNumber!==null){
    // D1 batch is a transaction: ambiguity and the bounded page observe the same order snapshot.
    const [ids,rows]=await db.batch([
      db.prepare(`SELECT DISTINCT order_id AS orderId FROM fbs_posting WHERE organization_id=? AND store_id=? AND order_number=? ORDER BY order_id LIMIT 2`).bind(actor.orgId,storeId,orderNumber),
      db.prepare(`WITH snapshots AS (
        SELECT *,CASE WHEN detail_facts IS NOT NULL AND (list_facts IS NULL OR detail_observed_at>=list_observed_at) THEN 'details'
          WHEN list_facts IS NOT NULL THEN 'list' ELSE NULL END AS source
        FROM fbs_posting WHERE organization_id=? AND store_id=? AND order_number=? AND posting_number>? ORDER BY posting_number LIMIT 11
      ), selected AS (SELECT *,CASE source WHEN 'details' THEN detail_facts ELSE list_facts END AS facts,
        CASE source WHEN 'details' THEN detail_observed_at ELSE list_observed_at END AS observedAt FROM snapshots)
      SELECT posting_number AS postingNumber,order_id AS orderId,source,observedAt,list_observed_at AS listObservedAt,detail_observed_at AS detailObservedAt,
        json_extract(facts,'$.status') AS status,json_extract(facts,'$.trackingNumber') AS trackingNumber,
        CASE WHEN json_type(facts,'$.products')='array' THEN json_array_length(facts,'$.products') ELSE NULL END AS productCount
      FROM selected ORDER BY posting_number`).bind(actor.orgId,storeId,orderNumber,afterPosting??''),
    ]);
    identities=ids.results as unknown as typeof identities;postings=rows.results as unknown as typeof postings;
  }
  const matched=identities.length===1,page=matched?postings.slice(0,10):[];
  // Recheck membership, session, grant and source after all I/O. A replacement membership is a new viewer.
  const after=await source();if(!after||JSON.stringify(before)!==JSON.stringify(after))return null;
  return {companyId:actor.orgId,conversationId,storeId,viewerMemberId:before.viewerMemberId,
    source:{kind:'ozon_message_context' as const,messageId:before.messageId,platformMessageId:before.platformMessageId,orderNumber,sku,eventAt:time(before.eventAt),receivedAt:time(before.receivedAt)},
    product,order:{state:orderNumber===null?'not_provided':identities.length===0?'not_imported':matched?'matched':'ambiguous',orderId:matched?identities[0].orderId:null,
      postings:page.map(row=>({...row,observedAt:time(row.observedAt),listObservedAt:time(row.listObservedAt),detailObservedAt:time(row.detailObservedAt)})),
      nextPosting:matched&&postings.length>10?page.at(-1)!.postingNumber:null}};
}
