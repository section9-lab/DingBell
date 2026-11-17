import * as v from 'valibot';
import type {SyncScope} from '../sync/types.ts';
import {aiScopeSchema} from '../conversations/ai-state.ts';
import {getConversationController} from '../conversations/control-bindings.ts';
import {executeAiRun,reconcileConversationAi,type SupportBindings} from './execution.ts';
import {logEvent} from '../../platform/log.ts';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256)),uuid=v.pipe(v.string(),v.uuid());
const time=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(8640000000000000-300000));
const claimSchema=v.strictObject({scope:aiScopeSchema,eventId:id,runId:uuid,token:uuid,inputSequence:v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(Number.MAX_SAFE_INTEGER)),createdAt:time});
export type AiDispatchClaim=v.InferOutput<typeof claimSchema>;
export async function claimAiDispatches(db:D1Database,now:number,limit=50,scope?:SyncScope):Promise<AiDispatchClaim[]>{
 v.parse(time,now);v.parse(v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(50)),limit);const token=crypto.randomUUID();
 const rows=await db.prepare(`UPDATE ai_dispatch SET due_at=?,token=? WHERE controller_id IN
  (SELECT controller_id FROM ai_dispatch WHERE due_at<=? ${scope?'AND organization_id=? AND store_id=?':''} ORDER BY due_at,controller_id LIMIT ?)
  RETURNING controller_id AS controllerId,organization_id AS organizationId,store_id AS storeId,conversation_id AS conversationId,event_id AS eventId,run_id AS runId,input_sequence AS inputSequence,created_at AS createdAt`)
  .bind(now+60000,token,now,...(scope?[scope.orgId,scope.storeId]:[]),limit).all<{controllerId:string;organizationId:string;storeId:string;conversationId:string;eventId:string;runId:string;inputSequence:number;createdAt:number}>();
 return rows.results.map(({controllerId,organizationId,storeId,conversationId,...work})=>v.parse(claimSchema,{scope:{organizationId,storeId,conversationId,controllerId},...work,token}));
}
export async function finishAiDispatch(db:D1Database,value:AiDispatchClaim,done:boolean,now:number){
 const c=v.parse(claimSchema,value);v.parse(time,now);v.parse(v.boolean(),done);
 await db.prepare(`UPDATE ai_dispatch SET due_at=?,token=NULL WHERE controller_id=? AND organization_id=? AND store_id=? AND conversation_id=? AND event_id=? AND run_id=? AND token=?`)
  .bind(done?null:now+1000,c.scope.controllerId,c.scope.organizationId,c.scope.storeId,c.scope.conversationId,c.eventId,c.runId,c.token).run();
}
type Result={status:string};
type Dependencies={execute?:(env:SupportBindings,scope:AiDispatchClaim['scope'],runId:string)=>Promise<Result>;reconcile?:(env:SupportBindings,scope:AiDispatchClaim['scope'])=>Promise<Result>};
/** The queue addresses original work only; every model call still needs live controller and financial authority. */
async function dispatchOne(env:SupportBindings,c:AiDispatchClaim,deps:Dependencies){
 const controller=getConversationController(env,c.scope.controllerId),execute=deps.execute??executeAiRun,reconcile=deps.reconcile??reconcileConversationAi;
 const stop=async(reason:'disabled'|'timeout'|'unavailable'|'runtime_failure',targetRunId:string|null=c.runId)=>{
  const r=await controller.stopAiDispatch(c.scope,{eventId:c.eventId,runId:c.runId,targetRunId,reason});
  logEvent('ai.dispatch.stop',{orgId:c.scope.organizationId,storeId:c.scope.storeId,conversationId:c.scope.conversationId,runId:c.runId,reason,targetRunId,outcome:r.outcome});
  if(r.outcome==='unavailable'||r.outcome==='retry')return false;
  await reconcile(env,c.scope);return true;};
 const finishAnswer=async(result:Result,id:string)=>{
  if(result.status==='pending'||result.status==='unconfirmed')return false;
  if(result.status==='completed'&&env.AI_OUTBOUND_ENABLED==='true'&&env.OUTBOUND_ENABLED==='true'){
   const queued=await controller.enqueueAiReply(c.scope,id);
   logEvent('ai.dispatch.answer',{orgId:c.scope.organizationId,storeId:c.scope.storeId,conversationId:c.scope.conversationId,runId:id,queued:queued.outcome});
   if(queued.outcome==='accepted')return true;
   // No send_message and no committed handoff: tell the buyer a person is following up.
   const notice=typeof controller.sendFallbackNotice==='function'
    ?await controller.sendFallbackNotice(c.scope,id).catch(()=>({outcome:'unavailable' as const,sent:false}))
    :{outcome:'unavailable' as const,sent:false};
   logEvent('ai.dispatch.notice',{orgId:c.scope.organizationId,storeId:c.scope.storeId,conversationId:c.scope.conversationId,runId:id,outcome:notice.outcome,sent:notice.sent});
   if(notice.outcome==='accepted')return true;
  }
  return stop(result.status==='unavailable'?'unavailable':'runtime_failure',id);
 };
 if(Date.now()-c.createdAt>=300000)return stop('timeout',null);
 const repaired=await reconcile(env,c.scope);if(repaired.status==='unconfirmed')return false;
 const admitted=await controller.admitAiDispatch(c.scope,{eventId:c.eventId,runId:c.runId});
 logEvent('ai.dispatch.admit',{orgId:c.scope.organizationId,storeId:c.scope.storeId,conversationId:c.scope.conversationId,runId:c.runId,eventId:c.eventId,outcome:admitted.outcome});
 if(admitted.outcome==='conflict')return true;
 if(admitted.outcome!=='accepted')return stop('unavailable');
 const result=await execute(env,c.scope,c.runId);
 let next=await controller.readClassifiedInput(c.scope);
 if(!next&&result.status==='completed'){
  // The classifier finished without submitting its tool; keep the buyer from waiting for a human.
  const fallback=typeof controller.recordFallbackClassification==='function'
   ?await controller.recordFallbackClassification(c.scope,c.runId).catch(()=>({outcome:'unavailable' as const}))
   :{outcome:'unavailable' as const};
  logEvent('ai.dispatch.fallback',{orgId:c.scope.organizationId,storeId:c.scope.storeId,conversationId:c.scope.conversationId,runId:c.runId,outcome:fallback.outcome});
  if(fallback.outcome==='accepted')next=await controller.readClassifiedInput(c.scope);
 }
 if(next&&next.intakeRunId===c.runId){
  const answer=await controller.startAi(c.scope,next.request);
  if(answer.outcome==='unavailable'){if(result.status==='pending'||result.status==='unconfirmed')return false;return stop('unavailable',next.request.runId);}
  if(answer.outcome!=='accepted')return true;
  return finishAnswer(await execute(env,c.scope,next.request.runId),next.request.runId);
 }
 if(admitted.answerRunId){
  return finishAnswer(await execute(env,c.scope,admitted.answerRunId),admitted.answerRunId);
 }
 if(result.status==='pending'||result.status==='unconfirmed')return false;
 return stop(result.status==='unavailable'?'unavailable':'runtime_failure');
}
/** One tick may finish classification and the answer together; a fixed 3s cut both model calls off. */
export const DISPATCH_WINDOW_MS = 20_000;
export async function dispatchAiReceptions(env:SupportBindings,deps:Dependencies={},scopeFilter?:SyncScope,windowMs=DISPATCH_WINDOW_MS){
 if(!env.DB||!env.CONVERSATION_CONTROLLER)return;const claims=await claimAiDispatches(env.DB,Date.now(),50,scopeFilter);
 // A timed-out dispatch keeps running; the next tick resumes from its persisted receipt instead of
 // repeating the model call, so this window only decides how much completes inside one tick.
 const deadline=Date.now()+windowMs;
 for(let offset=0;offset<claims.length;offset+=5){
  if(Date.now()>=deadline)break;
  await Promise.allSettled(claims.slice(offset,offset+5).map(async claim=>{
   const remaining=deadline-Date.now();if(remaining<=0)return;
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([(async()=>{const done=await dispatchOne(env,claim,deps);await finishAiDispatch(env.DB!,claim,done,Date.now());})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('AI_DISPATCH_TIMEOUT')),remaining);})]);}
   finally{clearTimeout(timer);}
  }));
 }
}
