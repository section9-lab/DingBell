import * as v from 'valibot';
import {request} from './api.ts';

const state=v.picklist(['pending','complete','error']);
const store=v.object({id:v.string(),name:v.string()});
const optionalText=v.nullable(v.string());
const sourcing=v.nullable(v.object({supplySource:optionalText,purchaseUrl:optionalText,purchasePrice:optionalText,purchaseCurrency:optionalText,updatedAt:v.string(),updatedByName:v.string()}));
const costing=v.nullable(v.object({purchasePrice:v.string(),purchaseCurrency:v.string(),labelFee:optionalText,weightGrams:v.nullable(v.number()),commissionRate:optionalText,listPrice:optionalText,promoDiscount:optionalText,supplySource:optionalText,validFrom:v.string()}));
const productFields={id:v.string(),store,offerId:v.string(),name:optionalText,sku:optionalText,archived:v.nullable(v.boolean()),hasFboStocks:v.nullable(v.boolean()),hasFbsStocks:v.nullable(v.boolean()),price:optionalText,currency:optionalText,primaryImage:optionalText,images:v.pipe(v.array(v.string()),v.maxLength(20)),createdAt:optionalText,sourcing,costing,state,error:optionalText,listObservedAt:v.string(),factsObservedAt:optionalText};
const product=v.object(productFields);
const productDetail=v.object({...productFields,sources:v.array(v.object({sku:v.string(),source:v.string()}))});
const postingImage=v.nullable(v.pipe(v.string(),v.maxLength(2048),v.check(value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&/(^|\.)ozone\.ru$/i.test(url.hostname);}catch{return false;}})));
const postingFields={previewProduct:v.nullable(v.object({sku:v.string(),name:optionalText,primaryImage:postingImage})),postingNumber:v.string(),store,orderId:v.string(),orderNumber:v.string(),status:optionalText,orderDate:v.optional(optionalText,null),orderTime:v.optional(optionalText,null),orderTimeSource:v.optional(v.nullable(v.picklist(['order_date','created_at','in_process_at'])),null),substatus:v.optional(optionalText,null),statusIsCode:v.optional(v.boolean(),false),productCount:v.pipe(v.number(),v.integer(),v.minValue(0)),trackingNumber:optionalText,inProcessAt:optionalText,shipmentDate:optionalText,deliveringDate:optionalText,state,error:optionalText,source:v.picklist(['pending','list','details']),observedAt:optionalText};
const posting=v.object(postingFields);
const postingDetail=v.object({...postingFields,products:v.array(v.object({sku:v.string(),offerId:v.string(),name:optionalText,quantity:v.pipe(v.number(),v.integer(),v.minValue(0)),price:optionalText,currency:optionalText,primaryImage:postingImage}))});
const orderPosting=v.object({...postingFields,fulfillmentType:v.picklist(['fbs','fbo','fbp'])});
const orderPostingDetail=v.object({...postingDetail.entries,fulfillmentType:v.picklist(['fbs','fbo','fbp'])});
export type FulfillmentType='fbs'|'fbo'|'fbp';
export type FulfillmentFilter=FulfillmentType|'all';
export type OrderPosting=v.InferOutput<typeof orderPosting>;
export type CommerceProduct=v.InferOutput<typeof product>;
export type ProductSourcing=v.InferOutput<typeof sourcing>;
export type CommerceProductDetail=v.InferOutput<typeof productDetail>;
export type FbsPosting=v.InferOutput<typeof posting>;
export type FbsPostingDetail=v.InferOutput<typeof postingDetail>;
const base=(companyId:string)=>`/api/companies/${encodeURIComponent(companyId)}/commerce`;
function parameters(values:Record<string,string|number|undefined>){const result=new URLSearchParams();for(const [key,value] of Object.entries(values))if(value!==undefined&&value!=='')result.set(key,String(value));return result.toString();}
export type ProductFilterOptions={name?:string;nameEmpty?:boolean;offerId?:string;sku?:string;priceMin?:number;priceMax?:number;priceEmpty?:boolean;state?:'pending'|'complete'|'error';archived?:'yes'|'no'|'empty';fbo?:'yes'|'no'|'empty';fbs?:'yes'|'no'|'empty';sourcing?:'filled'|'empty';costing?:'filled'|'empty';listedFrom?:string;listedTo?:string;listedEmpty?:boolean};
export function readCommerceProducts(companyId:string,options:{storeId:string;cursor?:string;limit?:number;filters?:ProductFilterOptions},signal?:AbortSignal){
  const filters=options.filters??{},search=parameters({storeId:options.storeId,cursor:options.cursor,limit:options.limit,
    name:filters.name,offerId:filters.offerId,sku:filters.sku,priceMin:filters.priceMin,priceMax:filters.priceMax,
    nameEmpty:filters.nameEmpty?'1':undefined,priceEmpty:filters.priceEmpty?'1':undefined,listedEmpty:filters.listedEmpty?'1':undefined,state:filters.state,
    archived:filters.archived,fbo:filters.fbo,fbs:filters.fbs,sourcing:filters.sourcing,costing:filters.costing,listedFrom:filters.listedFrom,listedTo:filters.listedTo});
  return request(`${base(companyId)}/products?${search}`,v.object({companyId:v.literal(companyId),storeId:v.literal(options.storeId),products:v.array(product),totalProducts:v.number(),totalPages:v.number(),nextCursor:v.nullable(v.string())}),{signal});
}
export function readCommerceProduct(companyId:string,storeId:string,id:string,signal?:AbortSignal){return request(`${base(companyId)}/products/${encodeURIComponent(id)}?${parameters({storeId})}`,v.object({companyId:v.literal(companyId),product:productDetail}),{signal});}
export function saveProductSourcing(companyId:string,id:string,input:{storeId:string;supplySource:string|null;purchaseUrl:string|null;purchasePrice:string|null;purchaseCurrency:string|null}){
  return request(`${base(companyId)}/products/${encodeURIComponent(id)}/sourcing`,v.object({companyId:v.literal(companyId),productId:v.literal(id),sourcing}),{method:'POST',body:JSON.stringify(input)});
}
export function readOrderPostings(companyId:string,options:{storeId:string;fulfillment:FulfillmentFilter;orderNumber?:string;query?:string;fromDate?:string;toDate?:string;cursor?:string;limit?:number},signal?:AbortSignal){
  const search=parameters({storeId:options.storeId,fulfillment:options.fulfillment,orderNumber:options.orderNumber,q:options.query,fromDate:options.fromDate,toDate:options.toDate,cursor:options.cursor,limit:options.limit});
  return request(`${base(companyId)}/postings?${search}`,v.object({companyId:v.literal(companyId),storeId:v.literal(options.storeId),postings:v.pipe(v.array(orderPosting),v.maxLength(50),v.check(items=>items.every(item=>item.store.id===options.storeId&&(options.fulfillment==='all'||item.fulfillmentType===options.fulfillment)))),totalOrders:v.pipe(v.number(),v.integer(),v.minValue(0)),totalPostings:v.pipe(v.number(),v.integer(),v.minValue(0)),totalPages:v.pipe(v.number(),v.integer(),v.minValue(0)),undatedPostings:v.optional(v.pipe(v.number(),v.integer(),v.minValue(0)),0),nextCursor:v.nullable(v.string())}),{signal});
}
export function readOrderPosting(companyId:string,storeId:string,fulfillmentType:FulfillmentType,postingNumber:string,signal?:AbortSignal){
  return request(`${base(companyId)}/postings/${fulfillmentType}/${encodeURIComponent(postingNumber)}?${parameters({storeId})}`,v.object({companyId:v.literal(companyId),posting:v.pipe(orderPostingDetail,v.check(value=>value.store.id===storeId&&value.fulfillmentType===fulfillmentType&&value.postingNumber===postingNumber))}),{signal});
}
export function readFbsPostings(companyId:string,options:{storeId:string;orderNumber?:string;cursor?:string;limit?:number},signal?:AbortSignal){return request(`${base(companyId)}/fbs-postings?${parameters(options)}`,v.object({companyId:v.literal(companyId),storeId:v.literal(options.storeId),postings:v.array(posting),totalOrders:v.pipe(v.number(),v.integer(),v.minValue(0)),totalPostings:v.pipe(v.number(),v.integer(),v.minValue(0)),totalPages:v.pipe(v.number(),v.integer(),v.minValue(0)),nextCursor:v.nullable(v.string())}),{signal});}
export function readFbsPosting(companyId:string,storeId:string,postingNumber:string,signal?:AbortSignal){return request(`${base(companyId)}/fbs-postings/${encodeURIComponent(postingNumber)}?${parameters({storeId})}`,v.object({companyId:v.literal(companyId),posting:postingDetail}),{signal});}
