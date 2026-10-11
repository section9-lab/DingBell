import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {URL} from 'node:url';
import {conversationControlFixture} from './fixtures/conversation-control.ts';
import {claimInboundEvents,finishInboundEvent,deliverInboundEvents} from '../src/modules/conversations/inbound-delivery.ts';
import {createPolicy,changePolicy} from '../src/modules/reply-policies/storage.ts';
async function api(){const m=await import('../src/modules/ai-runs/dispatch.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.dispatchAiReceptions,'function','accepted inputs need a persistent automatic dispatcher');return m!;}
async function fixture(){
 const f=await conversationControlFixture(undefined,{aiEnabled:'true'}),policyId=crypto.randomUUID();let clock=Date.now();
 try{
  await f.db.prepare("UPDATE store SET status='verified' WHERE id='store'").run();
  const config={kind:'automatic' as const,name:'Reception',storeIds:['store'],priority:50,stages:['presale' as const,'order' as const,'aftersale' as const],mode:'automatic' as const,language:'customer' as const,tone:'concise' as const,instructions:''};
  assert.ok(await createPolicy(f.db,f.actor(),policyId,config));assert.ok(await changePolicy(f.db,f.actor(),policyId,1,{action:'test'},crypto.randomUUID()));assert.ok(await changePolicy(f.db,f.actor(),policyId,2,{action:'publish'},crypto.randomUUID()));
  const append=async(enqueue=true)=>{
   const id=crypto.randomUUID(),now=++clock;await f.db.batch([
    f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES(?,'org','store','conv',?,'Customer','inbound','[\"Какая ширина?\"]',0,0,?,?,'incremental')").bind(id,id,now,now),
    f.db.prepare("INSERT INTO ingest_event(id,organization_id,store_id,conversation_id,message_id,state,live_observed_at,trace_id,created_at) VALUES(?,'org','store','conv',?,'pending',?,'synthetic',?)").bind(id,id,now,now),
   ]);const [claim]=await claimInboundEvents(f.db,Date.now());assert.equal(claim.eventId,id);const received=await f.call('inbound',{eventId:id});assert.equal(received.body.outcome,'accepted');await finishInboundEvent(f.db,claim,'accepted',Date.now(),enqueue);return {eventId:id,claim};
  };
  const controller={receiveInbound:async(scope:any,eventId:string)=>(await f.call('inbound',{eventId},scope)).body,admitAiDispatch:async(scope:any,request:any)=>(await f.call('ai-dispatch-admit',{request},scope)).body,
   stopAiDispatch:async(scope:any,request:any)=>(await f.call('ai-dispatch-stop',{request},scope)).body,
   readClassifiedInput:async(scope:any)=>(await f.call('ai-classified-input',{},scope)).body,
   startAi:async(scope:any,request:any)=>(await f.call('ai-start',{request},scope)).body,
   readAiWork:async(scope:any,runId:string)=>(await f.call('ai-work-read',{runId},scope)).body};
  return {...f,get db(){return f.db;},policyId,append,controller,env:()=>({DB:f.db,AI_RECEPTION_ENABLED:'true',FLUE_SUPPORT_AGENT:{},CONVERSATION_CONTROLLER:{idFromName:(id:string)=>id,get:()=>controller}} as any)};
 }catch(e){await f.close();throw e;}
}
test('inbound acknowledgement atomically queues one fixed intake target; lease expiry and restart retain it',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);const input=await f.append(),now=Date.now(),[first]=await m.claimAiDispatches(f.db,now);assert.equal(first.eventId,input.eventId);assert.deepEqual(first.scope,f.scope);assert.ok(first.runId);assert.equal((await m.claimAiDispatches(f.db,now+1)).length,0);
 await f.restart();const [retry]=await m.claimAiDispatches(f.db,now+60001);assert.equal(retry.runId,first.runId);assert.notEqual(retry.token,first.token);await m.finishAiDispatch(f.db,first,true,now+60002);assert.ok(await f.db.prepare('SELECT due_at FROM ai_dispatch').first('due_at'));
 await m.finishAiDispatch(f.db,retry,true,now+60003);await finishInboundEvent(f.db,input.claim,'accepted',now+60004,true);assert.equal((await m.claimAiDispatches(f.db,now+60005)).length,0);
});
test('new input replaces a queued target and a stale finisher cannot remove it; disabled delivery is not backfilled',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);await f.append(false);assert.equal((await m.claimAiDispatches(f.db,Date.now())).length,0);
 const old=await f.append(),[claim]=await m.claimAiDispatches(f.db,Date.now());const next=await f.append();await m.finishAiDispatch(f.db,claim,true,Date.now());const [current]=await m.claimAiDispatches(f.db,Date.now());assert.equal(current.eventId,next.eventId);assert.notEqual(current.runId,claim.runId);assert.notEqual(current.eventId,old.eventId);
});
test('automatic dispatch classifies once and advances the persisted answer target, then stops scheduling after handoff',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);await f.append();const calls:string[]=[];
 const deps={reconcile:async()=>({status:'unavailable'}),execute:async(_env:any,scope:any,runId:string)=>{
  calls.push(runId);const run=(await f.call('ai-work-read',{runId},scope)).body;
  if(run?.schemaVersion===2)assert.equal((await f.call('ai-classify',{runId,classification:{stage:'presale',language:'ru',customerRequestedHuman:false}},scope)).body.outcome,'accepted');
  else assert.equal((await f.call('ai-handoff',{runId,input:{reason:'missing_evidence',summary:'Synthetic missing evidence',neededInformation:[]}},scope)).body.outcome,'accepted');
  return {status:'completed'};
 }};
 await m.dispatchAiReceptions(f.env(),deps);assert.equal(calls.length,2);assert.notEqual(calls[0],calls[1]);assert.equal((await f.call('read')).body.view.state.reception,'paused');await m.dispatchAiReceptions(f.env(),deps);assert.equal(calls.length,2);assert.equal((await m.claimAiDispatches(f.db,Date.now()+60001)).length,0);
});
test('configuration or budget refusal returns to the human queue without replaying an admitted run',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);const input=await f.append();let calls=0;
 await m.dispatchAiReceptions(f.env(),{reconcile:async()=>({status:'unavailable'}),execute:async()=>{calls++;return {status:'unavailable'};}});assert.equal(calls,1);
 const state=(await f.call('read')).body.view.state;assert.equal(state.reception,'paused');assert.equal(state.workStatus,'needs_reply');assert.equal(await f.db.prepare("SELECT count(*) n FROM conversation_control_event WHERE action='ai_dispatch_stop'").first('n'),1);
 const runId=await f.db.prepare('SELECT run_id FROM ai_dispatch').first('run_id'),replay=await f.call('ai-dispatch-stop',{request:{eventId:input.eventId,runId,targetRunId:runId,reason:'unavailable'}});assert.equal(replay.body.outcome,'accepted');assert.deepEqual(replay.body.state,state);
});
test('a pending answer continues with its original identity after restart instead of repeating classification or interrupting it',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);await f.append();let intakeId='',answerId='',answerCalls=0;const calls:string[]=[];
 const deps={reconcile:async()=>({status:'pending'}),execute:async(_env:any,scope:any,runId:string)=>{
  calls.push(runId);const run=(await f.call('ai-work-read',{runId},scope)).body;
  if(run?.schemaVersion===2){intakeId=runId;assert.equal((await f.call('ai-classify',{runId,classification:{stage:'presale',language:'ru',customerRequestedHuman:false}},scope)).body.outcome,'accepted');return {status:'completed'};}
  if(runId===intakeId)return {status:'completed'};
  if(run?.schemaVersion===1){answerId=runId;answerCalls++;if(answerCalls>1)assert.equal((await f.call('ai-handoff',{runId,input:{reason:'missing_evidence',summary:'Synthetic gap',neededInformation:[]}},scope)).body.outcome,'accepted');return {status:answerCalls===1?'pending':'completed'};}
  throw new Error('unexpected new target');
 }};
 await m.dispatchAiReceptions(f.env(),deps);assert.equal(answerCalls,1);await f.restart();await f.db.prepare('UPDATE ai_dispatch SET due_at=0').run();await m.dispatchAiReceptions(f.env(),deps);
 assert.equal(answerCalls,2);assert.equal(new Set(calls).size,2);assert.notEqual(intakeId,answerId);assert.equal(await f.db.prepare("SELECT count(*) n FROM conversation_control_event WHERE action='ai_dispatch_stop'").first('n'),0);
 assert.equal((await m.claimAiDispatches(f.db,Date.now()+60001)).length,0);
});
test('a stale dispatch cannot interrupt a new human-authorized run for the same input',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);const input=await f.append(),[claim]=await m.claimAiDispatches(f.db,Date.now());assert.equal((await f.controller.admitAiDispatch(f.scope,{eventId:input.eventId,runId:claim.runId})).outcome,'accepted');
 assert.equal((await f.call('execute',{command:{commandId:crypto.randomUUID(),expectedVersion:2,action:'takeover'}})).body.outcome,'accepted');
 const next=crypto.randomUUID(),actor={...f.actor(),expectedMemberId:'owner-member'};assert.equal((await f.call('ai-resume',{actor,request:{runId:next,previousRunId:claim.runId,expectedVersion:3,messageId:input.eventId,policyId:f.policyId,stage:'presale',language:'ru'}})).body.outcome,'accepted');
 assert.notEqual((await f.call('ai-dispatch-stop',{request:{eventId:input.eventId,reason:'unavailable'}})).body.outcome,'accepted');
 assert.equal((await f.call('ai-dispatch-stop',{request:{eventId:input.eventId,runId:claim.runId,targetRunId:claim.runId,reason:'unavailable'}})).body.outcome,'ignored');assert.equal((await f.call('ai-work-read',{runId:next})).body.request.runId,next);
});
test('a delayed classifier observation cannot cancel an answer already started by another dispatcher',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);await f.append();let answerId='';
 const deps={reconcile:async()=>({status:'unavailable'}),execute:async(_env:any,scope:any,runId:string)=>{
  const run=(await f.call('ai-work-read',{runId},scope)).body;
  if(run?.schemaVersion===2){
   assert.equal((await f.call('ai-classify',{runId,classification:{stage:'presale',language:'ru',customerRequestedHuman:false}},scope)).body.outcome,'accepted');
   const next=await f.controller.readClassifiedInput(scope);answerId=next.request.runId;assert.equal((await f.controller.startAi(scope,next.request)).outcome,'accepted');
  }
  return {status:'completed'};
 }};
 await m.dispatchAiReceptions(f.env(),deps);assert.ok(answerId);assert.equal((await f.call('ai-work-read',{runId:answerId})).body?.request.runId,answerId);assert.ok(await f.db.prepare('SELECT due_at FROM ai_dispatch').first('due_at'));
 assert.equal(await f.db.prepare("SELECT count(*) n FROM conversation_control_event WHERE action='ai_dispatch_stop'").first('n'),0);
});
test('an external seller reply stops obsolete preparation, while an undelivered newer customer message keeps AI eligible',{timeout:30000},async t=>{
 const m=await api();for(const direction of ['outbound','inbound']){
  const f=await fixture();try{
   const input=await f.append(),runId=await f.db.prepare('SELECT run_id FROM ai_dispatch').first<string>('run_id');assert.ok(runId);assert.equal((await f.controller.admitAiDispatch(f.scope,{eventId:input.eventId,runId})).outcome,'accepted');
   assert.equal((await f.call('ai-classify',{runId,classification:{stage:'presale',language:'ru',customerRequestedHuman:false}})).body.outcome,'accepted');
   const id=crypto.randomUUID(),now=Date.now()+1000;await f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES(?,'org','store','conv',?,?,?,'[\"Следующее сообщение\"]',0,0,?,?,'incremental')").bind(id,id,direction==='inbound'?'Customer':'Seller',direction,now,now).run();
   if(direction==='inbound')await f.db.prepare("INSERT INTO ingest_event(id,organization_id,store_id,conversation_id,message_id,state,live_observed_at,trace_id,created_at) VALUES(?,'org','store','conv',?,'pending',?,'synthetic',?)").bind(id,id,now,now).run();
   await m.dispatchAiReceptions(f.env(),{reconcile:async()=>({status:'unavailable'}),execute:async()=>({status:'completed'})});
   assert.equal((await f.call('read')).body.view.state.reception,direction==='inbound'?'ai':'paused');assert.equal(await f.db.prepare("SELECT count(*) n FROM conversation_control_event WHERE action='ai_dispatch_stop'").first('n'),direction==='inbound'?0:1);
   if(direction==='inbound'){assert.ok(await f.db.prepare('SELECT due_at FROM ai_dispatch').first('due_at'));const [claim]=await claimInboundEvents(f.db,Date.now());assert.equal(claim.eventId,id);assert.equal((await f.call('inbound',{eventId:id})).body.outcome,'accepted');await finishInboundEvent(f.db,claim,'accepted',Date.now(),true);assert.equal((await f.call('ai-pending-input')).body.event.messageId,id);}
  }finally{await f.close();}
 }
});
test('a failed queue insert rolls back inbound acknowledgement, and retry keeps the committed dispatch identity',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);await f.db.prepare("CREATE TRIGGER test_fail_dispatch BEFORE INSERT ON ai_dispatch BEGIN SELECT RAISE(ABORT,'synthetic queue failure'); END;").run();
 await assert.rejects(()=>f.append(),/synthetic queue failure/);assert.equal(await f.db.prepare('SELECT processed_at FROM ingest_event').first('processed_at'),null);assert.equal(await f.db.prepare('SELECT count(*) n FROM ai_dispatch').first('n'),0);
 await f.db.prepare('DROP TRIGGER test_fail_dispatch').run();await f.db.prepare('UPDATE ingest_event SET delivery_due_at=0').run();const [claim]=await claimInboundEvents(f.db,Date.now());assert.equal((await f.call('inbound',{eventId:claim.eventId})).body.outcome,'accepted');await finishInboundEvent(f.db,claim,'accepted',Date.now(),true);
 const before=(await f.db.prepare('SELECT * FROM ai_dispatch').all()).results;await finishInboundEvent(f.db,claim,'accepted',Date.now(),true);assert.deepEqual((await f.db.prepare('SELECT * FROM ai_dispatch').all()).results,before);assert.equal((await m.claimAiDispatches(f.db,Date.now())).length,1);
});
test('disabled and overdue dispatches return to humans without starting any model, and reserved command names cannot be occupied',{timeout:30000},async t=>{
 const m=await api();for(const reason of ['disabled','timeout']){
  const f=await fixture();try{await f.append();const row=(await f.db.prepare('SELECT run_id FROM ai_dispatch').first())!;
   assert.equal((await f.call('execute',{command:{commandId:`ai-dispatch-stop:${row.run_id}`,expectedVersion:1,action:'claim'}})).body.outcome,'conflict');
   if(reason==='timeout')await f.db.prepare('UPDATE ai_dispatch SET created_at=?').bind(Date.now()-300001).run();
   await m.dispatchAiReceptions({...f.env(),AI_RECEPTION_ENABLED:reason==='disabled'?'false':'true'},{reconcile:async()=>({status:'unavailable'}),execute:async()=>{throw new Error('must not execute');}});
   const r=JSON.parse((await f.db.prepare("SELECT receipt FROM conversation_control_event WHERE action='ai_dispatch_stop'").first<string>('receipt'))!);assert.equal(r.input.reason,reason);assert.equal((await f.call('read')).body.view.state.reception,'paused');assert.equal((await m.claimAiDispatches(f.db,Date.now()+60001)).length,0);assert.equal(await f.db.prepare('SELECT count(*) n FROM ai_execution').first('n'),0);
  }finally{await f.close();}
 }
});
test('0040 preserves prior audit rows and guards, rolls back failures and never backfills processed input',{timeout:30000},async t=>{
 await api();const f=await conversationControlFixture('0039');t.after(f.close);assert.equal((await f.call('execute',{command:{commandId:'before-dispatch-upgrade',expectedVersion:0,action:'claim'}})).body.outcome,'accepted');
 await f.db.batch([
  f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES('old-input','org','store','conv','old-input','Customer','inbound','[\"Вопрос\"]',0,0,1,1,'incremental')"),
  f.db.prepare("INSERT INTO ingest_event(id,organization_id,store_id,conversation_id,message_id,state,live_observed_at,trace_id,created_at,processed_at,delivery_outcome) VALUES('old-event','org','store','conv','old-input','pending',1,'synthetic',1,2,'accepted')"),
 ]);
 const rows=async()=>(await f.db.prepare('SELECT * FROM conversation_control_event').all()).results,guards=async()=>(await f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all()).results,before=await rows(),beforeGuards=await guards();
 const statements=(await readFile(new URL('../migrations/0040_ai_dispatch.sql',import.meta.url),'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);
 await assert.rejects(()=>f.db.batch([...statements.map(s=>f.db.prepare(s)),f.db.prepare('SELECT * FROM missing_dispatch_upgrade_table')]));assert.deepEqual(await rows(),before);assert.deepEqual(await guards(),beforeGuards);assert.equal(await f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='ai_dispatch'").first('n'),0);
 await f.db.batch(statements.map(s=>f.db.prepare(s)));assert.deepEqual(await rows(),before);assert.deepEqual(await guards(),beforeGuards);assert.equal(await f.db.prepare('SELECT processed_at FROM ingest_event').first('processed_at'),2);assert.equal(await f.db.prepare('SELECT count(*) n FROM ai_dispatch').first('n'),0);assert.equal((await f.db.prepare('PRAGMA foreign_key_check').all()).results.length,0);await assert.rejects(()=>f.db.prepare("UPDATE conversation_control_event SET receipt='{}'").run(),/IMMUTABLE/);
});
test('a new input after the global switch is disabled leaves an AI waiting state through the actual delivery consumer',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);const actor={...f.actor(),expectedMemberId:'owner-member'};
 assert.equal((await f.call('ai-listen',{actor,request:{commandId:crypto.randomUUID(),expectedVersion:0,previousRunId:null}})).body.outcome,'accepted');
 const id=crypto.randomUUID(),now=Date.now()+1;await f.db.batch([
  f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES(?,'org','store','conv',?,'Customer','inbound','[\"Вопрос\"]',0,0,?,?,'incremental')").bind(id,id,now,now),
  f.db.prepare("INSERT INTO ingest_event(id,organization_id,store_id,conversation_id,message_id,state,live_observed_at,trace_id,created_at) VALUES(?,'org','store','conv',?,'pending',?,'synthetic',?)").bind(id,id,now,now),
 ]);
 const env={...f.env(),AI_RECEPTION_ENABLED:'false'};await deliverInboundEvents(env);await m.dispatchAiReceptions(env,{execute:async()=>{throw new Error('disabled model must not run');},reconcile:async()=>({status:'unavailable'})});
 const state=(await f.call('read')).body.view.state;assert.equal(state.reception,'paused');assert.equal(state.workStatus,'needs_reply');assert.equal(await f.db.prepare('SELECT count(*) n FROM ai_execution').first('n'),0);assert.equal((await m.claimAiDispatches(f.db,Date.now()+60001)).length,0);
});
