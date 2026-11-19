import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {URL} from 'node:url';
import {conversationControlFixture} from './fixtures/conversation-control.ts';
import {claimInboundEvents,finishInboundEvent,deliverInboundEvents} from '../src/modules/conversations/inbound-delivery.ts';
import {createPolicy,changePolicy} from '../src/modules/reply-policies/storage.ts';
async function api(){const m=await import('../src/modules/ai-runs/dispatch.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.dispatchAiReceptions,'function','accepted inputs need a persistent automatic dispatcher');return m!;}
async function fixture(){
 const f=await conversationControlFixture(undefined,{}),policyId=crypto.randomUUID();let clock=Date.now();
 try{
  await f.db.prepare("UPDATE store SET status='verified' WHERE id='store'").run();
  const config={kind:'automatic' as const,name:'Reception',storeIds:['store'],priority:50,stage:'presale' as const,mode:'automatic' as const,language:'customer' as const,tone:'concise' as const,instructions:''};
  assert.ok(await createPolicy(f.db,f.actor(),policyId,config));assert.ok(await changePolicy(f.db,f.actor(),policyId,1,{action:'test'},crypto.randomUUID()));assert.ok(await changePolicy(f.db,f.actor(),policyId,2,{action:'publish'},crypto.randomUUID()));
  const append=async(enqueue=true)=>{
   const id=crypto.randomUUID(),now=++clock;await f.db.batch([
    f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES(?,'org','store','conv',?,'Customer','inbound','[\"Какая ширина?\"]',0,0,?,?,'incremental')").bind(id,id,now,now),
    f.db.prepare("INSERT INTO ingest_event(id,organization_id,store_id,conversation_id,message_id,state,live_observed_at,trace_id,created_at) VALUES(?,'org','store','conv',?,'pending',?,'synthetic',?)").bind(id,id,now,now),
   ]);const [claim]=await claimInboundEvents(f.db,Date.now());assert.equal(claim.eventId,id);const received=await f.call('inbound',{eventId:id});assert.equal(received.body.outcome,'accepted');await finishInboundEvent(f.db,claim,'accepted',Date.now(),enqueue);return {eventId:id,claim};
  };
  const controller={receiveInbound:async(scope:any,eventId:string)=>(await f.call('inbound',{eventId},scope)).body,admitAiDispatch:async(scope:any,request:any)=>(await f.call('ai-dispatch-admit',{request},scope)).body,
   stopAiDispatch:async(scope:any,request:any)=>(await f.call('ai-dispatch-stop',{request},scope)).body,
   recordFallbackClassification:async(scope:any,runId:string)=>(await f.call('ai-fallback-classification',{runId},scope)).body,
   noteAiFailure:async(scope:any,eventId:string)=>(await f.call('ai-note-failure',{eventId},scope)).body,
   noteReconcileFailure:async(scope:any,eventId:string)=>(await f.call('ai-reconcile-failure',{eventId},scope)).body,
   sendFallbackNotice:async(scope:any,runId:string)=>(await f.call('ai-notice',{runId},scope)).body,
   restartAiRun:async(scope:any,runId:string)=>(await f.call('ai-restart-run',{runId},scope)).body,
   readClassifiedInput:async(scope:any)=>(await f.call('ai-classified-input',{},scope)).body,
   startAi:async(scope:any,request:any)=>(await f.call('ai-start',{request},scope)).body,
   readAiWork:async(scope:any,runId:string)=>(await f.call('ai-work-read',{runId},scope)).body};
  return {...f,get db(){return f.db;},policyId,append,controller,env:()=>({DB:f.db,AGENT_RUNTIME:{},CONVERSATION_CONTROLLER:{idFromName:(id:string)=>id,get:()=>controller}} as any)};
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
test('one dispatch window covers both model calls instead of cutting at three seconds',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);await f.append();const calls:string[]=[];
 const deps={reconcile:async()=>({status:'unavailable'}),execute:async(_env:any,scope:any,runId:string)=>{
  calls.push(runId);
  const run=(await f.call('ai-work-read',{runId},scope)).body;
  if(run?.schemaVersion===2){await new Promise(done=>setTimeout(done,3200));assert.equal((await f.call('ai-classify',{runId,classification:{stage:'presale',language:'ru',customerRequestedHuman:false}},scope)).body.outcome,'accepted');}
  else assert.equal((await f.call('ai-handoff',{runId,input:{reason:'missing_evidence',summary:'Synthetic missing evidence',neededInformation:[]}},scope)).body.outcome,'accepted');
  return {status:'completed'};
 }};
 await m.dispatchAiReceptions(f.env(),deps,undefined,10_000);
 assert.equal(calls.length,2,'a slow classification must not abandon the answer in the same window');
 assert.equal(await f.db.prepare('SELECT due_at FROM ai_dispatch').first('due_at'),null,'the dispatch finished instead of retrying');
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
test('overdue dispatches return to humans without starting any model, and reserved command names cannot be occupied',{timeout:30000},async t=>{
 const m=await api();for(const reason of ['timeout']){
  const f=await fixture();try{await f.append();const row=(await f.db.prepare('SELECT run_id FROM ai_dispatch').first())!;
   assert.equal((await f.call('execute',{command:{commandId:`ai-dispatch-stop:${row.run_id}`,expectedVersion:1,action:'claim'}})).body.outcome,'conflict');
   if(reason==='timeout')await f.db.prepare('UPDATE ai_dispatch SET created_at=?').bind(Date.now()-660001).run();
   await m.dispatchAiReceptions(f.env(),{reconcile:async()=>({status:'unavailable'}),execute:async()=>{throw new Error('must not execute');}});
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
test('a new input is queued for AI by the delivery consumer before any model runs',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);const actor={...f.actor(),expectedMemberId:'owner-member'};
 assert.equal((await f.call('ai-listen',{actor,request:{commandId:crypto.randomUUID(),expectedVersion:0,previousRunId:null}})).body.outcome,'accepted');
 const id=crypto.randomUUID(),now=Date.now()+1;await f.db.batch([
  f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES(?,'org','store','conv',?,'Customer','inbound','[\"Вопрос\"]',0,0,?,?,'incremental')").bind(id,id,now,now),
  f.db.prepare("INSERT INTO ingest_event(id,organization_id,store_id,conversation_id,message_id,state,live_observed_at,trace_id,created_at) VALUES(?,'org','store','conv',?,'pending',?,'synthetic',?)").bind(id,id,now,now),
 ]);
 const env={...f.env(),NVAPI_KEY:undefined,AI_RECEPTION_CONFIG_JSON:undefined};await deliverInboundEvents(env);
 const state=(await f.call('read')).body.view.state;assert.equal(state.reception,'ai');assert.equal(state.workStatus,'needs_reply');assert.equal(await f.db.prepare('SELECT count(*) n FROM ai_execution').first('n'),0);assert.equal((await m.claimAiDispatches(f.db,Date.now()+60001)).length,1);
});

test('the company default lets a paused conversation adopt AI on the next live message',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);
 await f.db.prepare("INSERT INTO company_ai_reception_default(organization_id,enabled,updated_at,updated_by) VALUES('org',1,?,'owner')").bind(Date.now()).run();
 const actor={...f.actor(),expectedMemberId:'owner-member'};
 const listened=await f.call('ai-listen',{actor,request:{commandId:crypto.randomUUID(),expectedVersion:0,previousRunId:null}});
 assert.equal(listened.body.outcome,'accepted');
 // A human status change parks AI without a handoff, so the company default may take over again.
 const parked=await f.call('execute',{actor,command:{commandId:crypto.randomUUID(),expectedVersion:1,action:'set_work_status',workStatus:'waiting_customer'}});
 assert.equal(parked.body.outcome,'accepted');assert.equal((await f.call('read')).body.view.state.reception,'paused');
 await f.append(false);
 const state=(await f.call('read')).body.view.state;
 assert.equal(state.reception,'ai','an unassigned paused conversation must let AI take the next live message');
 assert.equal(state.workStatus,'needs_reply');
});

test('a handoff lets the next customer message return to AI unless a human took over',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);
 await f.db.prepare("INSERT INTO company_ai_reception_default(organization_id,enabled,updated_at,updated_by) VALUES('org',1,?,'owner')").bind(Date.now()).run();
 const input=await f.append();
 const [claim]=await m.claimAiDispatches(f.db,Date.now());
 assert.ok(claim);
 const admitted=await f.call('ai-dispatch-admit',{request:{eventId:claim.eventId,runId:claim.runId}});
 assert.equal(admitted.body.outcome,'accepted');
 // An unclassifiable message makes the intake hand off, which must park AI for good.
 const classified=await f.call('ai-classify',{runId:claim.runId,classification:{stage:'unknown',language:'unknown',customerRequestedHuman:false}});
 assert.equal(classified.body.outcome,'accepted');
 const handoff=(await f.call('read')).body.view.state;
 assert.equal(handoff.reception,'paused');
 await f.append(false);
 // AI stays the default owner: the next live message retries instead of parking the conversation.
 assert.equal((await f.call('read')).body.view.state.reception,'ai');
 assert.ok(input.eventId);
});

test('a stopped dispatch leaves the company default armed for the next message',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);
 await f.db.prepare("INSERT INTO company_ai_reception_default(organization_id,enabled,updated_at,updated_by) VALUES('org',1,?,'owner')").bind(Date.now()).run();
 await f.append();
 const [claim]=await m.claimAiDispatches(f.db,Date.now());assert.ok(claim);
 const stopped=await f.call('ai-dispatch-stop',{request:{eventId:claim.eventId,runId:claim.runId,targetRunId:claim.runId,reason:'unavailable'}});
 assert.equal(stopped.body.outcome,'accepted');
 await f.append(false);
 assert.equal((await f.call('read')).body.view.state.reception,'ai','an infrastructure stop must not park the conversation');
});

test('a classifier that never submits its tool still starts an answer with the published stage',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);await f.append();
 const kinds:number[]=[];
 const deps={reconcile:async()=>({status:'pending'}),execute:async(_env:any,scope:any,runId:string)=>{
  const run=(await f.call('ai-work-read',{runId},scope)).body;
  kinds.push(run.schemaVersion);
  return {status:'completed'};
 }};
 await m.dispatchAiReceptions(f.env(),deps);
 assert.deepEqual(kinds,[2,1],'the intake fallback must be followed by the answer run');
 const events=await f.db.prepare("SELECT action FROM conversation_control_event ORDER BY sequence").all();
 assert.deepEqual(events.results.map((row:any)=>row.action).slice(0,4),['customer_message','ai_intake_start','ai_classification','ai_start']);
 assert.equal(await f.db.prepare("SELECT outcome FROM store_audit_event WHERE action='ai.classification'").first('outcome'),'fallback_ready_presale');
});

test('a failing model is retried twice and only then handed to a human',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);await f.append();
 let calls=0;const deps={reconcile:async()=>({status:'pending'}),execute:async()=>{calls++;return {status:'unavailable' as const};}};
 for(let attempt=1;attempt<=3;attempt++){
  await m.dispatchAiReceptions(f.env(),deps);
  if(attempt<3)await f.db.prepare('UPDATE ai_dispatch SET due_at=0').run();
 }
 assert.equal(calls,3,'three model attempts before any handoff');
 assert.equal(await f.db.prepare("SELECT count(*) n FROM conversation_control_event WHERE action='ai_dispatch_stop'").first('n'),1);
 assert.equal((await f.call('read')).body.view.state.reception,'paused');
});

test('an intake deadline inside the controller budget stays readable',{timeout:30000},async t=>{
 // Regression: the controller issues a 600s intake deadline, while the intake schema still
 // capped it at 60s. Every dispatch then read no work, retried, and timed out in silence.
 const {conversationControlFixture}=await import('./fixtures/conversation-control.ts');
 const f=await conversationControlFixture(undefined,{aiTimeoutMs:600_000});t.after(f.close);
 await f.db.prepare("UPDATE store SET status='verified' WHERE id='store'").run();
 const policyId=crypto.randomUUID(),config={kind:'automatic' as const,name:'Reception',storeIds:['store'],priority:50,stage:'presale' as const,mode:'automatic' as const,language:'customer' as const,tone:'concise' as const,instructions:''};
 const {createPolicy,changePolicy}=await import('../src/modules/reply-policies/storage.ts');
 assert.ok(await createPolicy(f.db,f.actor(),policyId,config));assert.ok(await changePolicy(f.db,f.actor(),policyId,1,{action:'test'},crypto.randomUUID()));assert.ok(await changePolicy(f.db,f.actor(),policyId,2,{action:'publish'},crypto.randomUUID()));
 const now=Date.now(),id=crypto.randomUUID();
 await f.db.batch([
  f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES(?,'org','store','conv',?,'Customer','inbound','[\"Есть ли зелёные шапки?\"]',0,0,?,?,'incremental')").bind(id,id,now,now),
  f.db.prepare("INSERT INTO ingest_event(id,organization_id,store_id,conversation_id,message_id,state,live_observed_at,trace_id,created_at) VALUES(?,'org','store','conv',?,'pending',?,'synthetic',?)").bind(id,id,now,now),
 ]);
 const [claim]=await claimInboundEvents(f.db,Date.now());await f.call('inbound',{eventId:claim.eventId});await finishInboundEvent(f.db,claim,'accepted',Date.now(),true);
 const [step]=await (await api()).claimAiDispatches(f.db,Date.now());assert.ok(step);
 const admitted=await f.call('ai-dispatch-admit',{request:{eventId:step.eventId,runId:step.runId}});assert.equal(admitted.body.outcome,'accepted');
 const work=await f.call('ai-work-read',{runId:step.runId});assert.equal(work.status,200,JSON.stringify(work.body));assert.equal(work.body.request.runId,step.runId);assert.ok(work.body.deadlineAt-work.body.startedAt>60_000);
});

test('a timeout still notifies the buyer instead of parking in silence',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);
 const notices:string[]=[];
 const env:any={...f.env(),CONVERSATION_CONTROLLER:{idFromName:(id:string)=>id,get:()=>({
  admitAiDispatch:f.controller.admitAiDispatch,stopAiDispatch:f.controller.stopAiDispatch,readClassifiedInput:f.controller.readClassifiedInput,
  recordFallbackClassification:f.controller.recordFallbackClassification,startAi:f.controller.startAi,
  noteAiFailure:async()=>({count:3}),noteReconcileFailure:f.controller.noteReconcileFailure,restartAiRun:f.controller.restartAiRun,
  sendFallbackNotice:async(_scope:any,runId:string)=>{notices.push(runId);return {outcome:'accepted',sent:true};},
 })}};
 await f.append();await f.db.prepare('UPDATE ai_dispatch SET created_at=?').bind(Date.now()-660001).run();
 await m.dispatchAiReceptions(env,{reconcile:async()=>({status:'unavailable'}),execute:async()=>{throw new Error('must not execute');}});
 assert.equal(notices.length,1);assert.equal((await f.call('read')).body.view.state.reception,'paused');
});

test('three unconfirmed reconciles drop the dead run and let the next admission execute',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);await f.append();
 const restarts:string[]=[],executed:string[]=[];
 const env:any={...f.env(),CONVERSATION_CONTROLLER:{idFromName:(id:string)=>id,get:()=>({
  admitAiDispatch:f.controller.admitAiDispatch,stopAiDispatch:f.controller.stopAiDispatch,readClassifiedInput:f.controller.readClassifiedInput,
  recordFallbackClassification:f.controller.recordFallbackClassification,startAi:f.controller.startAi,
  noteAiFailure:f.controller.noteAiFailure,noteReconcileFailure:f.controller.noteReconcileFailure,
  restartAiRun:async(scope:any,runId:string)=>{restarts.push(runId);return f.controller.restartAiRun(scope,runId);},
  sendFallbackNotice:async()=>({outcome:'accepted',sent:true}),
 })}};
 const deps={reconcile:async()=>({status:'unconfirmed'}),execute:async(_env:any,_scope:any,runId:string)=>{executed.push(runId);return {status:'completed'};}};
 for(let tick=0;tick<3;tick++){await f.db.prepare('UPDATE ai_dispatch SET due_at=0').run();await m.dispatchAiReceptions(env,deps);}
 assert.equal(restarts.length,1,'the third stalled tick restarts the stale run');
 assert.ok(executed.length>=1,'the same tick must then admit and execute instead of blocking');
 assert.equal(executed[0],restarts[0],'the first model call runs the original dispatch target');
});


test('scheduled dispatch window is bounded so queued replies are not starved', async () => {
  const m = await api();
  assert.ok(m.DISPATCH_WINDOW_MS >= 10_000 && m.DISPATCH_WINDOW_MS <= 30_000, `unexpected window ${m.DISPATCH_WINDOW_MS}`);
});
