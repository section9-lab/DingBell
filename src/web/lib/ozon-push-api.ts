import * as v from 'valibot';
import {pushViewSchema,type PushCommand} from '../../shared/ozon-push.ts';
import {request,ApiError} from './api.ts';
const path=(companyId:string,storeId:string)=>`/api/companies/${encodeURIComponent(companyId)}/stores/${encodeURIComponent(storeId)}/push`;
const receipt=(storeId:string)=>v.object({push:v.pipe(pushViewSchema,v.check(value=>value.storeId===storeId))});
export function readPush(companyId:string,storeId:string,signal?:AbortSignal){return request(path(companyId,storeId),receipt(storeId),{signal});}
export function changePush(companyId:string,storeId:string,command:PushCommand){return request(path(companyId,storeId),receipt(storeId),{method:'POST',body:JSON.stringify(command)});}
/** Exercise the real receiver, locally and anonymously. The simulation flag can only suppress automation. */
export async function simulatePush(callbackUrl:string,body:string){
 const url=new URL(callbackUrl);if(!/^\/api\/ozon\/push\/[a-f0-9-]{36}\/[A-Za-z0-9_-]{43}$/.test(url.pathname)||url.search||url.hash)throw new ApiError('INVALID_RESPONSE');
 const response=await fetch(url.pathname,{method:'POST',credentials:'omit',headers:{'content-type':'application/json','X-DingBell-Local-Simulation':'1'},body,signal:AbortSignal.timeout(10_000)});
 const value:unknown=await response.json().catch(()=>null);if(!response.ok){const parsed=v.safeParse(v.object({error:v.object({code:v.string()})}),value);throw new ApiError(parsed.success?parsed.output.error.code:'OPERATION_UNCONFIRMED');}
 if(!v.is(v.union([v.object({result:v.literal(true)}),v.object({version:v.string(),name:v.string(),time:v.pipe(v.string(),v.isoTimestamp())})]),value))throw new ApiError('INVALID_RESPONSE');
}
