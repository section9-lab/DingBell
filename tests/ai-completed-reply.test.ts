import assert from 'node:assert/strict';
import {test} from 'node:test';
import {aiAnswerFixture} from './fixtures/ai-answer.ts';
import {encryptCredentials} from '../src/modules/stores/credentials.ts';
import {withdrawKnowledge} from '../src/modules/knowledge/storage.ts';
import {knowledgeHash} from '../src/modules/knowledge/content.ts';
import {bindAiExecutionReceipt,claimAiGeneration,settleAiGeneration,closeAiExecution,readAiExecution,type AiRunReader} from '../src/modules/ai-runs/storage.ts';

async function api(){
 const m=await import('../src/modules/ai-runs/reply-intent.ts') as typeof import('../src/modules/ai-runs/reply-intent.ts') & {
  reviewCompletedAiReply:(...args:Parameters<typeof import('../src/modules/ai-runs/reply-intent.ts').reviewAiReply>)=>ReturnType<typeof import('../src/modules/ai-runs/reply-intent.ts').reviewAiReply>;
 };
 assert.equal(typeof m.reviewCompletedAiReply,'function','A completed AI runtime needs independent, current-authority dispatch review');return m;
}
async function fixture(prompt='support-reply-v1',prepared=true){
 const x=await aiAnswerFixture(prompt);
 try{
  const key=await encryptCredentials(x.f.credentialEnv,{orgId:'org',storeId:'store',platformStoreId:'1',credentialVersion:1},{apiKey:'synthetic-api-key'});
  await x.f.db.prepare("UPDATE store SET outbound_enabled=1,credential_key_version=?,credential_nonce=?,credential_ciphertext=?,capabilities=?,checked_at=?,expires_at=? WHERE id='store'")
   .bind(key.keyVersion,key.nonce,key.ciphertext,JSON.stringify([{code:'auth',status:'available'},{code:'reply',status:'available'}]),Date.now(),Date.now()+3600000).run();
  const env={...x.env,AI_OUTBOUND_ENABLED:'true',OUTBOUND_ENABLED:'true'},receipt={submissionId:'synthetic-completed',uid:'synthetic-completed-runtime',acceptedAt:new Date().toISOString()};
  if(prepared)assert.equal((await (await api()).prepareAiReply(env,x.read,x.scope,x.run.request.runId,x.input)).status,'prepared');
  return {...x,env,receipt};
 }catch(e){await x.f.close();throw e;}
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function generation(x:Fixture,sequence=1,settled=true){
 const id=x.run.request.runId;await bindAiExecutionReceipt(x.f.db,x.scope,id,x.receipt);
 assert.equal(await claimAiGeneration(x.f.db,x.read,x.scope,id,sequence),true);
 if(settled)await settleAiGeneration(x.f.db,x.scope,id,sequence,x.receipt,{input:10,output:5,cacheRead:0,cacheWrite:0});
}
async function close(x:Fixture,outcome:'completed'|'failed'|'aborted'='completed'){
 const id=x.run.request.runId,execution=await readAiExecution(x.f.db,x.scope,id);assert.ok(execution);
 await closeAiExecution(x.f.db,x.scope,id,{kind:'runtime_closed',evidenceId:crypto.randomUUID(),instanceId:'ai-support:'+id,receipt:x.receipt,
  outcome,executionClosed:true,providerPermits:execution.generations.length,verifiedAt:Date.now()});
}
const budget=(x:Fixture)=>x.f.db.prepare('SELECT * FROM ai_budget').all();
async function noSend(x:Fixture){
 assert.equal((await x.f.db.prepare('SELECT count(*) n FROM send_intent').first<{n:number}>())?.n,0);
 assert.deepEqual(x.f.providerRequests,[]);assert.deepEqual(x.f.providerErrors,[]);
}

test('completed AI reply review retains the exact original intent without reserving or granting send authority',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);const id=x.run.request.runId;
 const live=await m.reviewAiReply(x.env,x.read,x.scope,id);assert.ok(live);
 await generation(x);await generation(x,2);await close(x);
 const execution=await readAiExecution(x.f.db,x.scope,id);assert.ok(execution);assert.equal(execution.status,'settled');assert.equal(execution.remainingReservedMicros,0);
 assert.ok(execution.generations.every(g=>g.usage!==null&&g.chargedMicros!==null&&g.settledAt!==null));
 assert.equal((await m.prepareAiReply(x.env,x.read,x.scope,id,x.input)).status,'unavailable');assert.equal(await m.reviewAiReply(x.env,x.read,x.scope,id),null);
 const before=await budget(x),saved=await m.reviewCompletedAiReply(x.env,x.read,x.scope,id);assert.deepEqual(saved,live);
 assert.deepEqual(await m.reviewCompletedAiReply(x.env,x.read,x.scope,id),saved);assert.deepEqual(await budget(x),before);
 assert.equal(saved!.origin,'ai');assert.equal(saved!.actorUserId,null);assert.equal(saved!.actorMemberId,null);assert.equal(saved!.canSend,false);
 assert.equal(saved!.bodyHash,await knowledgeHash(x.input.body));await noSend(x);
});
test('completed AI reply review refuses live, failed, aborted and never-started executions',{timeout:60000},async()=>{
 const m=await api();
 for(const kind of ['live','failed','aborted','unstarted'] as const){
  const x=await fixture();try{
   if(kind==='unstarted')await closeAiExecution(x.f.db,x.scope,x.run.request.runId,{kind:'unstarted_closed',evidenceId:crypto.randomUUID(),instanceId:'ai-support:'+x.run.request.runId,executionClosed:true,providerPermits:0,verifiedAt:Date.now()});
   else{await generation(x);if(kind!=='live')await close(x,kind);}
   assert.equal(await m.reviewCompletedAiReply(x.env,x.read,x.scope,x.run.request.runId),null,kind);await noSend(x);
  }finally{await x.f.close();}
 }
});
test('unconfirmed AI usage and a closure without any generation cannot authorize a completed reply',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);const id=x.run.request.runId;
 await generation(x,1,false);await close(x);
 assert.equal((await readAiExecution(x.f.db,x.scope,id))!.status,'unconfirmed');assert.equal(await m.reviewCompletedAiReply(x.env,x.read,x.scope,id),null);
 await settleAiGeneration(x.f.db,x.scope,id,1,x.receipt,{input:10,output:5,cacheRead:0,cacheWrite:0});
 assert.ok(await m.reviewCompletedAiReply(x.env,x.read,x.scope,id));await noSend(x);
 const empty=await fixture();t.after(empty.f.close);await bindAiExecutionReceipt(empty.f.db,empty.scope,empty.run.request.runId,empty.receipt);await close(empty);
 assert.equal(await m.reviewCompletedAiReply(empty.env,empty.read,empty.scope,empty.run.request.runId),null);await noSend(empty);
});
test('completed review rejects missing intents and cannot promote a human-review prompt',{timeout:60000},async()=>{
 const m=await api();
 for(const prompt of ['support-reply-v1','support-answer-v1']){
  const x=await fixture(prompt,false);try{
   if(prompt==='support-answer-v1'){
    const execution=await x.f.db.prepare('SELECT payload_hash AS hash FROM ai_execution WHERE id=?').bind(x.run.request.runId).first<{hash:string}>();assert.ok(execution);
    await x.f.db.prepare('INSERT INTO ai_reply_intent(run_id,id,payload_hash,body,body_hash,citations,knowledge_evidence,platform_store_id,platform_thread_id,credential_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
     .bind(x.run.request.runId,'ai-reply:'+x.run.request.runId,execution.hash,x.input.body,await knowledgeHash(x.input.body),JSON.stringify(x.input.citations),JSON.stringify(x.evidence),'1','thread',1,Date.now()).run();
   }
   await generation(x);await close(x);assert.equal(await m.reviewCompletedAiReply(x.env,x.read,x.scope,x.run.request.runId),null,prompt);await noSend(x);
  }finally{await x.f.close();}
 }
});
test('completed reply keeps all kill switches and budget validity but requires no spare admission or reserve',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);const id=x.run.request.runId;await generation(x);await close(x);
 await x.f.db.prepare('UPDATE ai_budget SET spent_micros=limit_micros,admitted_runs=max_runs').run();
 const before=await budget(x);assert.ok(await m.reviewCompletedAiReply(x.env,x.read,x.scope,id));assert.deepEqual(await budget(x),before);
 for(const flag of ['AI_RECEPTION_ENABLED','AI_OUTBOUND_ENABLED','OUTBOUND_ENABLED'])for(const value of [undefined,'false','TRUE'])assert.equal(await m.reviewCompletedAiReply({...x.env,[flag]:value},x.read,x.scope,id),null,flag);
 await x.f.db.prepare('UPDATE ai_budget SET enabled=0').run();assert.equal(await m.reviewCompletedAiReply(x.env,x.read,x.scope,id),null);
 await noSend(x);
});
test('completed reply cannot survive current policy, input, source or DO control revocation',{timeout:60000},async()=>{
 const m=await api();
 const changes:[string,(x:Fixture)=>Promise<unknown>][]=[
  ['policy',x=>x.f.db.prepare('UPDATE reply_policy SET enabled=0').run()],
  ['new input',x=>x.f.db.prepare("UPDATE conversation SET message_sequence=message_sequence+1 WHERE id='conv'").run()],
  ['source withdrawal',x=>withdrawKnowledge(x.f.db,x.actor,x.documentId,2)],
  ['takeover',async x=>{const state=(await x.f.call('read',{},x.scope)).body.view.state;assert.equal((await x.f.call('execute',{command:{commandId:crypto.randomUUID(),action:'takeover',expectedVersion:state.version}},x.scope)).body.outcome,'accepted');}],
 ];
 for(const [label,change]of changes){const x=await fixture();try{
  await generation(x);await close(x);assert.ok(await m.reviewCompletedAiReply(x.env,x.read,x.scope,x.run.request.runId));
  await change(x);assert.equal(await m.reviewCompletedAiReply(x.env,x.read,x.scope,x.run.request.runId),null,label);await noSend(x);
 }finally{await x.f.close();}}
});
test('completed reply freezes its tenant, channel, credentials and original deadline',{timeout:60000},async()=>{
 const m=await api();
 const x=await fixture();try{
  await generation(x);await close(x);const id=x.run.request.runId;
  for(const changed of [{organizationId:'foreign'},{storeId:'foreign'},{conversationId:'second'},{controllerId:crypto.randomUUID()}])assert.equal(await m.reviewCompletedAiReply(x.env,x.read,{...x.scope,...changed},id),null);
  for(const sql of ["UPDATE store SET credential_version=2 WHERE id='store'","UPDATE store SET platform_store_id='2' WHERE id='store'","UPDATE conversation SET platform_thread_id='different-thread' WHERE id='conv'","UPDATE store SET capabilities='[]' WHERE id='store'","UPDATE store SET outbound_enabled=0 WHERE id='store'"]){
   await x.f.db.prepare(sql).run();assert.equal(await m.reviewCompletedAiReply(x.env,x.read,x.scope,id),null);
   await x.f.db.prepare("UPDATE store SET credential_version=1,platform_store_id='1',outbound_enabled=1,capabilities=? WHERE id='store'").bind(JSON.stringify([{code:'auth',status:'available'},{code:'reply',status:'available'}])).run();
   await x.f.db.prepare("UPDATE conversation SET platform_thread_id='thread' WHERE id='conv'").run();
  }
  const absent:AiRunReader=async()=>null;assert.equal(await m.reviewCompletedAiReply(x.env,absent,x.scope,id),null);await noSend(x);
 }finally{await x.f.close();}
});
test('completed reply expires at the original run deadline and rejects takeover during its final read',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);const id=x.run.request.runId;await generation(x);await close(x);
 const clock=t.mock.method(Date,'now',()=>x.run.deadlineAt);try{assert.equal(await m.reviewCompletedAiReply(x.env,x.read,x.scope,id),null);}finally{clock.mock.restore();}
 let reads=0;const raced:AiRunReader=async(scope,runId)=>{
  if(++reads===2){const state=(await x.f.call('read',{},x.scope)).body.view.state;assert.equal((await x.f.call('execute',{command:{commandId:crypto.randomUUID(),action:'takeover',expectedVersion:state.version}},x.scope)).body.outcome,'accepted');}
  return x.read(scope,runId);
 };
 assert.equal(await m.reviewCompletedAiReply(x.env,raced,x.scope,id),null);assert.ok(reads>=2);await noSend(x);
});
