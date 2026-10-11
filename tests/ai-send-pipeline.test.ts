import assert from 'node:assert/strict';
import {test} from 'node:test';
import {conversationControlFixture} from './fixtures/conversation-control.ts';
import {aiSendFixture,waitAiSend} from './fixtures/ai-send.ts';
import {withdrawKnowledge} from '../src/modules/knowledge/storage.ts';
import {closeAiExecution} from '../src/modules/ai-runs/storage.ts';

type Fixture=Awaited<ReturnType<typeof aiSendFixture>>;
async function accepted(x:Fixture,extra:Record<string,unknown>={}){
 const result=await x.enqueue(extra);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.outcome,'accepted',JSON.stringify(result.body));return result.body;
}
async function refused(x:Fixture){
 const result=await x.enqueue();assert.equal(result.status,200,JSON.stringify(result.body));assert.notEqual(result.body.outcome,'accepted');
 assert.equal((await x.f.db.prepare('SELECT count(*) n FROM send_intent').first<{n:number}>())?.n,0);assert.deepEqual(x.f.providerRequests,[]);
}

test('the internal AI sender entry point exists and rejects an unknown original run',{timeout:30000},async t=>{
 const f=await conversationControlFixture(undefined,{aiEnabled:'true',outboundEnabled:'true',aiOutboundEnabled:'true'});t.after(f.close);
 const result=await f.call('ai-reply-enqueue',{runId:crypto.randomUUID()});
 assert.equal(result.status,200,'enqueueAiReply must exist as an internal controller entry point');
 assert.notEqual(result.body.outcome,'accepted');assert.deepEqual(f.providerRequests,[]);
});

test('a completed and settled AI reply uses the shared sender once with original provenance',{timeout:30000},async t=>{
 const x=await aiSendFixture();t.after(x.f.close);await x.ready();const result=await accepted(x);
 assert.equal(result.receipt.action,'ai_send_reply');assert.equal(result.receipt.runId,x.runId);assert.equal(result.receipt.origin,'ai');
 assert.equal(result.receipt.actorUserId,null);assert.equal(result.receipt.actorMemberId,null);
 await waitAiSend(async()=>(await x.reply())?.status==='sent');
 assert.deepEqual(x.f.providerRequests,[{path:'/v1/chat/send/message',body:{chat_id:'thread',text:x.input.body}}]);
 const view=await x.reply();assert.equal(view.body,x.input.body);assert.equal(view.attempt.status,'sent');
 const stored=(await x.f.call('inspect')).body.replies[0][1].intent;
 assert.equal(stored.schemaVersion,2);assert.equal(stored.origin,'ai');assert.equal(stored.runId,x.runId);assert.equal(stored.id,x.intentId);
 assert.equal(stored.actorUserId,null);assert.equal(stored.actorMemberId,null);assert.equal(stored.controlEpoch,x.run.controlEpoch);
 const row=await x.f.db.prepare('SELECT schema_version,actor_user_id,actor_member_id,state FROM send_intent WHERE id=?').bind(x.intentId).first();
 assert.deepEqual(row,{schema_version:2,actor_user_id:null,actor_member_id:null,state:'sent'});
 const audit=await x.f.db.prepare('SELECT action,actor_user_id,actor_member_id,receipt FROM conversation_control_event WHERE command_id=?').bind(x.intentId).first<{action:string;actor_user_id:string|null;actor_member_id:string|null;receipt:string}>();
 assert.ok(audit);assert.equal(audit.action,'ai_send_reply');assert.equal(audit.actor_user_id,null);assert.equal(audit.actor_member_id,null);assert.deepEqual(JSON.parse(audit.receipt),result.receipt);
 assert.equal((await x.f.call('replies')).body.replies[0].intentId,x.intentId);assert.deepEqual(x.f.providerErrors,[]);
 await x.f.restart();assert.deepEqual((await accepted(x)).receipt,result.receipt);await x.f.call('repair');assert.equal(x.f.providerRequests.length,1);
});

test('unclosed, failed, aborted, unstarted and unsettled executions cannot create a send',{timeout:120000},async()=>{
 for(const kind of ['no-prepared','pending','failed','aborted','unsettled','unstarted']){
  const x=await aiSendFixture();try{
   if(kind!=='no-prepared')await x.prepare();
   if(kind==='failed'||kind==='aborted')await x.finish(kind);
   else if(kind==='unsettled')await x.finish('completed',false);
   else if(kind==='no-prepared')await x.finish();
   else if(kind==='unstarted')await closeAiExecution(x.f.db,x.scope,x.runId,{kind:'unstarted_closed',evidenceId:crypto.randomUUID(),instanceId:'ai-support:'+x.runId,executionClosed:true,providerPermits:0,verifiedAt:Date.now()});
   await refused(x);
  }finally{await x.f.close();}
 }
});

test('human commands cannot impersonate the internal AI sender or reserve an AI identity',{timeout:30000},async t=>{
 const x=await aiSendFixture();t.after(x.f.close);await x.ready();const state=(await x.f.call('read')).body.view.state;
 const forged=await x.f.call('execute',{command:{commandId:crypto.randomUUID(),action:'ai_send_reply',expectedVersion:state.version,body:x.input.body,runId:x.runId}});
 assert.equal(forged.status,500);assert.match(forged.body.error,/INVALID_CONTROL_COMMAND/);
 const reserved=await x.f.call('execute',{command:{commandId:x.intentId,action:'send_reply',expectedVersion:state.version,body:x.input.body}});
 assert.equal(reserved.status,200);assert.equal(reserved.body.outcome,'conflict');assert.equal(reserved.body.reason,'command');
 assert.equal((await x.f.db.prepare('SELECT count(*) n FROM send_intent').first<{n:number}>())?.n,0);assert.deepEqual(x.f.providerRequests,[]);
});

test('AI dispatch remains disabled by default and requires all exact outbound switches',{timeout:120000},async()=>{
 for(const config of [{aiOutboundEnabled:undefined},{aiOutboundEnabled:'false'},{outboundEnabled:'false'},{aiOutboundEnabled:'TRUE'},{outboundEnabled:'TRUE'}]){
  const x=await aiSendFixture(config);try{await x.ready();await refused(x);}finally{await x.f.close();}
 }
 const x=await aiSendFixture();try{await x.ready();await x.f.restart('false');await refused(x);}finally{await x.f.close();}
});

test('queued AI sends lose authorization after deployment outbound switches are disabled',{timeout:90000},async()=>{
 for(const flag of ['AI_RECEPTION_ENABLED','AI_OUTBOUND_ENABLED','OUTBOUND_ENABLED']){
  const x=await aiSendFixture();try{await x.ready();await x.holdQueue();await accepted(x);
   await x.f.restart(flag==='AI_RECEPTION_ENABLED'?'false':undefined,flag==='AI_OUTBOUND_ENABLED'?{aiOutboundEnabled:'false'}:flag==='OUTBOUND_ENABLED'?{outboundEnabled:'false'}:{});
   await x.f.call('repair');await waitAiSend(async()=>(await x.reply()).status==='skipped');assert.deepEqual(x.f.providerRequests,[]);
  }finally{await x.f.close();}
 }
});

test('AI delivery does not borrow a merchant employee identity or session',{timeout:30000},async t=>{
 const x=await aiSendFixture();t.after(x.f.close);await x.ready();await x.f.db.prepare("DELETE FROM session WHERE user_id='owner'").run();
 const result=await accepted(x);assert.equal(result.receipt.actorUserId,null);assert.equal(result.receipt.actorMemberId,null);
 const staffReply=async()=>{const result=await x.f.call('reply',{intentId:x.intentId,actor:x.f.actor('staff')});assert.equal(result.status,200);return result.body.reply;};
 await waitAiSend(async()=>(await staffReply())?.status==='sent');assert.equal((await staffReply()).body,x.input.body);assert.equal(x.f.providerRequests.length,1);
 assert.equal((await x.f.call('reply',{intentId:x.intentId})).body.outcome,'not_found');
 const audit=await x.f.db.prepare('SELECT actor_user_id,actor_member_id FROM conversation_control_event WHERE command_id=?').bind(x.intentId).first();
 assert.deepEqual(audit,{actor_user_id:null,actor_member_id:null});
});

test('original scope, policy, input, source, channel and budget authority are rechecked before AI enqueue',{timeout:120000},async()=>{
 const changes:[string,(x:Fixture)=>Promise<unknown>][]=[
  ['takeover',x=>x.takeover()],['new input',x=>x.f.db.prepare("UPDATE conversation SET message_sequence=message_sequence+1 WHERE id='conv'").run()],
  ['policy',x=>x.f.db.prepare('UPDATE reply_policy SET enabled=0').run()],['budget',x=>x.f.db.prepare('UPDATE ai_budget SET enabled=0').run()],
  ['source',x=>withdrawKnowledge(x.f.db,x.actor,x.documentId,2)],['capability',x=>x.f.db.prepare("UPDATE store SET capabilities='[]' WHERE id='store'").run()],
  ['store outbound',x=>x.f.db.prepare("UPDATE store SET outbound_enabled=0 WHERE id='store'").run()],
  ['credential',x=>x.f.db.prepare("UPDATE store SET credential_version=2 WHERE id='store'").run()],
  ['thread',x=>x.f.db.prepare("UPDATE conversation SET platform_thread_id='replaced' WHERE id='conv'").run()],
 ];
 for(const [label,change]of changes){const x=await aiSendFixture();try{await x.ready();await change(x);await refused(x);}catch(e){throw new Error(label,{cause:e});}finally{await x.f.close();}}
 const x=await aiSendFixture();try{
  await x.ready();for(const scope of [{...x.scope,organizationId:'other-org'},{...x.scope,storeId:'foreign'},{...x.scope,conversationId:'second'},{...x.scope,controllerId:crypto.randomUUID()}]){
   const result=await x.f.call('ai-reply-enqueue',{runId:x.runId},scope);assert.equal(result.status,200);assert.notEqual(result.body.outcome,'accepted');
  }assert.deepEqual(x.f.providerRequests,[]);
 }finally{await x.f.close();}
});

test('AI enqueue loses no identity across concurrent replay, a lost response and controller restart',{timeout:30000},async t=>{
 const x=await aiSendFixture();t.after(x.f.close);await x.ready();await x.holdQueue();
 assert.equal((await x.enqueue({loseResponse:true})).status,500);
 const results=await Promise.all([accepted(x),accepted(x)]);assert.deepEqual(results[0].receipt,results[1].receipt);
 assert.equal((await x.f.db.prepare('SELECT count(*) n FROM send_intent').first<{n:number}>())?.n,1);
 assert.equal((await x.f.call('inspect')).body.replies.length,1);assert.deepEqual(x.f.providerRequests,[]);
 await x.f.restart();assert.deepEqual((await accepted(x)).receipt,results[0].receipt);assert.equal((await x.reply()).status,'queued');assert.deepEqual(x.f.providerRequests,[]);
});

test('queued AI sends remain revocable while waiting on a store rate limit',{timeout:60000},async()=>{
 for(const change of ['takeover','new input','source']){
  const x=await aiSendFixture();try{await x.ready();await x.holdQueue();await accepted(x);
   if(change==='takeover')await x.takeover();else if(change==='new input')await x.f.db.prepare("UPDATE conversation SET message_sequence=message_sequence+1 WHERE id='conv'").run();else await withdrawKnowledge(x.f.db,x.actor,x.documentId,2);
   await x.f.call('repair');await waitAiSend(async()=>(await x.reply()).status==='skipped');assert.deepEqual(x.f.providerRequests,[]);
   await x.f.restart();assert.equal((await x.reply()).status,'skipped');await accepted(x);assert.deepEqual(x.f.providerRequests,[]);
  }finally{await x.f.close();}
 }
});

test('a queued AI send cannot extend the original run deadline',{timeout:30000},async t=>{
 const x=await aiSendFixture({aiTimeoutMs:5000});t.after(x.f.close);await x.ready();await x.holdQueue();await accepted(x);
 await waitAiSend(async()=>Date.now()>=x.run.deadlineAt,10000);await x.f.call('repair');
 await waitAiSend(async()=>(await x.reply()).status==='skipped');assert.deepEqual(x.f.providerRequests,[]);
 await accepted(x);assert.equal((await x.reply()).status,'skipped');assert.deepEqual(x.f.providerRequests,[]);
});

test('in-flight AI delivery records its original outcome without changing a newer human takeover',{timeout:30000},async t=>{
 const x=await aiSendFixture();t.after(x.f.close);await x.ready();x.f.provider('hold');const queued=await accepted(x);
 await waitAiSend(async()=>x.f.providerRequests.length===1);const human=await x.takeover();assert.equal(human.reception,'human');
 assert.equal((await x.reply()).status,'sending');x.f.releaseProvider();await waitAiSend(async()=>(await x.reply()).status==='sent');
 assert.deepEqual((await x.f.call('read')).body.view.state,human);assert.deepEqual((await accepted(x)).receipt,queued.receipt);
 await x.f.call('repair');assert.equal(x.f.providerRequests.length,1);
});

test('rate-limit and uncertain AI results never issue a second provider attempt',{timeout:60000},async()=>{
 for(const [mode,status]of [['429','failed'],['lost','unknown']]){
  const x=await aiSendFixture();try{await x.ready();x.f.provider(mode);const queued=await accepted(x);
   await waitAiSend(async()=>(await x.reply()).status===status);assert.equal(x.f.providerRequests.length,1);
   await x.f.call('repair');await x.f.restart();assert.deepEqual((await accepted(x)).receipt,queued.receipt);await x.f.call('repair');
   assert.equal((await x.reply()).status,status);assert.equal(x.f.providerRequests.length,1);
   assert.equal((await x.f.db.prepare('SELECT count(*) n FROM send_attempt WHERE intent_id=?').bind(x.intentId).first<{n:number}>())?.n,1);
  }finally{await x.f.close();}
 }
});
