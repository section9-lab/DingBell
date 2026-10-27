import assert from 'node:assert/strict';
import {test} from 'node:test';
import {aiSendFixture,waitAiSend} from './fixtures/ai-send.ts';

type Fixture=Awaited<ReturnType<typeof aiSendFixture>>;
async function enqueue(x:Fixture){const result=await x.enqueue();assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.outcome,'accepted',JSON.stringify(result.body));return result.body.receipt;}
async function state(x:Fixture){const result=await x.f.call('read',{},x.scope);assert.equal(result.status,200);return result.body.view.state;}
async function handoffs(x:Fixture){return (await x.f.db.prepare("SELECT receipt FROM conversation_control_event WHERE conversation_id=? AND action='request_handoff'").bind(x.scope.conversationId).all<{receipt:string}>()).results;}
async function expire(x:Fixture){await waitAiSend(async()=>Date.now()>=x.run.deadlineAt,10000);const result=await x.f.call('repair',{},x.scope);assert.equal(result.status,200,JSON.stringify(result.body));}

test('confirmed AI delivery remains completed after restart and its original deadline without false timeout handoff',{timeout:30000},async t=>{
 const x=await aiSendFixture({aiTimeoutMs:5000});t.after(x.f.close);await x.ready();const receipt=await enqueue(x);
 await waitAiSend(async()=>(await x.reply()).status==='sent');const before=await state(x);assert.equal(before.reception,'ai');
 await x.f.restart();await expire(x);
 assert.deepEqual(await state(x),before,'successful customer delivery must not be changed into a timeout handoff');assert.deepEqual(await handoffs(x),[]);
 assert.equal((await x.f.call('inspect')).body.aiDeadline,undefined);assert.equal((await x.reply()).status,'sent');
 assert.deepEqual((await x.enqueue()).body.receipt,receipt);assert.equal(x.f.providerRequests.length,1);
 assert.equal((await x.f.call('ai-read',{runId:x.runId},x.scope)).body,null,'completed delivery never extends the old execution authority');
});
test('failed and unknown AI deliveries retain their deadline fallback without any additional send attempt',{timeout:45000},async()=>{
 for(const [mode,status]of [['429','failed'],['lost','unknown']]){
  const x=await aiSendFixture({aiTimeoutMs:5000});try{
   await x.ready();x.f.provider(mode!);await enqueue(x);await waitAiSend(async()=>(await x.reply()).status===status);
   await expire(x);const paused=await state(x);assert.equal(paused.reception,'paused');assert.equal(paused.controlEpoch,x.run.controlEpoch+1);
   const events=await handoffs(x);assert.equal(events.length,1);const receipt=JSON.parse(events[0]!.receipt);assert.equal(receipt.input.reason,'tool_failure');assert.equal(receipt.input.schemaVersion,2);assert.deepEqual(receipt.input.neededInformation,[]);
   await x.f.call('repair',{},x.scope);assert.equal((await x.reply()).status,status);assert.equal(x.f.providerRequests.length,1);assert.equal((await handoffs(x)).length,1);
  }finally{await x.f.close();}
 }
});
test('a late successful AI response settles its single attempt without reversing an expired run handoff',{timeout:30000},async t=>{
 const x=await aiSendFixture({aiTimeoutMs:5000});t.after(x.f.close);await x.ready();x.f.provider('hold');await enqueue(x);
 await waitAiSend(async()=>x.f.providerRequests.length===1);assert.equal((await x.reply()).status,'sending');
 await expire(x);const paused=await state(x);assert.equal(paused.reception,'paused');assert.equal(paused.controlEpoch,x.run.controlEpoch+1);
 x.f.releaseProvider();await waitAiSend(async()=>(await x.reply()).status==='sent');assert.deepEqual(await state(x),paused);
 await x.f.call('repair',{},x.scope);assert.deepEqual(await state(x),paused);assert.equal(x.f.providerRequests.length,1);assert.equal((await handoffs(x)).length,1);
});
