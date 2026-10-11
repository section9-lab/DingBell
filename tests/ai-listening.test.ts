import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {URL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {conversationControlFixture} from './fixtures/conversation-control.ts';
import {createPolicy,changePolicy} from '../src/modules/reply-policies/storage.ts';

async function fixture(through?:string,aiTimeoutMs=60000){
 const f=await conversationControlFixture(through,{aiEnabled:'true',aiTimeoutMs}),actor={...f.actor(),expectedMemberId:'owner-member'},policyId=crypto.randomUUID();
 try{
  await f.db.prepare("UPDATE store SET status='verified' WHERE id='store'").run();
  const config={kind:'automatic' as const,name:'Future support',storeIds:['store'],priority:50,stages:['presale' as const],mode:'automatic' as const,language:'customer' as const,tone:'concise' as const,instructions:''};
  assert.ok(await createPolicy(f.db,actor,policyId,config));assert.ok(await changePolicy(f.db,actor,policyId,1,{action:'test'},crypto.randomUUID()));assert.ok(await changePolicy(f.db,actor,policyId,2,{action:'publish'},crypto.randomUUID()));
  const message=async(id:string,eventAt:number,mode='incremental',direction='inbound')=>f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES(?,'org','store','conv',?,?,?,'[\"Какая ширина?\"]',0,0,?,?,?)").bind(id,id,direction==='inbound'?'Customer':'Seller',direction,eventAt,Date.now(),mode).run();
  await message('old',1);
  const request={commandId:crypto.randomUUID(),expectedVersion:0,previousRunId:null as string|null};
  return {...f,get db(){return f.db;},actor,request,message,policyId,
   listen:(value:unknown=request)=>f.call('ai-listen',{actor,request:value}),
   start:(messageId:string,expectedVersion=1)=>f.call('ai-start',{request:{runId:crypto.randomUUID(),expectedVersion,messageId,policyId,stage:'presale',language:'ru'}})};
 }catch(error){await f.close();throw error;}
}
test('explicit resumption persists a new-input boundary without starting or charging a run',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);
 const responses=await Promise.all(Array.from({length:4},()=>f.listen()));assert.ok(responses.every(r=>r.body.outcome==='accepted'),'future-message resumption must be accepted');
 const first=responses[0].body;for(const r of responses)assert.deepEqual(r.body.receipt,first.receipt);
 assert.equal(first.receipt.action,'ai_listen');assert.equal(first.receipt.listening.afterSequence,1);assert.equal(first.state.version,1);assert.equal(first.state.controlEpoch,1);assert.equal(first.state.reception,'ai');assert.equal(first.canSend,false);
 assert.equal((await f.start('old')).body.outcome,'unavailable');assert.deepEqual((await f.call('ai-listening')).body,first.receipt.listening);
 assert.equal(await f.db.prepare('SELECT count(*) n FROM ai_execution').first('n'),0);assert.equal(f.providerRequests.length,0);
 await f.restart('false');assert.deepEqual((await f.listen()).body.receipt,first.receipt);assert.equal((await f.start('old')).body.outcome,'unavailable');
 assert.equal((await f.listen({...f.request,expectedVersion:1})).body.outcome,'conflict');
 await f.db.prepare("DELETE FROM session WHERE id='owner-session'").run();assert.equal((await f.listen()).body.outcome,'not_found');
});
test('only a newly appended incremental customer input can consume listening authority',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const listened=await f.listen();assert.equal(listened.body.outcome,'accepted');const at=listened.body.receipt.listening.createdAt;
 await f.message('historical',at+1,'backfill');assert.equal((await f.start('historical')).body.outcome,'unavailable');
 await f.message('seller',at+2,'incremental','outbound');assert.equal((await f.start('seller')).body.outcome,'unavailable');
 await f.message('new',at+3);const started=await f.start('new');assert.equal(started.body.outcome,'accepted');assert.equal(started.body.state.version,2);assert.equal(started.body.receipt.run.admission.messageId,'new');
 assert.equal((await f.call('ai-listening')).body,null);assert.equal((await f.start('new',2)).body.outcome,'conflict');
 assert.deepEqual((await f.db.prepare('SELECT action FROM conversation_control_event ORDER BY sequence').all()).results.map(r=>r.action),['ai_listen','ai_start']);
 const delayed=await fixture();t.after(delayed.close);assert.equal((await delayed.listen()).body.outcome,'accepted');await delayed.message('late-old',2);assert.equal((await delayed.start('late-old')).body.outcome,'unavailable');
});
test('takeover, resolve and reopen revoke future reception; replay never restores revoked authority',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);assert.equal((await f.listen()).body.outcome,'accepted');
 assert.equal((await f.call('execute',{command:{commandId:crypto.randomUUID(),expectedVersion:1,action:'takeover'}})).body.outcome,'accepted');
 assert.equal((await f.call('ai-listening')).body,null);const replay=await f.listen();assert.equal(replay.body.state.reception,'human');assert.equal(replay.body.state.version,2);
 await f.message('new',Date.now()+1);assert.equal((await f.start('new',2)).body.outcome,'conflict');
 assert.equal((await f.call('execute',{command:{commandId:crypto.randomUUID(),expectedVersion:2,action:'resolve'}})).body.outcome,'accepted');
 assert.equal((await f.listen({...f.request,commandId:crypto.randomUUID(),expectedVersion:3})).body.outcome,'conflict');
 assert.equal((await f.call('execute',{command:{commandId:crypto.randomUUID(),expectedVersion:3,action:'reopen'}})).body.outcome,'accepted');assert.equal((await f.call('read')).body.view.state.reception,'human');
 const fresh=await f.listen({...f.request,commandId:crypto.randomUUID(),expectedVersion:4});assert.equal(fresh.body.outcome,'accepted');assert.equal(fresh.body.receipt.listening.afterSequence,2);assert.equal((await f.start('new',5)).body.outcome,'unavailable');
});
test('listening rejects missing policy, channel, identity and caller-supplied input boundaries',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);
 for(const extra of [{afterSequence:0},{createdAt:0},{policyId:f.policyId},{runId:crypto.randomUUID()}])assert.equal((await f.listen({...f.request,...extra})).status,500);
 assert.equal((await f.call('ai-listen',{request:f.request,actor:{...f.actor,expectedMemberId:undefined}})).body.outcome,'not_found');
 assert.equal((await f.call('ai-listen',{request:f.request,actor:f.actor},{...f.scope,organizationId:'other-org'})).body.outcome,'not_found');
 await f.db.prepare("UPDATE store SET status='paused' WHERE id='store'").run();assert.equal((await f.listen()).body.outcome,'unavailable');await f.db.prepare("UPDATE store SET status='verified' WHERE id='store'").run();
 assert.ok(await changePolicy(f.db,f.actor,f.policyId,3,{action:'pause'},crypto.randomUUID()));assert.equal((await f.listen()).body.outcome,'unavailable');
 assert.equal((await f.call('read')).body.view.state.version,0);
});
test('resolving a waiting conversation cannot re-enable AI through the first-run path after reopening',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);assert.equal((await f.listen()).body.outcome,'accepted');
 for(const [action,expectedVersion]of [['resolve',1],['reopen',2]])assert.equal((await f.call('execute',{command:{commandId:crypto.randomUUID(),expectedVersion,action}})).body.outcome,'accepted');
 await f.message('later',Date.now()+1);assert.equal((await f.start('later',3)).body.outcome,'conflict');assert.equal((await f.call('read')).body.view.state.reception,'paused');
});
test('competing resume commands and human command collisions cannot replace the accepted boundary',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);
 assert.equal((await f.call('execute',{command:{commandId:`ai-listen:${f.request.commandId}`,expectedVersion:0,action:'add_note',body:'collision'}})).body.outcome,'conflict');
 const commands=[f.request,{...f.request,commandId:crypto.randomUUID()}],results=await Promise.all(commands.map(c=>f.listen(c)));
 assert.deepEqual(results.map(r=>r.body.outcome).sort(),['accepted','conflict']);const accepted=results.find(r=>r.body.outcome==='accepted')!.body;
 await f.restart();assert.deepEqual((await f.call('ai-listening')).body,accepted.receipt.listening);
 assert.equal((await f.call('ai-listening',{}, {...f.scope,organizationId:'other-org'})).body,null);
 assert.ok(await changePolicy(f.db,f.actor,f.policyId,3,{action:'pause'},crypto.randomUUID()));await f.message('new',Date.now()+1);assert.equal((await f.start('new')).body.outcome,'unavailable');
 assert.equal((await f.call('read')).body.view.state.version,1);
});
test('waiting survives projection failure without starting a run and recovers the original audit',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);await f.call('faults',{value:{project:true}});
 const listened=await f.listen();assert.equal(listened.body.outcome,'accepted');assert.equal((await f.call('read')).body.view.projectionPending,true);
 await f.call('faults',{value:{}});await f.call('repair');await f.restart();assert.deepEqual((await f.listen()).body.receipt,listened.body.receipt);
 assert.equal(await f.db.prepare("SELECT count(*) n FROM conversation_control_event WHERE action='ai_listen'").first('n'),1);assert.equal(await f.db.prepare('SELECT count(*) n FROM ai_execution').first('n'),0);
});
test('listening audit migration preserves existing records and rolls back incomplete replacement',{timeout:30000},async t=>{
 const f=await fixture('0035');t.after(f.close);assert.equal((await f.call('execute',{command:{commandId:'before',expectedVersion:0,action:'claim'}})).body.outcome,'accepted');
 const before=(await f.db.prepare('SELECT * FROM conversation_control_event').all()).results;
 const sql=await readFile(new URL('../migrations/0036_ai_listening.sql',import.meta.url),'utf8'),statements=sql.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);
 await assert.rejects(()=>f.db.batch([...statements.slice(0,3).map(s=>f.db.prepare(s)),f.db.prepare('SELECT * FROM missing_migration_table')]));
 assert.deepEqual((await f.db.prepare('SELECT * FROM conversation_control_event').all()).results,before);
 await f.db.batch(statements.map(s=>f.db.prepare(s)));assert.deepEqual((await f.db.prepare('SELECT * FROM conversation_control_event').all()).results,before);
 await assert.rejects(()=>f.db.prepare("UPDATE conversation_control_event SET receipt='{}'").run(),/IMMUTABLE/);
 await assert.rejects(()=>f.db.prepare("INSERT INTO conversation_control_event(controller_id,organization_id,store_id,conversation_id,sequence,command_id,action,receipt,projected_at) VALUES (?,'org','store','conv',2,'bad','ai_listen','{}',1)").bind(f.scope.controllerId).run());
 assert.equal((await f.listen({...f.request,expectedVersion:1})).body.outcome,'accepted');assert.equal((await f.db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
});
test('late expiry cleanup from the old run cannot remove the new run deadline',{timeout:30000},async t=>{
 const f=await fixture(undefined,2000);t.after(f.close);const old=await f.start('old',0);assert.equal(old.body.outcome,'accepted');
 assert.equal((await f.call('execute',{command:{commandId:crypto.randomUUID(),expectedVersion:1,action:'takeover'}})).body.outcome,'accepted');
 const listened=await f.listen({...f.request,expectedVersion:2,previousRunId:old.body.receipt.run.request.runId});assert.equal(listened.body.outcome,'accepted');
 await f.call('holdExpiry');await delay(Math.max(1,old.body.receipt.run.deadlineAt-Date.now()+20));
 const pending=f.call('repair'),deadline=Date.now()+5000;let next:any;
 try{
  while(!(await f.call('inspect')).body.expiryHeld){assert.ok(Date.now()<deadline,'old expiry must reach the controlled race');await delay(10);}
  await f.message('next',Date.now());next=await f.start('next',3);assert.equal(next.body.outcome,'accepted');
  assert.equal((await f.call('inspect')).body.aiDeadline,next.body.receipt.run.deadlineAt);
 }finally{await f.call('releaseExpiry');await pending;}
 assert.equal((await f.call('inspect')).body.aiDeadline,next.body.receipt.run.deadlineAt);
});
