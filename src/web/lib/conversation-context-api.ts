import * as v from 'valibot';
import { ApiError, request } from './api.ts';

const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const timestamp=v.pipe(v.string(),v.isoTimestamp(),v.check(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value));
const state=v.picklist(['not_provided','not_imported','ambiguous','matched']);
const image=v.pipe(v.string(),v.maxLength(2048),v.check(value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&/(^|\.)ozone\.ru$/i.test(url.hostname);}catch{return false;}}));
const product=v.object({id,offerId:id,name:v.nullable(v.pipe(v.string(),v.maxLength(4096))),price:v.nullable(v.pipe(v.string(),v.maxLength(128),v.regex(/^[0-9]+(?:\.[0-9]+)?$/))),currency:v.nullable(v.pipe(v.string(),v.regex(/^[A-Z]{3}$/))),
  archived:v.nullable(v.boolean()),primaryImage:v.nullable(image),skuSource:v.picklist(['list','details','both']),listObservedAt:timestamp,factsObservedAt:v.nullable(timestamp)});
const orderProduct=v.object({orderId:id,sku:id,offerId:id,name:v.nullable(v.pipe(v.string(),v.maxLength(4096))),productId:v.nullable(id),primaryImage:v.nullable(image)});
const posting=v.object({postingNumber:id,orderId:id,status:v.nullable(id),trackingNumber:v.nullable(id),
  productCount:v.nullable(v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER))),
  source:v.nullable(v.picklist(['list','details'])),observedAt:v.nullable(timestamp),listObservedAt:v.nullable(timestamp),detailObservedAt:v.nullable(timestamp)});
type ContextSource={id:string;platformMessageId:string;orderNumber:string|null;sku:string|null;eventAt:string;receivedAt:string};
type Scope={storeId:string;viewerMemberId:string};
export function readMessageContext(companyId:string,conversationId:string,source:ContextSource,scope:Scope,afterPosting?:string,signal?:AbortSignal){
  for(const value of [companyId,conversationId,source.id,scope.storeId,scope.viewerMemberId,...(afterPosting===undefined?[]:[afterPosting])])if(!v.safeParse(id,value).success)throw new ApiError('INVALID_REQUEST');
  const schema=v.pipe(v.object({companyId:v.literal(companyId),conversationId:v.literal(conversationId),storeId:v.literal(scope.storeId),viewerMemberId:v.literal(scope.viewerMemberId),
    source:v.object({kind:v.literal('ozon_message_context'),messageId:v.literal(source.id),platformMessageId:v.literal(source.platformMessageId),orderNumber:v.pipe(v.nullable(id),v.check(value=>value===source.orderNumber)),sku:v.pipe(v.nullable(id),v.check(value=>value===source.sku)),eventAt:v.pipe(timestamp,v.check(value=>value===source.eventAt)),receivedAt:v.pipe(timestamp,v.check(value=>value===source.receivedAt))}),
    product:v.object({state,item:v.nullable(product)}),order:v.object({state,orderId:v.nullable(id),previewProduct:v.nullable(orderProduct),postings:v.pipe(v.array(posting),v.maxLength(10)),nextPosting:v.nullable(id)}),
  }),
    v.check(value=>(value.product.state==='matched')===(value.product.item!==null)
      &&(value.product.state==='not_provided')===(source.sku===null)
      &&(value.order.state==='not_provided')===(source.orderNumber===null)
      &&(value.order.state==='matched'?value.order.orderId!==null&&value.order.postings.every(p=>p.orderId===value.order.orderId)
        :value.order.orderId===null&&value.order.previewProduct===null&&value.order.postings.length===0&&value.order.nextPosting===null)
      &&(value.order.previewProduct===null||value.order.state==='matched'&&value.order.previewProduct.orderId===value.order.orderId)
      &&new Set(value.order.postings.map(p=>p.postingNumber)).size===value.order.postings.length
      &&value.order.postings.every((p,i)=>p.postingNumber>(i===0?afterPosting??'':value.order.postings[i-1].postingNumber)
        &&p.observedAt===(p.source==='list'?p.listObservedAt:p.source==='details'?p.detailObservedAt:null))
      &&(value.order.nextPosting===null||value.order.postings.length===10&&value.order.nextPosting===value.order.postings.at(-1)?.postingNumber)));
  const path=`/api/companies/${encodeURIComponent(companyId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(source.id)}/context`;
  return request(path+(afterPosting===undefined?'':`?${new URLSearchParams({afterPosting})}`),schema,{signal});
}
