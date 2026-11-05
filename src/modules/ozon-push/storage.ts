import type {PushView} from '../../shared/ozon-push.ts';
import {storeAccess,type StoreActor} from '../stores/storage.ts';
import type {StoreCoordinatorRecord,SyncScope} from '../sync/types.ts';
import {pushHash,type PushSecret} from './security.ts';
import type {PushHint} from './protocol.ts';

export type Endpoint=PushSecret&{orgId:string;storeId:string;endpointId:string;revision:number;generation:number;mode:'prepared'|'active'|'paused';sellerId:string|null;observedSellerId:string|null;lastPingAt:number|null;lastReceivedAt:number|null;lastSimulationAt:number|null;lastProcessedAt:number|null;cutoverAt:number|null};
const endpointColumns='organization_id AS orgId,store_id AS storeId,endpoint_id AS endpointId,revision,generation,mode,seller_id AS sellerId,observed_seller_id AS observedSellerId,secret_hash AS secretHash,key_version AS keyVersion,nonce,ciphertext,last_ping_at AS lastPingAt,last_received_at AS lastReceivedAt,last_simulation_at AS lastSimulationAt,last_processed_at AS lastProcessedAt,cutover_at AS cutoverAt';
export function readEndpoint(db:D1Database,scope:SyncScope){return db.prepare(`SELECT ${endpointColumns} FROM store_push_endpoint WHERE organization_id=? AND store_id=?`).bind(scope.orgId,scope.storeId).first<Endpoint>();}
export function endpointById(db:D1Database,id:string){return db.prepare(`SELECT ${endpointColumns} FROM store_push_endpoint WHERE endpoint_id=?`).bind(id).first<Endpoint>();}
export async function createEndpoint(db:D1Database,actor:StoreActor,storeId:string,expectedRevision:number,endpointId:string,generation:number,secret:PushSecret,sellerId:string|null=null){
 return db.prepare(`INSERT INTO store_push_endpoint(store_id,organization_id,endpoint_id,revision,generation,mode,seller_id,secret_hash,key_version,nonce,ciphertext,created_at,updated_at)
  SELECT store.id,store.organization_id,?,?,?,'prepared',?,?,?,?,?,?,? FROM store WHERE store.id=? AND store.organization_id=? AND ${storeAccess('store.organization_id')}
  AND COALESCE((SELECT revision FROM store_push_endpoint WHERE store_id=store.id),0)=?
  ON CONFLICT(store_id) DO UPDATE SET endpoint_id=excluded.endpoint_id,revision=excluded.revision,generation=excluded.generation,mode='prepared',seller_id=excluded.seller_id,observed_seller_id=NULL,secret_hash=excluded.secret_hash,key_version=excluded.key_version,nonce=excluded.nonce,ciphertext=excluded.ciphertext,last_ping_at=NULL,updated_at=excluded.updated_at
  RETURNING ${endpointColumns}`)
  .bind(endpointId,expectedRevision+1,generation,sellerId,secret.secretHash,secret.keyVersion,secret.nonce,secret.ciphertext,Date.now(),Date.now(),storeId,actor.orgId,actor.actorUserId,actor.sessionId,expectedRevision).first<Endpoint>();
}
export async function changePushMode(db:D1Database,actor:StoreActor,storeId:string,expectedRevision:number,operation:'activate'|'pause'|'rollback'){
 const now=Date.now(),mode=operation==='activate'?'active':operation==='pause'?'paused':'prepared';
 return db.prepare(`UPDATE store_push_endpoint SET mode=?,revision=revision+1,cutover_at=CASE WHEN ?='rollback' THEN NULL WHEN ?='activate' THEN COALESCE(cutover_at,?) ELSE cutover_at END,updated_at=?
  WHERE store_id=? AND organization_id=? AND revision=? AND (?!='activate' OR last_ping_at IS NOT NULL)
  AND EXISTS(SELECT 1 FROM store WHERE store.id=store_push_endpoint.store_id AND store.organization_id=store_push_endpoint.organization_id AND ${storeAccess('store.organization_id')}
   AND (?!='activate' OR store.status NOT IN ('paused','disconnected'))) RETURNING store_id`)
  .bind(mode,operation,operation,now,now,storeId,actor.orgId,expectedRevision,operation,actor.actorUserId,actor.sessionId,operation).first();
}
export async function acceptPush(db:D1Database,endpoint:Endpoint,sellerId:string,notificationType:string,hint:PushHint,dedupeKey:string,simulated:boolean){
 const now=Date.now(),accepted=`endpoint_id=? AND generation=? AND secret_hash=? AND (seller_id IS NULL OR seller_id=?)`;
 const values=[endpoint.endpointId,endpoint.generation,endpoint.secretHash,sellerId];
 const results=await db.batch([
  db.prepare(`INSERT INTO ozon_push_event(id,organization_id,store_id,generation,dedupe_key,notification_type,source,hint,simulated,state,next_attempt_at,received_at,finished_at,last_error)
   SELECT ?,organization_id,store_id,generation,?,?,?,?,?,?,?,?,?,? FROM store_push_endpoint WHERE ${accepted}
   ON CONFLICT(store_id,generation,dedupe_key) DO NOTHING`).bind(crypto.randomUUID(),dedupeKey,notificationType,hint.source,JSON.stringify(hint),simulated?1:0,hint.kind==='ignored'?'ignored':'pending',now,now,hint.kind==='ignored'?now:null,hint.reason??null,...values),
  db.prepare(`UPDATE store_push_endpoint SET last_received_at=CASE WHEN ?=0 THEN ? ELSE last_received_at END,observed_seller_id=CASE WHEN ?=0 THEN ? ELSE observed_seller_id END,last_simulation_at=CASE WHEN ?=1 THEN ? ELSE last_simulation_at END,updated_at=? WHERE ${accepted} RETURNING store_id`).bind(simulated?1:0,now,simulated?1:0,sellerId,simulated?1:0,now,now,...values),
 ]);
 return results[1]!.results.length>0;
}
export type PushJob=SyncScope&{id:string;generation:number;notificationType:string;source:PushHint['source'];hint:PushHint;simulated:boolean;attempts:number;receivedAt:number;token:string;progress:{cursor?:string|null;recent?:string[];phase?:string;offset?:number}};
export const pushJobFrom=`FROM ozon_push_event AS event JOIN store_push_endpoint AS endpoint ON endpoint.store_id=event.store_id AND endpoint.organization_id=event.organization_id
 JOIN store ON store.id=event.store_id AND store.organization_id=event.organization_id
 JOIN store_coordinator AS coordinator ON coordinator.store_id=store.id
 JOIN store_sync_source AS authority ON authority.store_id=store.id AND authority.source=event.source`;
export const runnablePush=`endpoint.mode='active' AND endpoint.cutover_at IS NOT NULL AND store.status NOT IN ('paused','disconnected') AND authority.enabled=1 AND authority.credential_version=store.credential_version
 AND event.state IN ('pending','retry','processing')`;
export const pushDue=`MAX(event.next_attempt_at,CASE WHEN event.state='processing' THEN COALESCE(event.lease_until,0) ELSE 0 END)`;
export async function pushCoordinatorRuntime(db:D1Database,scope:SyncScope):Promise<{handled:boolean;runtime:StoreCoordinatorRecord|null}>{
 const endpoint=await readEndpoint(db,scope);if(endpoint?.cutoverAt==null)return {handled:false,runtime:null};
 if(endpoint.mode!=='active')return {handled:true,runtime:null};
 const runtime=await db.prepare(`SELECT store.organization_id AS orgId,store.id AS storeId,MAX(MIN(${pushDue}),COALESCE(coordinator.blocked_until,0)) AS dueAt,coordinator.lease_until AS leaseUntil,coordinator.blocked_until AS blockedUntil ${pushJobFrom}
  WHERE store.id=? AND store.organization_id=? AND ${runnablePush} GROUP BY store.id`).bind(scope.storeId,scope.orgId).first<StoreCoordinatorRecord>();return {handled:true,runtime};
}
export async function claimPushJob(db:D1Database,scope:SyncScope):Promise<PushJob|null>{
 const token=crypto.randomUUID(),now=Date.now();
 const row=await db.prepare(`UPDATE ozon_push_event SET state='processing',lease_token=?,lease_until=? WHERE id=(SELECT event.id ${pushJobFrom}
  WHERE event.organization_id=? AND event.store_id=? AND ${runnablePush} AND ${pushDue}<=? AND COALESCE(coordinator.blocked_until,0)<=? AND COALESCE(coordinator.lease_until,0)<=?
  ORDER BY CASE WHEN event.notification_type IN ('TYPE_NEW_MESSAGE','TYPE_UPDATE_MESSAGE') THEN 0 WHEN event.notification_type LIKE 'TYPE_%' THEN 1 ELSE 2 END,event.next_attempt_at,event.received_at,event.id LIMIT 1)
  RETURNING id,organization_id AS orgId,store_id AS storeId,generation,notification_type AS notificationType,source,hint,simulated,attempts,received_at AS receivedAt,lease_token AS token,progress`)
  .bind(token,now+30_000,scope.orgId,scope.storeId,now,now,now).first<Omit<PushJob,'hint'|'progress'|'simulated'>&{hint:string;progress:string;simulated:number}>();
 return row?{...row,hint:JSON.parse(row.hint) as PushHint,progress:JSON.parse(row.progress) as PushJob['progress'],simulated:!!row.simulated}:null;
}
export function pushJobCondition(job:SyncScope&Pick<PushJob,'id'|'generation'|'token'>){return {sql:`EXISTS(SELECT 1 FROM ozon_push_event AS event JOIN store_push_endpoint AS endpoint ON endpoint.store_id=event.store_id AND endpoint.organization_id=event.organization_id
 WHERE event.id=? AND event.organization_id=? AND event.store_id=? AND event.generation=? AND event.state='processing' AND event.lease_token=? AND event.lease_until>CAST(unixepoch('subsecond')*1000 AS INTEGER) AND endpoint.mode='active' AND endpoint.cutover_at IS NOT NULL)`,values:[job.id,job.orgId,job.storeId,job.generation,job.token]};}
export async function finishPushJob(db:D1Database,job:PushJob,state:'completed'|'pending'|'retry'|'ignored'|'failed',options:{code?:string;nextAt?:number;progress?:PushJob['progress'];attempts?:number}={}){
 const guard=pushJobCondition(job),now=Date.now();
 const update=db.prepare(`UPDATE ozon_push_event SET state=?,lease_token=NULL,lease_until=NULL,next_attempt_at=?,progress=?,attempts=?,last_error=?,requires_review=CASE WHEN ?='completed' THEN 0 WHEN ?='message_content_changed' THEN 1 ELSE requires_review END,finished_at=? WHERE id=? AND ${guard.sql} RETURNING id`)
  .bind(state,options.nextAt??now,JSON.stringify(options.progress??job.progress),options.attempts??job.attempts,options.code??null,state,options.code??null,['completed','ignored','failed'].includes(state)?now:null,job.id,...guard.values);
 if(state!=='completed')return update.first();
 const result=await db.batch([db.prepare(`UPDATE store_push_endpoint SET last_processed_at=? WHERE store_id=? AND organization_id=? AND ${guard.sql}`).bind(now,job.storeId,job.orgId,...guard.values),update]);return result[1]!.results[0]??null;
}
export async function enqueueReconcile(db:D1Database,actor:StoreActor,storeId:string,expectedRevision:number,source:Exclude<PushHint['source'],'none'>,commandId:string){
 const hint:PushHint={kind:'reconcile',source},now=Date.now();
 return db.prepare(`INSERT INTO ozon_push_event(id,organization_id,store_id,generation,dedupe_key,notification_type,source,hint,state,next_attempt_at,received_at)
  SELECT ?,endpoint.organization_id,endpoint.store_id,endpoint.generation,?,'MANUAL_RECONCILE',?,?,'pending',?,? FROM store_push_endpoint AS endpoint JOIN store ON store.id=endpoint.store_id AND store.organization_id=endpoint.organization_id
  JOIN store_sync_source AS authority ON authority.store_id=store.id AND authority.source=?
  WHERE endpoint.store_id=? AND endpoint.organization_id=? AND endpoint.revision=? AND endpoint.mode='active' AND endpoint.cutover_at IS NOT NULL AND authority.enabled=1 AND authority.credential_version=store.credential_version AND store.status NOT IN ('paused','disconnected') AND ${storeAccess('store.organization_id')}
  ON CONFLICT DO NOTHING RETURNING id`).bind(commandId,`manual:${commandId}`,source,JSON.stringify(hint),now,now,source,storeId,actor.orgId,expectedRevision,actor.actorUserId,actor.sessionId).first();
}
export async function retryPush(db:D1Database,actor:StoreActor,storeId:string,expectedRevision:number,eventId:string){
 return db.prepare(`UPDATE ozon_push_event SET state='pending',attempts=0,last_error=NULL,next_attempt_at=?,lease_token=NULL,lease_until=NULL,finished_at=NULL
  WHERE id=? AND store_id=? AND organization_id=? AND state='failed' AND EXISTS(SELECT 1 FROM store_push_endpoint WHERE store_id=ozon_push_event.store_id AND organization_id=ozon_push_event.organization_id AND revision=? AND mode='active')
  AND EXISTS(SELECT 1 FROM store WHERE store.id=ozon_push_event.store_id AND ${storeAccess('store.organization_id')}) RETURNING id`).bind(Date.now(),eventId,storeId,actor.orgId,expectedRevision,actor.actorUserId,actor.sessionId).first();
}
export async function repairPushHistory(db:D1Database,scope?:SyncScope){
 const from=`FROM posting_history_sync AS history JOIN store_push_endpoint AS endpoint ON endpoint.store_id=history.store_id AND endpoint.organization_id=history.organization_id
  JOIN store_sync_source AS authority ON authority.store_id=history.store_id AND authority.organization_id=history.organization_id AND authority.source=history.source
  JOIN store ON store.id=history.store_id AND store.organization_id=history.organization_id`;
 const valid=`history.state='active' AND history.epoch=authority.epoch AND authority.enabled=1 AND authority.credential_version=store.credential_version AND store.status NOT IN ('paused','disconnected') AND endpoint.mode='active' AND endpoint.cutover_at IS NOT NULL`;
 const rows=(await db.prepare(`SELECT history.organization_id AS orgId,history.store_id AS storeId,history.source,history.command_revision AS revision ${from} WHERE ${valid}
  ${scope?'AND history.organization_id=? AND history.store_id=?':''} AND NOT EXISTS(SELECT 1 FROM ozon_push_event WHERE store_id=history.store_id AND dedupe_key='history:'||history.source||':'||history.command_revision) LIMIT 50`).bind(...(scope?[scope.orgId,scope.storeId]:[])).all<SyncScope&{source:'fbs_postings'|'fbo_postings'|'fbp_postings';revision:number}>()).results;
 for(const row of rows){const now=Date.now();await db.prepare(`INSERT INTO ozon_push_event(id,organization_id,store_id,generation,dedupe_key,notification_type,source,hint,state,next_attempt_at,received_at)
  SELECT ?,history.organization_id,history.store_id,endpoint.generation,?,'MANUAL_RECONCILE',history.source,?,'pending',?,? ${from}
  WHERE history.organization_id=? AND history.store_id=? AND history.source=? AND history.command_revision=? AND ${valid} ON CONFLICT DO NOTHING`).bind(crypto.randomUUID(),`history:${row.source}:${row.revision}`,JSON.stringify({kind:'reconcile',source:row.source,reason:'posting_history'} satisfies PushHint),now,now,row.orgId,row.storeId,row.source,row.revision).run();}
}
export async function enqueuePushChildren(db:D1Database,job:PushJob,hints:PushHint[]){
 if(hints.length>100)throw new Error('PUSH_TOO_MANY_CHILDREN');const now=Date.now(),guard=pushJobCondition(job);
 const rows=await Promise.all(hints.map(async hint=>({id:crypto.randomUUID(),key:`child:${job.id}:${await pushHash(JSON.stringify(hint))}`,hint,source:hint.source})));
 const result=await db.prepare(`INSERT INTO ozon_push_event(id,organization_id,store_id,generation,dedupe_key,notification_type,source,hint,simulated,state,next_attempt_at,received_at)
  SELECT json_extract(value,'$.id'),?,?,?,json_extract(value,'$.key'),'MANUAL_ITEM',json_extract(value,'$.source'),json_extract(value,'$.hint'),?,'pending',?,? FROM json_each(?) WHERE ${guard.sql} ON CONFLICT DO NOTHING`).bind(job.orgId,job.storeId,job.generation,job.simulated?1:0,now,now,JSON.stringify(rows),...guard.values).run();return result.success;
}
const iso=(value:number|null)=>value===null?null:new Date(value).toISOString();
export async function pushView(db:D1Database,scope:SyncScope,local:boolean):Promise<PushView>{
 const endpoint=await readEndpoint(db,scope),queue={pending:0,processing:0,retry:0,completed:0,ignored:0,failed:0};
 const counts=(await db.prepare('SELECT state,COUNT(*) AS total FROM ozon_push_event WHERE organization_id=? AND store_id=? GROUP BY state').bind(scope.orgId,scope.storeId).all<{state:keyof typeof queue;total:number}>()).results;
 for(const row of counts)queue[row.state]=row.total;
 const review=await db.prepare('SELECT COUNT(*) AS total FROM ozon_push_event WHERE organization_id=? AND store_id=? AND requires_review=1').bind(scope.orgId,scope.storeId).first<{total:number}>();
 const events=(await db.prepare(`SELECT id,notification_type AS notificationType,source,hint,state,attempts,next_attempt_at AS nextAttemptAt,received_at AS receivedAt,last_error AS lastError,simulated,requires_review AS requiresReview FROM ozon_push_event WHERE organization_id=? AND store_id=? ORDER BY requires_review DESC,CASE state WHEN 'failed' THEN 0 WHEN 'retry' THEN 1 WHEN 'processing' THEN 2 WHEN 'pending' THEN 3 ELSE 4 END,received_at DESC,id DESC LIMIT 25`).bind(scope.orgId,scope.storeId).all<{id:string;notificationType:string;source:string;hint:string;state:PushView['events'][number]['state'];attempts:number;nextAttemptAt:number;receivedAt:number;lastError:string|null;simulated:number;requiresReview:number}>()).results;
 return {storeId:scope.storeId,revision:endpoint?.revision??0,generation:endpoint?.generation??0,mode:endpoint?.mode??'unconfigured',sellerId:endpoint?.sellerId??null,observedSellerId:endpoint?.observedSellerId??null,lastPingAt:iso(endpoint?.lastPingAt??null),lastReceivedAt:iso(endpoint?.lastReceivedAt??null),lastSimulationAt:iso(endpoint?.lastSimulationAt??null),lastProcessedAt:iso(endpoint?.lastProcessedAt??null),cutoverAt:iso(endpoint?.cutoverAt??null),localSimulationAllowed:local,reviewCount:review?.total??0,queue,events:events.map(({hint:json,...row})=>{const hint=JSON.parse(json) as {chatId?:string;productIds?:string[];postingNumber?:string};return {...row,target:hint.chatId??(hint.productIds?.length?hint.productIds.slice(0,3).join(', ')+(hint.productIds.length>3?` 等 ${hint.productIds.length} 件`:''):undefined)??hint.postingNumber??'',nextAttemptAt:new Date(row.nextAttemptAt).toISOString(),receivedAt:new Date(row.receivedAt).toISOString(),simulated:!!row.simulated,requiresReview:!!row.requiresReview};})};
}
