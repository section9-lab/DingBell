import assert from 'node:assert/strict';
import {test} from 'node:test';
import {conversationControlFixture} from './fixtures/conversation-control.ts';
import {createPolicy,changePolicy} from '../src/modules/reply-policies/storage.ts';
import {readFile} from 'node:fs/promises';
import {URL} from 'node:url';
import {projectControlEvents} from '../src/modules/conversations/control-storage.ts';
import {changeAiBudget,reserveAiExecution,closeAiExecution} from '../src/modules/ai-runs/storage.ts';
type Fixture=Awaited<ReturnType<typeof conversationControlFixture>>;
async function append(f:Fixture,options:{mode?:string;direction?:string;state?:string;live?:boolean;at?:number}={}){
 const id=crypto.randomUUID(),at=options.at??Date.now();
 await f.db.batch([
  f.db.prepare(`INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode)
   VALUES(?,'org','store','conv',?,'Customer',?,'["Новое сообщение"]',0,0,?,?,?)`).bind(id,id,options.direction??'inbound',at,at,options.mode??'incremental'),
  f.db.prepare(`INSERT INTO ingest_event(id,schema_version,organization_id,store_id,conversation_id,message_id,state,live_observed_at,trace_id,created_at)
   VALUES(?,1,'org','store','conv',?,?,?,'synthetic',?)`).bind(id,id,options.state??'pending',options.live===false?null:at,at),
 ]);return id;
}
async function command(f:Fixture,expectedVersion:number,action:string,extra:Record<string,unknown>={}){
 const result=await f.call('execute',{command:{commandId:crypto.randomUUID(),expectedVersion,action,...extra}});assert.equal(result.body.outcome,'accepted');return result.body.view.state;
}
async function receive(f:Fixture,eventId:string){const r=await f.call('inbound',{eventId});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
async function policy(f:Fixture){
 await f.db.prepare("UPDATE store SET status='verified' WHERE id='store'").run();const id=crypto.randomUUID();
 assert.ok(await createPolicy(f.db,f.actor(),id,{kind:'automatic',name:'Reception',storeIds:['store'],priority:50,stages:['presale','order','aftersale'],mode:'automatic',language:'customer',tone:'concise',instructions:''}));
 assert.ok(await changePolicy(f.db,f.actor(),id,1,{action:'test'},crypto.randomUUID()));assert.ok(await changePolicy(f.db,f.actor(),id,2,{action:'publish'},crypto.randomUUID()));return id;
}
test('new committed input updates human work and reopens resolved conversations without restoring AI',{timeout:30000},async t=>{
 const f=await conversationControlFixture();t.after(f.close);await command(f,0,'claim');const waiting=await command(f,1,'set_work_status',{workStatus:'waiting_customer'});
 const id=await append(f),first=await receive(f,id);assert.equal(first.outcome,'accepted');assert.equal(first.receipt.action,'customer_message');assert.equal(first.receipt.actorUserId,null);assert.equal(first.state.workStatus,'needs_reply');assert.equal(first.state.reception,'human');assert.equal(first.state.assignedMemberId,'owner-member');assert.equal(first.state.controlEpoch,waiting.controlEpoch);
 await command(f,3,'resolve');const repeated=await receive(f,id);assert.deepEqual(repeated.receipt,first.receipt);assert.equal(repeated.state.lifecycle,'resolved');assert.equal(repeated.state.version,4);
 const next=await receive(f,await append(f));assert.equal(next.state.version,5);assert.equal(next.state.lifecycle,'open');assert.equal(next.state.reception,'human');assert.equal(next.state.assignedMemberId,'owner-member');
 const audit=await f.db.prepare("SELECT action,actor_user_id FROM conversation_control_event WHERE action='customer_message'").all();assert.equal(audit.results.length,2);assert.ok(audit.results.every(row=>row.actor_user_id===null));assert.equal(f.providerRequests.length,0);
});
test('human commands cannot reserve an inbound receipt namespace',{timeout:30000},async t=>{
 const f=await conversationControlFixture();t.after(f.close);const id=await append(f);
 assert.equal((await f.call('execute',{command:{commandId:`inbound:${id}`,expectedVersion:0,action:'claim'}})).body.outcome,'conflict');
 assert.equal((await receive(f,id)).state.version,1);
});
test('historical, outbound, unverified-live and older deliveries cannot reopen or overwrite a newer input',{timeout:30000},async t=>{
 const f=await conversationControlFixture();t.after(f.close);await command(f,0,'claim');await command(f,1,'resolve');
 for(const options of [{mode:'backfill'},{direction:'outbound'},{live:false},{state:'historical'},{state:'observed'}])assert.equal((await receive(f,await append(f,options))).outcome,'ignored');
 assert.equal((await f.call('read')).body.view.state.version,2);
 const older=await append(f,{at:Date.now()-1000}),newer=await append(f);const accepted=await receive(f,newer);assert.equal(accepted.state.version,3);assert.equal((await receive(f,older)).outcome,'ignored');
 assert.equal((await f.call('inbound',{eventId:newer},{...f.scope,organizationId:'other'})).body.outcome,'unavailable');assert.equal((await f.call('read')).body.view.state.version,3);
});
test('a resumed AI converts fresh input to one durable target and human control revokes that target',{timeout:30000},async t=>{
 const f=await conversationControlFixture(undefined,{aiEnabled:'true'});t.after(f.close);const policyId=await policy(f);
 const resumed=await f.call('ai-listen',{actor:{...f.actor(),expectedMemberId:'owner-member'},request:{commandId:crypto.randomUUID(),expectedVersion:0,previousRunId:null}});assert.equal(resumed.body.outcome,'accepted');
 const messageId=await append(f),results=await Promise.all(Array.from({length:4},()=>receive(f,messageId)));assert.ok(results.every(r=>r.outcome==='accepted'));assert.ok(results.every(r=>r.state.version===2));assert.equal((await f.call('ai-listening')).body,null);
 const target=(await f.call('ai-pending-input')).body;assert.equal(target.event.messageId,messageId);assert.equal(target.controlEpoch,results[0].state.controlEpoch);assert.equal(await f.db.prepare('SELECT count(*) n FROM ai_execution').first('n'),0);
 await f.restart();assert.deepEqual((await f.call('ai-pending-input')).body,target);
 const request={runId:crypto.randomUUID(),expectedVersion:2,messageId,policyId,stage:'presale',language:'ru'};const started=await f.call('ai-start',{request});assert.equal(started.body.outcome,'accepted');assert.equal((await f.call('ai-pending-input')).body,null);
 const secondId=await append(f),second=await receive(f,secondId);assert.equal(second.state.reception,'ai');assert.equal((await f.call('ai-read',{runId:request.runId})).body,null);assert.equal((await f.call('ai-pending-input')).body.event.messageId,secondId);
 await command(f,4,'takeover');assert.equal((await f.call('ai-pending-input')).body,null);const replay=await receive(f,secondId);assert.equal(replay.state.reception,'human');assert.equal(replay.state.version,5);assert.equal((await f.call('ai-pending-input')).body,null);assert.equal(f.providerRequests.length,0);
});
test('input received before explicit resumption cannot become its pending AI target',{timeout:30000},async t=>{
 const f=await conversationControlFixture(undefined,{aiEnabled:'true'});t.after(f.close);await policy(f);const id=await append(f);
 assert.equal((await f.call('ai-listen',{actor:{...f.actor(),expectedMemberId:'owner-member'},request:{commandId:crypto.randomUUID(),expectedVersion:0,previousRunId:null}})).body.outcome,'accepted');
 assert.equal((await receive(f,id)).outcome,'ignored');assert.equal((await f.call('ai-pending-input')).body,null);assert.ok((await f.call('ai-listening')).body);
 await command(f,1,'resolve');await f.restart();assert.equal((await receive(f,id)).outcome,'ignored');assert.equal((await f.call('read')).body.view.state.version,2);
});
test('new input on a paused conversation keeps initial admission available without granting AI authority',{timeout:30000},async t=>{
 const f=await conversationControlFixture();t.after(f.close);const result=await receive(f,await append(f));assert.equal(result.state.controlEpoch,0);assert.equal(result.state.reception,'paused');assert.equal((await f.call('ai-pending-input')).body,null);
});
test('late delivery of an input already admitted to the active AI run does not restart that run',{timeout:30000},async t=>{
 const f=await conversationControlFixture(undefined,{aiEnabled:'true'});t.after(f.close);const policyId=await policy(f),messageId=await append(f),runId=crypto.randomUUID();
 assert.equal((await f.call('ai-start',{request:{runId,expectedVersion:0,messageId,policyId,stage:'presale',language:'ru'}})).body.outcome,'accepted');
 const result=await receive(f,messageId);assert.equal(result.outcome,'ignored');assert.equal(result.state.version,1);assert.equal((await f.call('ai-pending-input')).body,null);assert.ok((await f.call('ai-read',{runId})).body);
 await command(f,1,'resolve');await f.restart();assert.equal((await receive(f,messageId)).outcome,'ignored');assert.equal((await f.call('read')).body.view.state.version,2);
});
test('inbound receipt survives projection failure and restart, and its transaction rolls back as a unit',{timeout:30000},async t=>{
 const f=await conversationControlFixture();t.after(f.close);const id=await append(f);await f.call('faults',{value:{commit:true}});assert.equal((await f.call('inbound',{eventId:id})).status,500);
 await f.call('faults',{value:{project:true}});const result=await receive(f,id);assert.equal(result.state.version,1);assert.equal((await f.call('read')).body.view.projectionPending,true);await f.restart();assert.deepEqual((await receive(f,id)).receipt,result.receipt);
 await f.call('faults',{value:{}});await f.call('repair');assert.equal(await f.db.prepare("SELECT count(*) n FROM conversation_control_event WHERE action='customer_message'").first('n'),1);
 await assert.rejects(()=>projectControlEvents(f.db,f.scope,[{scope:f.scope,receipt:{...result.receipt,event:{...result.receipt.event,scope:{...f.scope,organizationId:'other'}}}}],Date.now()),/SCOPE_MISMATCH/);
});
test('replacement input cannot rotate an unclosed execution ledger or reuse an unrelated message',{timeout:30000},async t=>{
 const f=await conversationControlFixture(undefined,{aiEnabled:'true'});t.after(f.close);const policyId=await policy(f),messageId=await append(f),runId=crypto.randomUUID();
 assert.equal((await f.call('ai-start',{request:{runId,expectedVersion:0,messageId,policyId,stage:'presale',language:'ru'}})).body.outcome,'accepted');
 const budgetId=crypto.randomUUID(),startsAt=Math.floor(Date.now()/86400000)*86400000;
 assert.equal((await changeAiBudget(f.db,{...f.actor(),expectedMemberId:'owner-member'},{id:budgetId,action:'create',startsAt,endsAt:startsAt+86400000,limitMicros:2000000,maxRuns:10})).outcome,'applied');
 assert.equal((await changeAiBudget(f.db,{...f.actor(),expectedMemberId:'owner-member'},{id:crypto.randomUUID(),action:'set_enabled',budgetId,expectedRevision:0,enabled:true})).outcome,'applied');
 const config={maxGenerations:2,model:{provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'synthetic',promptVersion:'synthetic',maxInputTokens:262144,maxOutputTokens:2048,
  pricing:{version:'synthetic',currency:'USD',inputMicrosPerMillion:1000000,outputMicrosPerMillion:1000000,cacheReadMicrosPerMillion:1000000,cacheWriteMicrosPerMillion:1000000}}};
 assert.equal((await reserveAiExecution(f.db,async(scope,id)=>(await f.call('ai-read',{runId:id},scope)).body,f.scope,runId,budgetId,config)).outcome,'reserved');
 const nextId=await append(f);assert.equal((await receive(f,nextId)).state.version,2);const request={runId:crypto.randomUUID(),expectedVersion:2,messageId:nextId,policyId,stage:'presale',language:'ru'};
 assert.equal((await f.call('ai-start',{request})).body.outcome,'unavailable');assert.equal((await f.call('ai-pending-input')).body.event.messageId,nextId);
 await closeAiExecution(f.db,f.scope,runId,{kind:'unstarted_closed',providerPermits:0,evidenceId:crypto.randomUUID(),instanceId:`ai-support:${runId}`,executionClosed:true,verifiedAt:Date.now()});
 assert.notEqual((await f.call('ai-start',{request:{...request,messageId}})).body.outcome,'accepted');assert.equal((await f.call('ai-start',{request})).body.outcome,'accepted');assert.equal(f.providerRequests.length,0);
});
test('customer-message migration preserves audit and restores guards after transactional rollback',{timeout:30000},async t=>{
 const f=await conversationControlFixture('0036');t.after(f.close);await command(f,0,'claim');const before=(await f.db.prepare('SELECT * FROM conversation_control_event').all()).results;
 const statements=(await readFile(new URL('../migrations/0037_customer_message.sql',import.meta.url),'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);
 await assert.rejects(()=>f.db.batch([...statements.slice(0,3).map(s=>f.db.prepare(s)),f.db.prepare('SELECT * FROM missing_migration_table')]));assert.deepEqual((await f.db.prepare('SELECT * FROM conversation_control_event').all()).results,before);
 await f.db.batch(statements.map(s=>f.db.prepare(s)));assert.deepEqual((await f.db.prepare('SELECT * FROM conversation_control_event').all()).results,before);
 await assert.rejects(()=>f.db.prepare("UPDATE conversation_control_event SET receipt='{}'").run(),/IMMUTABLE/);
 const result=await receive(f,await append(f));assert.equal(result.state.version,2);await assert.rejects(()=>f.db.prepare("INSERT INTO conversation_control_event SELECT controller_id,organization_id,store_id,conversation_id,sequence,command_id,actor_user_id,actor_member_id,action,'{}',projected_at FROM conversation_control_event LIMIT 1").run(),/CONFLICT/);
 assert.equal((await f.db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
});
