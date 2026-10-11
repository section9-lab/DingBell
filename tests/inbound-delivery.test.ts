import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {URL} from 'node:url';
import {conversationControlFixture} from './fixtures/conversation-control.ts';
import type {ControlBindings} from '../src/modules/conversations/control-bindings.ts';
async function api(){const m=await import('../src/modules/conversations/inbound-delivery.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.deliverInboundEvents,'function','committed inbound events need a durable consumer');return m!;}
async function fixture(through?:string){
 const f=await conversationControlFixture(through);let loseAck=false;const calls:{eventId:string;outcome:string}[]=[];
 const env={DB:f.db,CONVERSATION_CONTROLLER:{idFromName:(id:string)=>id,get:()=>({receiveInbound:async(scope:any,eventId:string)=>{
  const result=await f.call('inbound',{eventId},scope);assert.equal(result.status,200);calls.push({eventId,outcome:result.body.outcome});if(loseAck){loseAck=false;throw new Error('synthetic lost acknowledgement');}return result.body;
 }})}} as unknown as ControlBindings;
 return {...f,env,calls,loseAck(){loseAck=true;},async append(state='pending',at=Date.now()){
  const id=crypto.randomUUID(),now=Date.now();await f.db.batch([
   f.db.prepare(`INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode)
    VALUES(?,'org','store','conv',?,'Customer','inbound','["Вопрос"]',0,0,?,?,'incremental')`).bind(id,id,at,now),
   f.db.prepare("INSERT INTO ingest_event(id,organization_id,store_id,conversation_id,message_id,state,live_observed_at,trace_id,created_at) VALUES(?,'org','store','conv',?,?,?,'synthetic',?)").bind(id,id,state,now,now),
  ]);return id;
 }};
}
test('delivery leases are atomic and expired acknowledgements cannot finish a newer claim',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);await f.append();await f.append();await f.append('historical');const now=Date.now();
 const batches=await Promise.all([m.claimInboundEvents(f.db,now,1),m.claimInboundEvents(f.db,now,1)]);assert.equal(batches[0].length,1);assert.equal(batches[1].length,1);assert.notEqual(batches[0][0].eventId,batches[1][0].eventId);assert.deepEqual(await m.claimInboundEvents(f.db,now),[]);
 const first=batches[0][0];await f.db.prepare('UPDATE ingest_event SET delivery_due_at=0 WHERE id=?').bind(first.eventId).run();const replacement=(await m.claimInboundEvents(f.db,now+1,1))[0];assert.notEqual(replacement.token,first.token);
 await m.finishInboundEvent(f.db,first,'accepted',now);await m.finishInboundEvent(f.db,{...replacement,organizationId:'other'},'accepted',now);assert.equal(await f.db.prepare('SELECT processed_at FROM ingest_event WHERE id=?').bind(first.eventId).first('processed_at'),null);
 await m.finishInboundEvent(f.db,replacement,'accepted',now);assert.equal(await f.db.prepare('SELECT delivery_outcome FROM ingest_event WHERE id=?').bind(first.eventId).first('delivery_outcome'),'accepted');
 await assert.rejects(()=>m.claimInboundEvents(f.db,now,0));await assert.rejects(()=>m.claimInboundEvents(f.db,now,51));
});
test('the consumer initializes a scoped directory and lost acknowledgements replay only the original effect',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);const id=await f.append();await f.db.prepare('DELETE FROM conversation_control').run();f.loseAck();await m.deliverInboundEvents(f.env);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].outcome,'accepted');assert.equal(await f.db.prepare('SELECT processed_at FROM ingest_event WHERE id=?').bind(id).first('processed_at'),null);
 await m.deliverInboundEvents(f.env);assert.equal(f.calls.length,1);await f.db.prepare('UPDATE ingest_event SET delivery_due_at=0').run();await m.deliverInboundEvents(f.env);
 assert.equal(f.calls.length,2);assert.equal(await f.db.prepare('SELECT version FROM conversation_control').first('version'),1);assert.equal(await f.db.prepare('SELECT count(*) n FROM conversation_control_event').first('n'),1);assert.equal(await f.db.prepare('SELECT delivery_outcome FROM ingest_event').first('delivery_outcome'),'accepted');assert.equal(f.providerRequests.length,0);
});
test('the consumer records obsolete input as ignored and does not claim work without a controller binding',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.close);const first=await f.append('pending',1);const latest=await f.append();await m.deliverInboundEvents({DB:f.db});assert.equal(await f.db.prepare('SELECT count(*) n FROM ingest_event WHERE delivery_token IS NOT NULL').first('n'),0);
 await m.deliverInboundEvents(f.env);assert.equal(await f.db.prepare('SELECT delivery_outcome FROM ingest_event WHERE id=?').bind(first).first('delivery_outcome'),'ignored');assert.equal(await f.db.prepare('SELECT delivery_outcome FROM ingest_event WHERE id=?').bind(latest).first('delivery_outcome'),'accepted');assert.equal(f.calls.length,2);await m.deliverInboundEvents(f.env);assert.equal(f.calls.length,2);
});
test('delivery migration preserves source evidence and rolls back a partial upgrade',{timeout:30000},async t=>{
 const m=await api(),f=await fixture('0037');t.after(f.close);await f.append();await f.append('historical');const before=(await f.db.prepare('SELECT * FROM ingest_event ORDER BY id').all()).results;
 const statements=(await readFile(new URL('../migrations/0038_inbound_delivery.sql',import.meta.url),'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);
 await assert.rejects(()=>f.db.batch([...statements.slice(0,2).map(s=>f.db.prepare(s)),f.db.prepare('SELECT * FROM missing_migration_table')]));assert.deepEqual((await f.db.prepare('SELECT * FROM ingest_event ORDER BY id').all()).results,before);
 await f.db.batch(statements.map(s=>f.db.prepare(s)));const after=(await f.db.prepare('SELECT * FROM ingest_event ORDER BY id').all()).results;
 assert.deepEqual(after.map(({delivery_due_at,delivery_token,processed_at,delivery_outcome,...source})=>source),before);assert.ok(after.every(row=>row.delivery_due_at===0&&row.delivery_token===null&&row.processed_at===null&&row.delivery_outcome===null));
 assert.equal((await m.claimInboundEvents(f.db,Date.now())).length,1);assert.equal((await f.db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
});
test('the actual scheduled Worker delivers committed input even when the sync branch fails',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const id=await f.append();const result=await f.call('cron',{failSync:true,recordWakes:true});assert.equal(result.status,200);assert.equal(result.body.ok,true);
 assert.equal(await f.db.prepare('SELECT delivery_outcome FROM ingest_event WHERE id=?').bind(id).first('delivery_outcome'),'accepted');assert.equal((await f.call('read')).body.view.state.version,1);
 assert.equal((await f.call('cron',{recordWakes:true})).status,200);assert.equal(await f.db.prepare('SELECT count(*) n FROM conversation_control_event').first('n'),1);assert.equal(f.providerRequests.length,0);
});
