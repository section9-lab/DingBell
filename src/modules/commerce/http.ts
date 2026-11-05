import type {Context,Hono} from 'hono';
import * as v from 'valibot';
import {apiError,jsonResponse,type ApplicationEnv} from '../../http.ts';
import {companyFor,configured,limitedBody,signedIn} from '../identity/http.ts';
import {readCompanySettings} from '../company-settings/storage.ts';
import {findStore,type StoreActor} from '../stores/storage.ts';
import {nextDate,zonedStart} from '../../shared/time-zone.ts';
import {InvalidCommerceCursor,listCommerceProducts,listFbsPostings,readCommerceProduct,readFbsPosting,listOrderPostings,readOrderPosting,writeProductSourcing,type FulfillmentFilter,type FulfillmentType,type PostingRange,type ProductBoolFilter,type ProductFilters} from './storage.ts';

const base='/api/companies/:companyId/commerce';
const productId=/^(0|[1-9][0-9]{0,39})$/;
const sourcingBody=v.pipe(v.strictObject({
  storeId:v.pipe(v.string(),v.minLength(1),v.maxLength(256)),
  supplySource:v.nullable(v.pipe(v.string(),v.trim(),v.minLength(1),v.maxLength(200),v.check(value=>!/[\u0000-\u001f\u007f]/.test(value)))),
  purchaseUrl:v.nullable(v.pipe(v.string(),v.trim(),v.maxLength(2048),v.regex(/^https?:\/\/[^\s]+$/),v.check(value=>{try{const url=new URL(value);return (url.protocol==='https:'||url.protocol==='http:')&&!!url.hostname&&!url.username&&!url.password;}catch{return false;}}))),
  purchasePrice:v.nullable(v.pipe(v.string(),v.regex(/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,4})?$/),v.check(value=>!/^0(\.0+)?$/.test(value)))),
  purchaseCurrency:v.nullable(v.pipe(v.string(),v.regex(/^[A-Z]{3}$/))),
}),v.check(value=>(value.purchasePrice===null)===(value.purchaseCurrency===null)));
function actor(c:Context<ApplicationEnv>):StoreActor{const identity=c.get('identitySession');return {orgId:c.req.param('companyId')!,actorUserId:identity.user.id,sessionId:identity.session.id};}
function notFound(c:Context<ApplicationEnv>){return apiError(c,'NOT_FOUND','The company, store or commerce record is not available.',404);}
function invalid(c:Context<ApplicationEnv>){return apiError(c,'INVALID_REQUEST','The commerce query or pagination cursor is invalid.',400);}
function query(c:Context<ApplicationEnv>,allowed:string[]){const values=new URL(c.req.url).searchParams;for(const key of values.keys())if(!allowed.includes(key)||values.getAll(key).length!==1)throw new RangeError();return values;}
function value(values:URLSearchParams,key:string,maximum=256){const result=values.get(key);if(result===null)return undefined;if(!result.trim()||result.length>maximum||/[\u0000-\u001f\u007f]/.test(result))throw new RangeError();return result;}
function paging(values:URLSearchParams){const raw=values.get('limit');if(raw!==null&&(!/^[1-9][0-9]?$/.test(raw)||Number(raw)>50))throw new RangeError();return {cursor:value(values,'cursor',4096),limit:raw===null?25:Number(raw)};}
async function scope(c:Context<ApplicationEnv>){const current=actor(c);return await companyFor(c,current.orgId,current.actorUserId)?current:null;}
async function storeScope(c:Context<ApplicationEnv>,current:StoreActor,storeId:string){return !!await findStore(c.env.DB!,current,storeId,false);}
function failed(c:Context<ApplicationEnv>,error:unknown){if(error instanceof RangeError||error instanceof InvalidCommerceCursor)return invalid(c);throw error;}
// Inclusive company-local dates become the half-open instant range the posting timeline uses.
function postingRange(values:URLSearchParams,timeZone:string):PostingRange{
  const query=value(values,'q',100),fromDate=value(values,'fromDate',10),toDate=value(values,'toDate',10),range:PostingRange={};
  if(query!==undefined)range.query=query.trim()||undefined;
  if((fromDate===undefined)!==(toDate===undefined))throw new RangeError('INVALID_COMMERCE_PERIOD');
  if(fromDate!==undefined&&toDate!==undefined){
    const from=zonedStart(fromDate,timeZone),to=zonedStart(nextDate(toDate),timeZone),days=(to-from)/86_400_000;
    if(!(days>0)||days>366)throw new RangeError('INVALID_COMMERCE_PERIOD');
    range.from=from;range.to=to;
  }
  return range;
}
const productStates=['pending','complete','error'],triStates=['yes','no','empty'],pairChoices=['filled','empty'];
const priceDecimal=/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,4})?$/;
// Product filters mirror the popover: free-text matches are substring LIKE,
// "empty" flags select missing values, dates are company-local inclusive days.
function productFilters(values:URLSearchParams,timeZone:string){
  const filters:ProductFilters={};
  const trimmed=(key:string,maximum:number)=>{const raw=value(values,key,maximum);const result=raw?.trim();return result?result:undefined;};
  filters.name=trimmed('name',200);filters.offerId=trimmed('offerId',256);filters.sku=trimmed('sku',64);
  const flag=(key:string)=>{const raw=values.get(key);if(raw===null)return;if(raw==='1'){filters[key as 'nameEmpty'|'priceEmpty'|'listedEmpty']=true;return;}throw new RangeError();};
  flag('nameEmpty');flag('priceEmpty');flag('listedEmpty');
  const price=(key:'priceMin'|'priceMax')=>{const raw=value(values,key,32);if(raw===undefined)return;if(!priceDecimal.test(raw))throw new RangeError();filters[key]=Number(raw);};
  price('priceMin');price('priceMax');
  if(filters.priceMin!==undefined&&filters.priceMax!==undefined&&filters.priceMin>filters.priceMax)throw new RangeError();
  const pick=<T extends string>(key:string,allowed:readonly T[])=>{const raw=value(values,key,16);if(raw===undefined)return undefined;if(!allowed.includes(raw as T))throw new RangeError();return raw as T;};
  filters.state=pick('state',productStates as readonly ('pending'|'complete'|'error')[]);
  filters.archived=pick('archived',triStates as readonly ProductBoolFilter[]);
  filters.fbo=pick('fbo',triStates as readonly ProductBoolFilter[]);filters.fbs=pick('fbs',triStates as readonly ProductBoolFilter[]);
  filters.sourcing=pick('sourcing',pairChoices as readonly ('filled'|'empty')[]);filters.costing=pick('costing',pairChoices as readonly ('filled'|'empty')[]);
  const fromDate=value(values,'listedFrom',10),toDate=value(values,'listedTo',10);
  if((fromDate===undefined)!==(toDate===undefined)||fromDate!==undefined&&!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)||toDate!==undefined&&!/^\d{4}-\d{2}-\d{2}$/.test(toDate))throw new RangeError('INVALID_COMMERCE_PERIOD');
  if(fromDate!==undefined&&toDate!==undefined){
    const from=zonedStart(fromDate,timeZone),to=zonedStart(nextDate(toDate),timeZone),days=(to-from)/86_400_000;
    if(!(days>0)||days>366)throw new RangeError('INVALID_COMMERCE_PERIOD');
    filters.listedFrom=from;filters.listedTo=to;
  }
  return filters;
}

export function registerCommerceRoutes(app:Hono<ApplicationEnv>){
  app.get(`${base}/postings`,configured,signedIn,async c=>{const current=await scope(c);if(!current)return notFound(c);try{
    const values=query(c,['storeId','orderNumber','fulfillment','q','fromDate','toDate','cursor','limit']),storeId=value(values,'storeId'),fulfillment=value(values,'fulfillment')??'all';
    if(!storeId||!['all','fbs','fbo','fbp'].includes(fulfillment))return invalid(c);
    if(!await storeScope(c,current,storeId))return notFound(c);
    const timeZone=(await readCompanySettings(c.env.DB!,current))?.timeZone??'UTC',range=postingRange(values,timeZone);
    const page=await listOrderPostings(c.env.DB!,current,storeId,paging(values).cursor,paging(values).limit,value(values,'orderNumber'),fulfillment as FulfillmentFilter,range);
    return jsonResponse(c,{companyId:current.orgId,storeId,postings:page.items,totalOrders:page.totalOrders,totalPostings:page.totalPostings,totalPages:page.totalPages,undatedPostings:page.undatedPostings,nextCursor:page.nextCursor});
  }catch(error){return failed(c,error);}});
  app.get(`${base}/postings/:fulfillmentType/:postingNumber`,configured,signedIn,async c=>{const current=await scope(c);if(!current)return notFound(c);try{
    const values=query(c,['storeId']),storeId=value(values,'storeId'),postingNumber=c.req.param('postingNumber')!,fulfillment=c.req.param('fulfillmentType')!;
    if(!storeId||!['fbs','fbo','fbp'].includes(fulfillment)||!postingNumber.trim()||postingNumber.length>256||/[\u0000-\u001f\u007f]/.test(postingNumber))return invalid(c);
    if(!await storeScope(c,current,storeId))return notFound(c);
    const result=await readOrderPosting(c.env.DB!,current,storeId,postingNumber,fulfillment as FulfillmentType);
    return result?jsonResponse(c,{companyId:current.orgId,posting:result}):notFound(c);
  }catch(error){return failed(c,error);}});
  app.get(`${base}/products`,configured,signedIn,async c=>{const current=await scope(c);if(!current)return notFound(c);try{const values=query(c,['storeId','cursor','limit','name','nameEmpty','offerId','sku','priceMin','priceMax','priceEmpty','state','archived','fbo','fbs','sourcing','costing','listedFrom','listedTo','listedEmpty']),storeId=value(values,'storeId');if(!storeId)return invalid(c);if(!await storeScope(c,current,storeId))return notFound(c);const timeZone=(await readCompanySettings(c.env.DB!,current))?.timeZone??'UTC';const page=await listCommerceProducts(c.env.DB!,current,storeId,paging(values).cursor,paging(values).limit,productFilters(values,timeZone));return jsonResponse(c,{companyId:current.orgId,storeId,products:page.items,totalProducts:page.totalProducts,totalPages:page.totalPages,nextCursor:page.nextCursor});}catch(error){return failed(c,error);}});
  app.get(`${base}/products/:productId`,configured,signedIn,async c=>{const current=await scope(c);if(!current)return notFound(c);try{const values=query(c,['storeId']),storeId=value(values,'storeId'),id=c.req.param('productId')!;if(!storeId||!productId.test(id))return invalid(c);if(!await storeScope(c,current,storeId))return notFound(c);const result=await readCommerceProduct(c.env.DB!,current,storeId,id);return result?jsonResponse(c,{companyId:current.orgId,product:result}):notFound(c);}catch(error){return failed(c,error);}});
  app.post(`${base}/products/:productId/sourcing`,configured,limitedBody,signedIn,async c=>{
    const current=actor(c),company=await companyFor(c,current.orgId,current.actorUserId);
    if(!company)return notFound(c);
    if(company.role!=='owner'&&company.role!=='admin')return apiError(c,'FORBIDDEN','Only company owners and administrators may record sourcing facts.',403);
    const parsed=v.safeParse(sourcingBody,await c.req.json().catch(()=>null));if(!parsed.success)return invalid(c);
    const id=c.req.param('productId')!,{storeId,supplySource,purchaseUrl,purchasePrice,purchaseCurrency}=parsed.output;
    if(!productId.test(id))return invalid(c);
    try{
      if(!await storeScope(c,current,storeId))return notFound(c);
      const result=await writeProductSourcing(c.env.DB!,current,storeId,id,{supplySource,purchaseUrl,purchasePrice,purchaseCurrency});
      return result===undefined?notFound(c):jsonResponse(c,{companyId:current.orgId,productId:id,sourcing:result});
    }catch(error){return failed(c,error);}
  });
  app.get(`${base}/fbs-postings`,configured,signedIn,async c=>{const current=await scope(c);if(!current)return notFound(c);try{const values=query(c,['storeId','orderNumber','cursor','limit']),storeId=value(values,'storeId'),orderNumber=value(values,'orderNumber');if(!storeId)return invalid(c);if(!await storeScope(c,current,storeId))return notFound(c);const page=await listFbsPostings(c.env.DB!,current,storeId,paging(values).cursor,paging(values).limit,orderNumber);return jsonResponse(c,{companyId:current.orgId,storeId,postings:page.items,totalOrders:page.totalOrders,totalPostings:page.totalPostings,totalPages:page.totalPages,nextCursor:page.nextCursor});}catch(error){return failed(c,error);}});
  app.get(`${base}/fbs-postings/:postingNumber`,configured,signedIn,async c=>{const current=await scope(c);if(!current)return notFound(c);try{const values=query(c,['storeId']),storeId=value(values,'storeId'),postingNumber=c.req.param('postingNumber')!;if(!storeId||!postingNumber.trim()||postingNumber.length>256)return invalid(c);if(!await storeScope(c,current,storeId))return notFound(c);const result=await readFbsPosting(c.env.DB!,current,storeId,postingNumber);return result?jsonResponse(c,{companyId:current.orgId,posting:result}):notFound(c);}catch(error){return failed(c,error);}});
}
