import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {conversationControlFixture} from '../fixtures/conversation-control.ts';
import {createPolicy,changePolicy} from '../../src/modules/reply-policies/storage.ts';
async function fixture(options:{aiEnabled?:string;aiTimeoutMs?:number}={}){
 const f=await conversationControlFixture(undefined,{aiEnabled:'true',...options}),policyId=crypto.randomUUID();
 try{
  await f.db.prepare("UPDATE store SET status='verified' WHERE id='store'").run();
  await f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES('customer-1','org','store','conv','1','Customer','inbound','[\"Мне нужен человек.\"]',0,0,1,1,'incremental')").run();
  const config={kind:'automatic' as const,name:'Automatic support',storeIds:['store'],priority:50,stages:['presale' as const],mode:'automatic' as const,language:'customer' as const,tone:'concise' as const,instructions:''};
  assert.ok(await createPolicy(f.db,f.actor(),policyId,config));assert.ok(await changePolicy(f.db,f.actor(),policyId,1,{action:'test'},crypto.randomUUID()));assert.ok(await changePolicy(f.db,f.actor(),policyId,2,{action:'publish'},crypto.randomUUID()));
  const request={runId:crypto.randomUUID(),expectedVersion:0,messageId:'customer-1',policyId,stage:'presale',language:'ru'},input={reason:'customer_request',summary:'Клиент просит человека.',neededInformation:[]};
  return {...f,get db(){return f.db;},config,request,input,start:()=>f.call('ai-start',{request}),handoff:(value=input)=>f.call('ai-handoff',{runId:request.runId,input:value})};
 }catch(e){await f.close();throw e;}
}
test('native AI run hands off once, records the actual queue transition and restores its receipt after restart',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const started=await f.start();assert.equal(started.body.outcome,'accepted',JSON.stringify(started.body));assert.equal(started.body.state.reception,'ai');
 assert.deepEqual((await f.start()).body.receipt,started.body.receipt);
 const results=await Promise.all(Array.from({length:6},()=>f.handoff()));assert.ok(results.every(r=>r.body.outcome==='accepted'));
 const first=results[0].body;assert.equal(first.receipt.action,'request_handoff');assert.equal(first.receipt.actorUserId,null);assert.equal(first.state.reception,'paused');assert.equal(first.state.workStatus,'needs_reply');assert.equal(first.state.version,2);assert.equal(first.state.controlEpoch,2);assert.equal(first.notice.sent,false);assert.ok(first.notice.body.includes('очередь'));
 assert.equal(first.notice.body.includes(f.input.summary),false);assert.equal(first.canSend,false);
 await f.restart('false');const replay=await f.handoff();assert.deepEqual(replay.body.receipt,first.receipt);assert.equal(replay.body.state.version,2);assert.equal((await f.handoff({...f.input,summary:'Different request'})).body.outcome,'conflict');
 const rows=await f.db.prepare("SELECT action,actor_user_id,actor_member_id FROM conversation_control_event ORDER BY sequence").all();assert.deepEqual(rows.results.map(r=>r.action),['ai_start','request_handoff']);assert.ok(rows.results.every(r=>r.actor_user_id===null&&r.actor_member_id===null));
 assert.equal(f.providerRequests.length,0);assert.equal((await f.db.prepare('SELECT count(*) n FROM send_intent').first<{n:number}>())!.n,0);
});
test('human takeover wins over an old AI run and model input cannot choose authority or customer confirmation',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);assert.equal((await f.start()).body.outcome,'accepted');
 const invalid=await f.handoff({...f.input,runId:'foreign'} as any);assert.equal(invalid.status,500);assert.equal((await f.call('read')).body.view.state.version,1);
 const taken=await f.call('execute',{command:{commandId:crypto.randomUUID(),action:'takeover',expectedVersion:1}});assert.equal(taken.body.outcome,'accepted');
 assert.equal((await f.handoff()).body.outcome,'conflict');const current=(await f.call('read')).body.view.state;assert.equal(current.reception,'human');assert.equal(current.version,2);assert.equal(f.providerRequests.length,0);
});
test('disabled admission, changed inputs and changed policies do not grant an old run new authority',{timeout:30000},async t=>{
 const disabled=await fixture({aiEnabled:'false'});t.after(disabled.close);assert.equal((await disabled.start()).body.outcome,'unavailable');assert.equal((await disabled.call('read')).body.view.state.version,0);
 const f=await fixture();t.after(f.close);assert.equal((await f.start()).body.outcome,'accepted');
 assert.equal((await f.call('ai-handoff',{runId:f.request.runId,input:f.input},{...f.scope,organizationId:'other-org'})).body.outcome,'unavailable');
 assert.ok(await changePolicy(f.db,f.actor(),f.request.policyId,3,{action:'pause'},crypto.randomUUID()));assert.equal((await f.handoff()).body.outcome,'unavailable');
 assert.ok(await changePolicy(f.db,f.actor(),f.request.policyId,4,{action:'publish'},crypto.randomUUID()));assert.equal((await f.handoff()).body.outcome,'unavailable','publishing again cannot refresh a frozen policy revision');
 const fresh=await fixture();t.after(fresh.close);assert.equal((await fresh.start()).body.outcome,'accepted');
 await fresh.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES('customer-2','org','store','conv','2','Customer','inbound','[\"Новое сообщение\"]',0,0,2,2,'incremental')").run();assert.equal((await fresh.handoff()).body.outcome,'unavailable');
 assert.equal((await f.call('read')).body.view.state.version,1);
});
test('an expired run enters the human queue through a system receipt even when its policy is disabled',{timeout:30000},async t=>{
 const f=await fixture({aiTimeoutMs:1200});t.after(f.close);assert.equal((await f.start()).body.outcome,'accepted');
 assert.ok(await changePolicy(f.db,f.actor(),f.request.policyId,3,{action:'pause'},crypto.randomUUID()));
 const deadline=Date.now()+7000;let state=(await f.call('read')).body.view.state;
 while(Date.now()<deadline&&state.reception==='ai'){await delay(50);state=(await f.call('read')).body.view.state;}
 assert.equal(state.reception,'paused');assert.equal(state.workStatus,'needs_reply');assert.equal(state.controlEpoch,2);
 await f.call('repair');const event=await f.db.prepare("SELECT receipt FROM conversation_control_event WHERE action='request_handoff'").first<{receipt:string}>();assert.ok(event);const receipt=JSON.parse(event.receipt);assert.equal(receipt.origin,'system');assert.equal(receipt.input.reason,'tool_failure');
 assert.equal((await f.handoff()).body.outcome,'conflict','a late model decision cannot replace the system timeout receipt');assert.equal(f.providerRequests.length,0);
});
test('handoff state and outbox commit together; projection failure recovers without replaying the transition',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);assert.equal((await f.start()).body.outcome,'accepted');
 await f.call('faults',{value:{commit:true}});assert.equal((await f.handoff()).status,500);assert.equal((await f.call('read')).body.view.state.version,1);
 await f.call('faults',{value:{project:true}});const committed=await f.handoff();assert.equal(committed.body.outcome,'accepted');assert.equal((await f.call('read')).body.view.state.version,2);
 await f.restart();await f.call('faults',{value:{}});await f.call('repair');
 assert.equal((await f.handoff()).body.state.version,2);const events=await f.db.prepare("SELECT count(*) n FROM conversation_control_event WHERE action='request_handoff'").first<{n:number}>();assert.equal(events!.n,1);
});
test('a handoff receipt finishing after human takeover reports current authority without changing its original queue receipt',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);assert.equal((await f.start()).body.outcome,'accepted');await f.call('faults',{value:{hold:true}});
 const pending=f.handoff();const deadline=Date.now()+5000;
 while(!(await f.call('inspect')).body.projectionHeld){assert.ok(Date.now()<deadline);await delay(20);}
 try{
  const human=await f.call('execute',{command:{commandId:crypto.randomUUID(),action:'takeover',expectedVersion:2}});assert.equal(human.body.outcome,'accepted');
 }finally{await f.call('release');}
 const result=await pending;assert.equal(result.body.outcome,'accepted');assert.equal(result.body.receipt.appliedState.reception,'paused');assert.equal(result.body.receipt.appliedState.version,2);assert.equal(result.body.state.reception,'human');assert.equal(result.body.state.version,3);
});
test('editing an unpublished draft does not invalidate the published policy frozen in an active run',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const started=await f.start();assert.equal(started.body.outcome,'accepted');
 assert.ok(await changePolicy(f.db,f.actor(),f.request.policyId,3,{action:'draft',config:{...f.config,tone:'friendly'}},crypto.randomUUID()));
 const result=await f.handoff();assert.equal(result.body.outcome,'accepted');assert.deepEqual(result.body.receipt.run,started.body.receipt.run);assert.equal(result.body.receipt.run.admission.policyConfig.tone,'concise');
});
test('human commands cannot occupy AI receipt identifiers or prevent a legitimate handoff',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);
 const note=(commandId:string,expectedVersion:number)=>f.call('execute',{command:{commandId,expectedVersion,action:'add_note',body:'Internal note'}});
 assert.equal((await note(`ai-start:${f.request.runId}`,0)).body.outcome,'conflict');assert.equal((await f.start()).body.outcome,'accepted');
 assert.equal((await note(`ai-handoff:${f.request.runId}`,1)).body.outcome,'conflict');assert.equal((await f.call('read')).body.view.state.version,1);
 const result=await f.handoff();assert.equal(result.body.outcome,'accepted');assert.equal(result.body.state.reception,'paused');assert.equal(result.body.state.version,2);
 assert.equal((await note(`ai-handoff:${f.request.runId}`,2)).body.outcome,'conflict');assert.equal(f.providerRequests.length,0);
});
test('historical human receipts remain replayable while colliding AI run identifiers are refused',{timeout:30000},async()=>{
 for(const prefix of ['ai-start:','ai-handoff:']){
  const f=await fixture();try{
   const command={commandId:crypto.randomUUID(),expectedVersion:0,action:'add_note',body:'Historical note'};
   const original=await f.call('execute',{command});assert.equal(original.body.outcome,'accepted');
   command.commandId=prefix+f.request.runId;const receipt={...original.body.receipt,commandId:command.commandId};
   await f.call('inject',{key:`receipt:${command.commandId}`,value:receipt});
   assert.deepEqual((await f.call('execute',{command})).body.receipt,receipt);
   f.request.expectedVersion=1;assert.equal((await f.start()).body.outcome,'conflict');assert.equal((await f.call('read')).body.view.state.reception,'paused');
   f.request.runId=crypto.randomUUID();assert.equal((await f.start()).body.outcome,'accepted');assert.equal((await f.handoff()).body.outcome,'accepted');
  }finally{await f.close();}
 }
});
test('internal execution reads retain original authority and reject human-owned, disabled or foreign runs',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const started=await f.start();assert.equal(started.body.outcome,'accepted');
 const read=()=>f.call('ai-read',{runId:f.request.runId});assert.deepEqual((await read()).body,started.body.receipt.run);
 assert.equal((await f.call('ai-read',{runId:crypto.randomUUID()})).body,null);assert.equal((await f.call('ai-read',{runId:f.request.runId},{...f.scope,organizationId:'foreign'})).body,null);
 await f.restart('false');assert.equal((await read()).body,null);await f.restart('true');assert.deepEqual((await read()).body,started.body.receipt.run);
 assert.equal((await f.call('execute',{command:{commandId:crypto.randomUUID(),action:'takeover',expectedVersion:1}})).body.outcome,'accepted');assert.equal((await read()).body,null);
});
