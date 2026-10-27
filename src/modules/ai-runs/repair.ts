import * as v from 'valibot';
import {aiScopeSchema} from '../conversations/ai-state.ts';
import type {ControlScope} from '../conversations/control-types.ts';
import {reconcileAiExecution,type SupportBindings} from './execution.ts';
import {reconcileAiKnowledgeUsage} from './knowledge.ts';

const time=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(8640000000000000-300000));
const uuid=v.pipe(v.string(),v.uuid());
const claimSchema=v.strictObject({runId:uuid,scope:aiScopeSchema,token:uuid});
export type AiRepair={runId:string;scope:ControlScope;token:string};
/** A lease is only a scheduling hint. Runtime effects and financial settlement stay idempotent. */
export async function claimAiRepairs(db:D1Database,now:number,limit=50):Promise<AiRepair[]>{
 v.parse(time,now);v.parse(v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(50)),limit);const token=crypto.randomUUID();
 const rows=await db.prepare(`UPDATE ai_execution SET repair_due_at=?,repair_token=? WHERE id IN
  (SELECT id FROM ai_execution WHERE repair_due_at<=? ORDER BY repair_due_at,id LIMIT ?)
  RETURNING id AS runId,organization_id AS organizationId,store_id AS storeId,conversation_id AS conversationId,controller_id AS controllerId`)
  .bind(now+60000,token,now,limit).all<{runId:string;organizationId:string;storeId:string;conversationId:string;controllerId:string}>();
 return rows.results.map(({runId,...scope})=>v.parse(claimSchema,{runId,scope,token}));
}
export async function finishAiRepair(db:D1Database,value:AiRepair){
 const {runId,scope,token}=v.parse(claimSchema,value),now=Date.now();v.parse(time,now);
 await db.prepare(`UPDATE ai_execution SET repair_token=NULL,repair_due_at=CASE
  WHEN closure IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ai_generation WHERE run_id=ai_execution.id AND usage IS NULL)
   AND NOT EXISTS(SELECT 1 FROM ai_knowledge_query WHERE run_id=ai_execution.id AND gateway_log_id IS NOT NULL AND charged_micros IS NULL) THEN NULL
  WHEN closure IS NOT NULL THEN ? ELSE ? END
  WHERE id=? AND organization_id=? AND store_id=? AND conversation_id=? AND controller_id=? AND repair_token=?`)
  .bind(now+300000,now+60000,runId,scope.organizationId,scope.storeId,scope.conversationId,scope.controllerId,token).run();
}
export async function repairAiExecutions(env:SupportBindings,deps:{reconcile?:typeof reconcileAiExecution;reconcileKnowledge?:typeof reconcileAiKnowledgeUsage}={}){
 if(!env.DB||(!env.KNOWLEDGE_AI&&(!env.FLUE_SUPPORT_AGENT||!env.CONVERSATION_CONTROLLER)))return;
 const claims=await claimAiRepairs(env.DB,Date.now()),reconcile=deps.reconcile??reconcileAiExecution,reconcileKnowledge=deps.reconcileKnowledge??reconcileAiKnowledgeUsage;
 for(let offset=0;offset<claims.length;offset+=5)await Promise.allSettled(claims.slice(offset,offset+5).map(async claim=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([Promise.allSettled([reconcile(env,claim.scope,claim.runId),reconcileKnowledge(env,claim.scope,claim.runId)]),
   new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('AI_REPAIR_TIMEOUT')),3000);})]);}
  finally{clearTimeout(timer);await finishAiRepair(env.DB!,claim);}
 }));
}
