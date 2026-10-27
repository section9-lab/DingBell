import type {Context,Hono} from 'hono';
import {apiError,jsonResponse,type ApplicationEnv} from '../../http.ts';
import {companyFor,configured,signedIn} from '../identity/http.ts';
import {findStore,type StoreActor} from '../stores/storage.ts';
import {InvalidCommerceCursor,listCommerceProducts,listFbsPostings,readCommerceProduct,readFbsPosting} from './storage.ts';

const base='/api/companies/:companyId/commerce';
const productId=/^(0|[1-9][0-9]{0,39})$/;
function actor(c:Context<ApplicationEnv>):StoreActor{const identity=c.get('identitySession');return {orgId:c.req.param('companyId')!,actorUserId:identity.user.id,sessionId:identity.session.id};}
function notFound(c:Context<ApplicationEnv>){return apiError(c,'NOT_FOUND','The company, store or commerce record is not available.',404);}
function invalid(c:Context<ApplicationEnv>){return apiError(c,'INVALID_REQUEST','The commerce query or pagination cursor is invalid.',400);}
function query(c:Context<ApplicationEnv>,allowed:string[]){const values=new URL(c.req.url).searchParams;for(const key of values.keys())if(!allowed.includes(key)||values.getAll(key).length!==1)throw new RangeError();return values;}
function value(values:URLSearchParams,key:string,maximum=256){const result=values.get(key);if(result===null)return undefined;if(!result.trim()||result.length>maximum||/[\u0000-\u001f\u007f]/.test(result))throw new RangeError();return result;}
function paging(values:URLSearchParams){const raw=values.get('limit');if(raw!==null&&(!/^[1-9][0-9]?$/.test(raw)||Number(raw)>50))throw new RangeError();return {cursor:value(values,'cursor',4096),limit:raw===null?25:Number(raw)};}
async function scope(c:Context<ApplicationEnv>){const current=actor(c);return await companyFor(c,current.orgId,current.actorUserId)?current:null;}
async function storeScope(c:Context<ApplicationEnv>,current:StoreActor,storeId:string){return !!await findStore(c.env.DB!,current,storeId,false);}
function failed(c:Context<ApplicationEnv>,error:unknown){if(error instanceof RangeError||error instanceof InvalidCommerceCursor)return invalid(c);throw error;}

export function registerCommerceRoutes(app:Hono<ApplicationEnv>){
  app.get(`${base}/products`,configured,signedIn,async c=>{const current=await scope(c);if(!current)return notFound(c);try{const values=query(c,['storeId','cursor','limit']),storeId=value(values,'storeId');if(!storeId)return invalid(c);if(!await storeScope(c,current,storeId))return notFound(c);const page=await listCommerceProducts(c.env.DB!,current,storeId,paging(values).cursor,paging(values).limit);return jsonResponse(c,{companyId:current.orgId,storeId,products:page.items,nextCursor:page.nextCursor});}catch(error){return failed(c,error);}});
  app.get(`${base}/products/:productId`,configured,signedIn,async c=>{const current=await scope(c);if(!current)return notFound(c);try{const values=query(c,['storeId']),storeId=value(values,'storeId'),id=c.req.param('productId')!;if(!storeId||!productId.test(id))return invalid(c);if(!await storeScope(c,current,storeId))return notFound(c);const result=await readCommerceProduct(c.env.DB!,current,storeId,id);return result?jsonResponse(c,{companyId:current.orgId,product:result}):notFound(c);}catch(error){return failed(c,error);}});
  app.get(`${base}/fbs-postings`,configured,signedIn,async c=>{const current=await scope(c);if(!current)return notFound(c);try{const values=query(c,['storeId','orderNumber','cursor','limit']),storeId=value(values,'storeId'),orderNumber=value(values,'orderNumber');if(!storeId)return invalid(c);if(!await storeScope(c,current,storeId))return notFound(c);const page=await listFbsPostings(c.env.DB!,current,storeId,paging(values).cursor,paging(values).limit,orderNumber);return jsonResponse(c,{companyId:current.orgId,storeId,postings:page.items,nextCursor:page.nextCursor});}catch(error){return failed(c,error);}});
  app.get(`${base}/fbs-postings/:postingNumber`,configured,signedIn,async c=>{const current=await scope(c);if(!current)return notFound(c);try{const values=query(c,['storeId']),storeId=value(values,'storeId'),postingNumber=c.req.param('postingNumber')!;if(!storeId||!postingNumber.trim()||postingNumber.length>256)return invalid(c);if(!await storeScope(c,current,storeId))return notFound(c);const result=await readFbsPosting(c.env.DB!,current,storeId,postingNumber);return result?jsonResponse(c,{companyId:current.orgId,posting:result}):notFound(c);}catch(error){return failed(c,error);}});
}
