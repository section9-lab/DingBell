import * as v from 'valibot';
import {request} from './api.ts';

const state=v.picklist(['pending','complete','error']);
const store=v.object({id:v.string(),name:v.string()});
const optionalText=v.nullable(v.string());
const productFields={id:v.string(),store,offerId:v.string(),name:optionalText,sku:optionalText,archived:v.nullable(v.boolean()),hasFboStocks:v.nullable(v.boolean()),hasFbsStocks:v.nullable(v.boolean()),price:optionalText,currency:optionalText,primaryImage:optionalText,images:v.pipe(v.array(v.string()),v.maxLength(20)),state,error:optionalText,listObservedAt:v.string(),factsObservedAt:optionalText};
const product=v.object(productFields);
const productDetail=v.object({...productFields,sources:v.array(v.object({sku:v.string(),source:v.string()}))});
const postingFields={postingNumber:v.string(),store,orderId:v.string(),orderNumber:v.string(),status:optionalText,productCount:v.pipe(v.number(),v.integer(),v.minValue(0)),trackingNumber:optionalText,inProcessAt:optionalText,shipmentDate:optionalText,deliveringDate:optionalText,state,error:optionalText,source:v.picklist(['pending','list','details']),observedAt:optionalText};
const posting=v.object(postingFields);
const postingDetail=v.object({...postingFields,products:v.array(v.object({sku:v.string(),offerId:v.string(),name:optionalText,quantity:v.pipe(v.number(),v.integer(),v.minValue(0)),price:optionalText,currency:optionalText}))});
export type CommerceProduct=v.InferOutput<typeof product>;
export type CommerceProductDetail=v.InferOutput<typeof productDetail>;
export type FbsPosting=v.InferOutput<typeof posting>;
export type FbsPostingDetail=v.InferOutput<typeof postingDetail>;
const base=(companyId:string)=>`/api/companies/${encodeURIComponent(companyId)}/commerce`;
function parameters(values:Record<string,string|number|undefined>){const result=new URLSearchParams();for(const [key,value] of Object.entries(values))if(value!==undefined&&value!=='')result.set(key,String(value));return result.toString();}
export function readCommerceProducts(companyId:string,options:{storeId:string;cursor?:string;limit?:number},signal?:AbortSignal){return request(`${base(companyId)}/products?${parameters(options)}`,v.object({companyId:v.literal(companyId),storeId:v.literal(options.storeId),products:v.array(product),nextCursor:v.nullable(v.string())}),{signal});}
export function readCommerceProduct(companyId:string,storeId:string,id:string,signal?:AbortSignal){return request(`${base(companyId)}/products/${encodeURIComponent(id)}?${parameters({storeId})}`,v.object({companyId:v.literal(companyId),product:productDetail}),{signal});}
export function readFbsPostings(companyId:string,options:{storeId:string;orderNumber?:string;cursor?:string;limit?:number},signal?:AbortSignal){return request(`${base(companyId)}/fbs-postings?${parameters(options)}`,v.object({companyId:v.literal(companyId),storeId:v.literal(options.storeId),postings:v.array(posting),nextCursor:v.nullable(v.string())}),{signal});}
export function readFbsPosting(companyId:string,storeId:string,postingNumber:string,signal?:AbortSignal){return request(`${base(companyId)}/fbs-postings/${encodeURIComponent(postingNumber)}?${parameters({storeId})}`,v.object({companyId:v.literal(companyId),posting:postingDetail}),{signal});}
