import * as v from 'valibot';
import {getConversationController} from './control-bindings.ts';
import {reconcileConversationAi,type SupportBindings} from '../ai-runs/execution.ts';
import type {ControlScope} from './control-types.ts';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const time=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(8640000000000000-60000));
const claimSchema=v.strictObject({eventId:id,organizationId:id,storeId:id,conversationId:id,token:v.pipe(v.string(),v.uuid())});
export type InboundClaim=v.InferOutput<typeof claimSchema>;
/** Reuse the ingest outbox; expired delivery leases never imply that the controller rejected a message. */
export async function claimInboundEvents(db:D1Database,now:number,limit=50):Promise<InboundClaim[]>{
 v.parse(time,now);v.parse(v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(50)),limit);const token=crypto.randomUUID();
 const rows=await db.prepare(`UPDATE ingest_event SET delivery_due_at=?,delivery_token=? WHERE id IN
  (SELECT id FROM ingest_event WHERE state='pending' AND processed_at IS NULL AND delivery_due_at<=? ORDER BY delivery_due_at,created_at,id LIMIT ?)
  RETURNING id AS eventId,organization_id AS organizationId,store_id AS storeId,conversation_id AS conversationId`)
  .bind(now+60000,token,now,limit).all<Omit<InboundClaim,'token'>>();
 return rows.results.map(row=>v.parse(claimSchema,{...row,token}));
}
export async function finishInboundEvent(db:D1Database,value:InboundClaim,outcome:'accepted'|'ignored',now:number,enqueueAi:boolean|'active_only'=false){
 const claim=v.parse(claimSchema,value);v.parse(time,now);v.parse(v.picklist(['accepted','ignored']),outcome);v.parse(v.union([v.boolean(),v.literal('active_only')]),enqueueAi);
 const statements:D1PreparedStatement[]=[];
 if(enqueueAi&&outcome==='accepted')statements.push(db.prepare(`INSERT INTO ai_dispatch(controller_id,organization_id,store_id,conversation_id,event_id,input_sequence,run_id,created_at,due_at)
  SELECT cc.controller_id,e.organization_id,e.store_id,e.conversation_id,e.id,a.sequence,?,?,? FROM ingest_event e
  JOIN conversation_control cc ON cc.organization_id=e.organization_id AND cc.store_id=e.store_id AND cc.conversation_id=e.conversation_id
  JOIN message_append a ON a.message_id=e.message_id AND a.organization_id=e.organization_id AND a.store_id=e.store_id AND a.conversation_id=e.conversation_id
  WHERE e.id=? AND e.organization_id=? AND e.store_id=? AND e.conversation_id=? AND e.delivery_token=? AND e.processed_at IS NULL AND e.state='pending' AND e.live_observed_at IS NOT NULL
   AND cc.lifecycle='open' AND cc.work_status='needs_reply' AND cc.assigned_member_id IS NULL AND (cc.reception='ai' OR (?=1 AND cc.reception='paused' AND cc.control_epoch=0))
  ON CONFLICT(controller_id) DO UPDATE SET event_id=excluded.event_id,input_sequence=excluded.input_sequence,run_id=excluded.run_id,created_at=excluded.created_at,due_at=excluded.due_at,token=NULL
   WHERE excluded.input_sequence>ai_dispatch.input_sequence`).bind(crypto.randomUUID(),now,now,claim.eventId,claim.organizationId,claim.storeId,claim.conversationId,claim.token,enqueueAi===true?1:0));
 statements.push(db.prepare(`UPDATE ingest_event SET processed_at=?,delivery_outcome=?,delivery_token=NULL
  WHERE id=? AND organization_id=? AND store_id=? AND conversation_id=? AND delivery_token=? AND processed_at IS NULL AND state='pending'`)
  .bind(now,outcome,claim.eventId,claim.organizationId,claim.storeId,claim.conversationId,claim.token));await db.batch(statements);
}
async function directory(db:D1Database,claim:InboundClaim):Promise<ControlScope|null>{
 const where=`e.id=? AND e.organization_id=? AND e.store_id=? AND e.conversation_id=? AND e.delivery_token=? AND e.state='pending' AND e.processed_at IS NULL`;
 const values=[claim.eventId,claim.organizationId,claim.storeId,claim.conversationId,claim.token];
 const results=await db.batch([
  db.prepare(`INSERT INTO conversation_control(conversation_id,organization_id,store_id,controller_id,repair_due_at,schema_version,work_status)
   SELECT c.id,c.organization_id,c.store_id,?,?,2,'needs_reply' FROM ingest_event e
   JOIN conversation c ON c.id=e.conversation_id AND c.organization_id=e.organization_id AND c.store_id=e.store_id
   JOIN store s ON s.id=c.store_id AND s.organization_id=c.organization_id WHERE ${where}
   ON CONFLICT(conversation_id) DO NOTHING`).bind(crypto.randomUUID(),Date.now(),...values),
  db.prepare(`SELECT cc.controller_id AS controllerId,cc.organization_id AS organizationId,cc.store_id AS storeId,cc.conversation_id AS conversationId
   FROM conversation_control cc JOIN ingest_event e ON e.conversation_id=cc.conversation_id AND e.organization_id=cc.organization_id AND e.store_id=cc.store_id WHERE ${where}`).bind(...values),
 ]);
 return results[1]!.results[0] as unknown as ControlScope??null;
}
export async function deliverInboundEvents(env:SupportBindings){
 if(!env.DB||!env.CONVERSATION_CONTROLLER)return;
 const claims=await claimInboundEvents(env.DB,Date.now());
 for(let offset=0;offset<claims.length;offset+=5)await Promise.allSettled(claims.slice(offset,offset+5).map(async claim=>{
  const scope=await directory(env.DB!,claim);if(!scope)return;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   await Promise.race([(async()=>{
    const result=await getConversationController(env,scope.controllerId).receiveInbound(scope,claim.eventId);
    if(result.outcome!=='accepted'&&result.outcome!=='ignored')return;
    await finishInboundEvent(env.DB!,claim,result.outcome,Date.now(),env.AI_RECEPTION_ENABLED==='true'&&env.FLUE_SUPPORT_AGENT?true:'active_only');
    // Revocation is already durable. Historical executions also have an independent repair cursor.
    if(result.outcome==='accepted')await reconcileConversationAi(env,scope);
   })(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('INBOUND_DELIVERY_TIMEOUT')),3000);})]);
  }finally{clearTimeout(timer);}
 }));
}
