import type {Hono} from 'hono';
import * as v from 'valibot';
import {apiError,jsonResponse,type ApplicationEnv} from '../../http.ts';
import {orderHistoryCommandSchema} from '../../shared/order-history.ts';
import {configured,limitedBody,signedIn,companyFor} from '../identity/http.ts';
import {auditedChange,type AuditOutcome} from '../audit/operation.ts';
import {findStore} from '../stores/storage.ts';
import {storeDTO} from '../stores/http.ts';
import {getSyncSource} from '../sync/storage.ts';
import {syncConfigured,wakeStoreSync} from '../sync/bindings.ts';
import {canEnableSync,syncCapabilityErrorCode} from '../sync/capability.ts';
import {changePostingHistory} from './history.ts';
import {repairPushHistory} from '../ozon-push/storage.ts';
export function registerOrderHistoryRoutes(app:Hono<ApplicationEnv>){
 for(const source of ['fbs_postings','fbo_postings','fbp_postings'] as const){
  const endpoint=`/api/companies/:companyId/stores/:storeId/sync/${source==='fbs_postings'?'fbs-postings':source==='fbo_postings'?'fbo-postings':'fbp-postings'}/history`;
  app.post(endpoint,configured,limitedBody,signedIn,async c=>{
   const identity=c.get('identitySession'),actor={orgId:c.req.param('companyId')!,actorUserId:identity.user.id,sessionId:identity.session.id},storeId=c.req.param('storeId')!,db=c.env.DB!;
   const missing=()=>apiError(c,'NOT_FOUND','The company or store is not available.',404);
   if(new URL(c.req.url).search)return apiError(c,'INVALID_REQUEST','Unexpected query parameters.',400);
   const company=await companyFor(c,actor.orgId,actor.actorUserId);if(!company)return missing();
   if(!['owner','admin'].includes(company.role))return apiError(c,'FORBIDDEN','Only company managers may request order history.',403);
   const store=await findStore(db,actor,storeId,true);if(!store)return missing();
   const parsed=v.safeParse(orderHistoryCommandSchema,await c.req.json().catch(()=>null));if(!parsed.success)return apiError(c,'INVALID_REQUEST','Provide the displayed epoch, history revision and UTC start date.',400);
   const command=parsed.output,current=await getSyncSource(db,actor,storeId,source);if(!current)return missing();
   if(current.epoch!==command.expectedEpoch)return apiError(c,'ORDER_HISTORY_CHANGED','Refresh history synchronization before retrying.',409);
   if(command.operation==='start'){
    if(!syncConfigured(c.env))return apiError(c,'SYNC_NOT_CONFIGURED','Synchronization runtime is not configured.',503);
    if(!current.enabled)return apiError(c,'ORDER_HISTORY_SYNC_REQUIRED','Enable this fulfillment source before requesting history.',409);
    if(!canEnableSync(storeDTO(store),source))return apiError(c,syncCapabilityErrorCode(source),'Verify current credentials and read access first.',409);
   }
   const record=async(outcome:AuditOutcome)=>{await db.prepare('INSERT INTO store_audit_event(id,request_id,organization_id,store_id,actor_user_id,action,outcome,from_revision,to_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),c.get('requestId'),actor.orgId,storeId,actor.actorUserId,`store.history.${source}.${command.operation}`,outcome,command.expectedHistoryRevision,outcome==='succeeded'?command.expectedHistoryRevision+1:null,Date.now()).run();};
   const result=await auditedChange(record,async()=>{
    let history: Awaited<ReturnType<typeof changePostingHistory>>;try{history=await changePostingHistory(db,actor,storeId,source,command);}catch(error){if(error instanceof RangeError)return apiError(c,'ORDER_HISTORY_RANGE_INVALID','Choose a UTC date before the initial recent-sync window, no earlier than 2000-01-01.',400);throw error;}
    if(!history)return apiError(c,'ORDER_HISTORY_CHANGED','The history task, synchronization or store access changed. Refresh before retrying.',409);
    await repairPushHistory(db,{orgId:actor.orgId,storeId});
    let wakePending=false;if(c.env.STORE_COORDINATOR)try{await wakeStoreSync(c.env,{orgId:actor.orgId,storeId});}catch{wakePending=true;}
    if(!await findStore(db,actor,storeId,true))return apiError(c,'OPERATION_UNCONFIRMED','History changed but access was revoked before confirmation.',503);
    return jsonResponse(c,{companyId:actor.orgId,storeId,source,history,wakePending});
   });
   return result.auditComplete?result.response:apiError(c,'OPERATION_UNCONFIRMED','Read history synchronization before another command.',503);
  });
 }
}
