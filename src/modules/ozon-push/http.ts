import type {Context,Hono} from 'hono';
import * as v from 'valibot';
import {apiError,jsonResponse,type ApplicationEnv} from '../../http.ts';
import {pushCommandSchema} from '../../shared/ozon-push.ts';
import {configured,signedIn,limitedBody,companyFor} from '../identity/http.ts';
import {findStore,type StoreActor} from '../stores/storage.ts';
import {credentialConfig} from '../stores/credentials.ts';
import {repairPushHistory,enqueueReconcile,retryPush,changePushMode,acceptPush,createEndpoint,endpointById,readEndpoint,pushView} from './storage.ts';
import {normalizePush,parsePushJSON,pushDedupeKey,pushSeller,pushType} from './protocol.ts';
import {syncConfigured,wakeStoreSync} from '../sync/bindings.ts';
import {equalHash,localPushMode,newPushToken,openPushSecret,pushCallbackUrl,pushHash,sealPushSecret} from './security.ts';
const base='/api/companies/:companyId/stores/:storeId/push';
function actor(c:Context<ApplicationEnv>):StoreActor{const session=c.get('identitySession');return {orgId:c.req.param('companyId')!,actorUserId:session.user.id,sessionId:session.session.id};}
const notFound=(c:Context<ApplicationEnv>)=>apiError(c,'NOT_FOUND','The store or callback is unavailable.',404);
const conflict=(c:Context<ApplicationEnv>)=>apiError(c,'PUSH_CHANGED','Read the current Push configuration before continuing.',409);
async function bodyText(request:Request){if(!request.body)return '';const reader=request.body.getReader(),parts:Uint8Array[]=[];let length=0;try{for(;;){const item=await reader.read();if(item.done)break;length+=item.value.byteLength;if(length>1_048_576)throw new RangeError('PUSH_TOO_LARGE');parts.push(item.value);}const all=new Uint8Array(length);let offset=0;for(const part of parts){all.set(part,offset);offset+=part.length;}return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(all);}finally{await reader.cancel().catch(()=>{});}}
export function registerPushRoutes(app:Hono<ApplicationEnv>){
 app.get(base,configured,signedIn,async c=>{
  const who=actor(c),storeId=c.req.param('storeId')!,db=c.env.DB!;if(!await findStore(db,who,storeId,false))return notFound(c);
  const view=await pushView(db,{orgId:who.orgId,storeId},localPushMode(c.env.APP_BASE_URL));
  return await findStore(db,who,storeId,false)?jsonResponse(c,{push:view}):notFound(c);
 });
 app.post(base,configured,limitedBody,signedIn,async c=>{
  const who=actor(c),storeId=c.req.param('storeId')!,company=await companyFor(c,who.orgId,who.actorUserId);if(!company)return notFound(c);
  if(company.role!=='owner'&&company.role!=='admin')return apiError(c,'FORBIDDEN','Only managers may configure Push.',403);
  if(!await findStore(c.env.DB!,who,storeId,true))return notFound(c);
  const parsed=v.safeParse(pushCommandSchema,await c.req.json().catch(()=>null));if(!parsed.success)return apiError(c,'INVALID_REQUEST','Invalid Push command.',400);
  const command=parsed.output,db=c.env.DB!,scope={orgId:who.orgId,storeId},current=await readEndpoint(db,scope);if((current?.revision??0)!==command.expectedRevision)return conflict(c);
  let callbackUrl:string|undefined;
  try{
   if(command.operation==='prepare'){
    if(!credentialConfig(c.env))return apiError(c,'CREDENTIALS_NOT_CONFIGURED','Configure credential encryption first.',503);
    const endpointId=crypto.randomUUID(),secret=newPushToken(),generation=(current?.generation??0)+1;
    callbackUrl=pushCallbackUrl(c.env.OZON_PUSH_PUBLIC_BASE_URL??c.env.APP_BASE_URL,endpointId,secret);
    const sealed=await sealPushSecret(c.env,who.orgId,storeId,endpointId,generation,secret);
    if(!await createEndpoint(db,who,storeId,command.expectedRevision,endpointId,generation,sealed,command.sellerId??null))return conflict(c);
   }else if(command.operation==='reveal'&&current){
    callbackUrl=pushCallbackUrl(c.env.OZON_PUSH_PUBLIC_BASE_URL??c.env.APP_BASE_URL,current.endpointId,await openPushSecret(c.env,current));
   }else if(current&&command.operation==='reconcile'){
    if(!await enqueueReconcile(db,who,storeId,command.expectedRevision,command.source,command.commandId))return apiError(c,'PUSH_RECOVERY_NOT_READY','Activate Push and enable this resource before requesting recovery.',409);
    if(c.env.STORE_COORDINATOR)try{await wakeStoreSync(c.env,scope);}catch{/* scheduled repair */}
   }else if(current&&command.operation==='retry'){
    if(!await retryPush(db,who,storeId,command.expectedRevision,command.eventId))return conflict(c);
    if(c.env.STORE_COORDINATOR)try{await wakeStoreSync(c.env,scope);}catch{/* scheduled repair */}
   }else if(current&&['activate','pause','rollback'].includes(command.operation)){
    if(command.operation==='activate'&&(!current.lastPingAt||!syncConfigured(c.env)))return apiError(c,'PUSH_NOT_READY','Validate the callback handshake and configure the synchronization runtime first.',409);
    if(!await changePushMode(db,who,storeId,command.expectedRevision,command.operation as 'activate'|'pause'|'rollback'))return conflict(c);
    if(command.operation==='activate')await repairPushHistory(db,scope);
    if(c.env.STORE_COORDINATOR)try{await wakeStoreSync(c.env,scope);}catch{/* scheduled repair */}
   }else{return apiError(c,'INVALID_REQUEST','Prepare a callback first.',400);}
  }catch(error){if(error instanceof RangeError)return apiError(c,'PUSH_PUBLIC_URL_INVALID','Use an HTTPS origin, or a loopback HTTP origin for local development.',400);if(error instanceof Error&&error.message==='PUSH_SECRET_UNAVAILABLE')return apiError(c,'PUSH_SECRET_UNAVAILABLE','Restore the original credential encryption key, or regenerate the callback address.',503);throw error;}
  if(!await findStore(db,who,storeId,true))return apiError(c,'OPERATION_UNCONFIRMED','Read the configuration again.',503);
  const view=await pushView(db,scope,localPushMode(c.env.APP_BASE_URL)),expected=command.expectedRevision+(['prepare','activate','pause','rollback'].includes(command.operation)?1:0);
  if(view.revision!==expected||(await readEndpoint(db,scope))?.revision!==expected)return apiError(c,'OPERATION_UNCONFIRMED','Read Push status before another operation.',503);
  try{await db.prepare('INSERT INTO store_audit_event(id,request_id,organization_id,store_id,actor_user_id,action,outcome,from_revision,to_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),c.get('requestId'),who.orgId,storeId,who.actorUserId,`store.push.${command.operation}`,'succeeded',command.expectedRevision,view.revision,Date.now()).run();}catch{return apiError(c,'OPERATION_UNCONFIRMED','Read Push status before trying another operation.',503);}
  return jsonResponse(c,{push:{...view,...(callbackUrl?{callbackUrl}:{})}});
 });
 app.post('/api/ozon/push/:endpointId/:token',async c=>{
  if(!c.env.DB)return notFound(c);
  const endpoint=await endpointById(c.env.DB,c.req.param('endpointId')!);if(!endpoint||!equalHash(endpoint.secretHash,await pushHash(c.req.param('token')!)))return notFound(c);
  const simulated=c.req.header('X-DingBell-Local-Simulation')==='1';
  if(simulated&&!localPushMode(c.env.APP_BASE_URL))return apiError(c,'PUSH_LOCAL_ONLY','Local simulation cannot target a public deployment.',403);
  let body:Record<string,unknown>,text:string;try{text=await bodyText(c.req.raw);body=parsePushJSON(text);}catch(error){const tooLarge=error instanceof RangeError&&error.message==='PUSH_TOO_LARGE';return apiError(c,tooLarge?'REQUEST_TOO_LARGE':'INVALID_REQUEST','Invalid callback body.',tooLarge?413:400);}
  if(body.message_type==='TYPE_PING'){
   const row=await c.env.DB.prepare('UPDATE store_push_endpoint SET last_ping_at=?,last_simulation_at=CASE WHEN ? THEN ? ELSE last_simulation_at END,updated_at=? WHERE endpoint_id=? AND generation=? AND secret_hash=? RETURNING store_id').bind(Date.now(),simulated?1:0,Date.now(),Date.now(),endpoint.endpointId,endpoint.generation,endpoint.secretHash).first();if(!row)return notFound(c);
   return jsonResponse(c,{version:'1',name:'DingBell',time:new Date().toISOString()});
  }
  let sellerId:string,type:string,hint:ReturnType<typeof normalizePush>;
  try{sellerId=pushSeller(body);type=pushType(body);hint=normalizePush(body);}catch{return apiError(c,'INVALID_REQUEST','Invalid callback identifiers.',400);}
  if(!await acceptPush(c.env.DB,endpoint,sellerId,type,hint,pushDedupeKey(type,hint,await pushHash(text!),simulated),simulated))return notFound(c);
  // Acceptance is durable before we wake the worker. A failed wake is repaired by the existing scheduler.
  if(c.env.STORE_COORDINATOR){const wake=wakeStoreSync(c.env,{orgId:endpoint.orgId,storeId:endpoint.storeId}).catch(()=>{});try{c.executionCtx.waitUntil(wake);}catch{await wake;}}
  return jsonResponse(c,{result:true});
 });
}
