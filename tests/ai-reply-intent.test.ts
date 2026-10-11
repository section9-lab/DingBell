import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {URL} from 'node:url';
import {aiAnswerFixture} from './fixtures/ai-answer.ts';
import {conversationControlFixture} from './fixtures/conversation-control.ts';
import {encryptCredentials} from '../src/modules/stores/credentials.ts';
import {withdrawKnowledge} from '../src/modules/knowledge/storage.ts';
import {knowledgeHash} from '../src/modules/knowledge/content.ts';
import {closeAiExecution,type AiRunReader} from '../src/modules/ai-runs/storage.ts';

async function api(){
 const m=await import('../src/modules/ai-runs/reply-intent.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});
 assert.equal(typeof m?.prepareAiReply,'function','An AI reply needs an immutable, current-authority intent before any dispatch');
 assert.equal(typeof m?.reviewAiReply,'function','The original AI run must be freshly reviewed without inventing a merchant actor');return m!;
}
async function fixture(prompt='support-reply-v1'){
 const x=await aiAnswerFixture(prompt);
 try{
  const key=await encryptCredentials(x.f.credentialEnv,{orgId:'org',storeId:'store',platformStoreId:'1',credentialVersion:1},{apiKey:'synthetic-api-key'});
  await x.f.db.prepare("UPDATE store SET outbound_enabled=1,credential_key_version=?,credential_nonce=?,credential_ciphertext=?,capabilities=?,checked_at=?,expires_at=? WHERE id='store'")
   .bind(key.keyVersion,key.nonce,key.ciphertext,JSON.stringify([{code:'auth',status:'available'},{code:'reply',status:'available'}]),Date.now(),Date.now()+3600000).run();
  return {...x,env:{...x.env,AI_OUTBOUND_ENABLED:'true',OUTBOUND_ENABLED:'true'}};
 }catch(e){await x.f.close();throw e;}
}
function interceptInsert(db:D1Database,write:(statement:D1PreparedStatement)=>Promise<unknown>):D1Database{
 return {batch:db.batch.bind(db),prepare(sql:string){const statement=db.prepare(sql);return sql.trimStart().startsWith('INSERT INTO ai_reply_intent')?{bind(...args:unknown[]){return {run:()=>write(statement.bind(...args))};}}:statement;}} as D1Database;
}
async function noSend(x:Awaited<ReturnType<typeof fixture>>){
 assert.equal((await x.f.db.prepare('SELECT count(*) n FROM send_intent').first<{n:number}>())?.n,0);
 assert.deepEqual(x.f.providerRequests,[]);assert.deepEqual(x.f.providerErrors,[]);
}

test('AI reply preparation is immutable, scoped and idempotent without creating a sender',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);const runId=x.run.request.runId,intentId='ai-reply:'+runId;
 const first=await m.prepareAiReply(x.env,x.read,x.scope,runId,x.input);
 assert.deepEqual(first,{status:'prepared',intentId,canSend:false,sent:false});
 assert.deepEqual(await m.prepareAiReply(x.env,x.read,x.scope,runId,x.input),first);
 assert.equal((await m.prepareAiReply(x.env,x.read,x.scope,runId,{...x.input,body:'Другой ответ.'})).status,'conflict');
 for(const changed of [{organizationId:'other-org'},{storeId:'foreign'},{conversationId:'second'},{controllerId:crypto.randomUUID()}]){
  assert.equal((await m.prepareAiReply(x.env,x.read,{...x.scope,...changed},runId,x.input)).status,'unavailable');
  assert.equal(await m.reviewAiReply(x.env,x.read,{...x.scope,...changed},runId),null);
 }
 const saved=await m.reviewAiReply(x.env,x.read,x.scope,runId);assert.ok(saved);
 assert.equal(saved.id,intentId);assert.equal(saved.runId,runId);assert.equal(saved.origin,'ai');
 assert.equal(saved.actorUserId,null);assert.equal(saved.actorMemberId,null);assert.equal(saved.canSend,false);
 assert.equal(saved.body,x.input.body);assert.equal(saved.bodyHash,await knowledgeHash(x.input.body));assert.deepEqual(saved.citations,x.input.citations);
 assert.equal(saved.platformThreadId,'thread');assert.equal(saved.credentialVersion,1);
 assert.equal(saved.platformStoreId,'1');assert.deepEqual(saved.run,x.run);assert.deepEqual(saved.knowledgeEvidence,x.evidence);
 assert.equal(saved.payloadHash,(await x.f.db.prepare('SELECT payload_hash AS hash FROM ai_execution WHERE id=?').bind(runId).first<{hash:string}>())?.hash);
 assert.equal((await x.f.db.prepare('SELECT count(*) n FROM ai_reply_intent').first<{n:number}>())?.n,1);
 await assert.rejects(x.f.db.prepare("UPDATE ai_reply_intent SET body='replaced'").run());await assert.rejects(x.f.db.prepare('DELETE FROM ai_reply_intent').run());
 await noSend(x);
});
test('concurrent AI preparations preserve one exact body for the original run',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);const runId=x.run.request.runId;
 const inputs=[x.input,{...x.input,body:'Другой ответ.'}],results=await Promise.all(inputs.map(input=>m.prepareAiReply(x.env,x.read,x.scope,runId,input)));
 assert.deepEqual(results.map(r=>r.status).sort(),['conflict','prepared']);
 const saved=await m.reviewAiReply(x.env,x.read,x.scope,runId);assert.ok(saved);assert.equal(saved.body,inputs[results.findIndex(r=>r.status==='prepared')]!.body);
 assert.equal((await x.f.db.prepare('SELECT count(*) n FROM ai_reply_intent').first<{n:number}>())?.n,1);await noSend(x);
});
test('human-review draft versions and model-invented authority cannot prepare AI replies',{timeout:60000},async t=>{
 const m=await api();
 for(const prompt of ['support-v1','support-knowledge-v1','support-answer-v1']){
  const x=await fixture(prompt);try{assert.equal((await m.prepareAiReply(x.env,x.read,x.scope,x.run.request.runId,x.input)).status,'unavailable');await noSend(x);}finally{await x.f.close();}
 }
 const x=await fixture();t.after(x.f.close);
 for(const input of [{...x.input,citations:[]},{...x.input,citations:['a'.repeat(64)]},{...x.input,citations:[...x.input.citations,...x.input.citations]},
  {...x.input,body:''},{...x.input,body:' \r\n'},{...x.input,body:'x'.repeat(1001)},{...x.input,body:'\ud800'},{...x.input,body:'x\u0000'},
  {...x.input,actorUserId:'owner'},{...x.input,actorMemberId:'owner-member'},{...x.input,storeId:'foreign'},{...x.input,platformThreadId:'injected'},{...x.input,credentialVersion:2},{...x.input,canSend:true}]){
  assert.equal((await m.prepareAiReply(x.env,x.read,x.scope,x.run.request.runId,input)).status,'unavailable');
 }
 assert.equal((await x.f.db.prepare('SELECT count(*) n FROM ai_reply_intent').first<{n:number}>())?.n,0);await noSend(x);
});
test('AI preparation and review require all outbound switches and current reply capability',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);const id=x.run.request.runId;
 for(const flag of ['AI_RECEPTION_ENABLED','AI_OUTBOUND_ENABLED','OUTBOUND_ENABLED'])for(const value of [undefined,'false','TRUE']){
  assert.equal((await m.prepareAiReply({...x.env,[flag]:value},x.read,x.scope,id,x.input)).status,'unavailable');assert.equal(await m.reviewAiReply({...x.env,[flag]:value},x.read,x.scope,id),null);
 }
 for(const sql of ["UPDATE store SET outbound_enabled=0 WHERE id='store'","UPDATE store SET expires_at=1 WHERE id='store'","UPDATE store SET capabilities='[]' WHERE id='store'"]){
  await x.f.db.prepare(sql).run();assert.equal((await m.prepareAiReply(x.env,x.read,x.scope,id,x.input)).status,'unavailable');
  await x.f.db.prepare("UPDATE store SET outbound_enabled=1,expires_at=?,capabilities=? WHERE id='store'").bind(Date.now()+3600000,JSON.stringify([{code:'auth',status:'available'},{code:'reply',status:'available'}])).run();
 }
 assert.equal((await m.prepareAiReply(x.env,x.read,x.scope,id,x.input)).status,'prepared');
 await x.f.db.prepare("UPDATE store SET capabilities='[]' WHERE id='store'").run();assert.equal(await m.reviewAiReply(x.env,x.read,x.scope,id),null);await noSend(x);
});
test('budget, policy, new input, takeover and source withdrawal revoke AI reply preparation',{timeout:60000},async()=>{
 const m=await api();
 const changes:[string,(x:Awaited<ReturnType<typeof fixture>>)=>Promise<unknown>][]=[
  ['budget',x=>x.f.db.prepare('UPDATE ai_budget SET enabled=0').run()],
  ['policy',x=>x.f.db.prepare('UPDATE reply_policy SET enabled=0').run()],
  ['new input',x=>x.f.db.prepare("UPDATE conversation SET message_sequence=message_sequence+1 WHERE id='conv'").run()],
  ['source withdrawal',x=>withdrawKnowledge(x.f.db,x.actor,x.documentId,2)],
  ['takeover',async x=>{const state=(await x.f.call('read',{},x.scope)).body.view.state;assert.equal((await x.f.call('execute',{command:{commandId:crypto.randomUUID(),action:'takeover',expectedVersion:state.version}},x.scope)).body.outcome,'accepted');}],
 ];
 for(const [label,change]of changes){const x=await fixture();try{await change(x);assert.equal((await m.prepareAiReply(x.env,x.read,x.scope,x.run.request.runId,x.input)).status,'unavailable',label);assert.equal(await m.reviewAiReply(x.env,x.read,x.scope,x.run.request.runId),null,label);await noSend(x);}finally{await x.f.close();}}
});
test('a reserved AI run can prepare its reply when the budget has no spare funds or admission slots',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);const runId=x.run.request.runId;
 await x.f.db.prepare('UPDATE ai_budget SET spent_micros=limit_micros-reserved_micros,admitted_runs=max_runs').run();
 const budget=await x.f.db.prepare('SELECT limit_micros AS limitMicros,spent_micros AS spentMicros,reserved_micros AS reservedMicros,admitted_runs AS admittedRuns,max_runs AS maxRuns FROM ai_budget').first<{limitMicros:number;spentMicros:number;reservedMicros:number;admittedRuns:number;maxRuns:number}>();assert.ok(budget);
 assert.equal(budget.limitMicros,budget.spentMicros+budget.reservedMicros);assert.equal(budget.admittedRuns,budget.maxRuns);assert.ok(budget.reservedMicros>0);
 assert.equal((await m.prepareAiReply(x.env,x.read,x.scope,runId,x.input)).status,'prepared');assert.ok(await m.reviewAiReply(x.env,x.read,x.scope,runId));
 assert.deepEqual(await x.f.db.prepare('SELECT limit_micros AS limitMicros,spent_micros AS spentMicros,reserved_micros AS reservedMicros,admitted_runs AS admittedRuns,max_runs AS maxRuns FROM ai_budget').first(),budget);await noSend(x);
});
test('closed original AI executions cannot prepare or review a live reply intent',{timeout:30000},async()=>{
 const m=await api();
 for(const prepared of [false,true]){const x=await fixture();try{
  const runId=x.run.request.runId;if(prepared)assert.equal((await m.prepareAiReply(x.env,x.read,x.scope,runId,x.input)).status,'prepared');
  await closeAiExecution(x.f.db,x.scope,runId,{kind:'unstarted_closed',evidenceId:crypto.randomUUID(),instanceId:'ai-support:'+runId,executionClosed:true,providerPermits:0,verifiedAt:Date.now()});
  assert.equal((await m.prepareAiReply(x.env,x.read,x.scope,runId,x.input)).status,'unavailable');assert.equal(await m.reviewAiReply(x.env,x.read,x.scope,runId),null);
  assert.equal((await x.f.db.prepare('SELECT count(*) n FROM ai_reply_intent').first<{n:number}>())?.n,prepared?1:0);await noSend(x);
 }finally{await x.f.close();}}
});
test('the original AI run deadline revokes prepared and newly requested reply authority',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);const runId=x.run.request.runId;
 assert.equal((await m.prepareAiReply(x.env,x.read,x.scope,runId,x.input)).status,'prepared');
 const clock=t.mock.method(Date,'now',()=>x.run.deadlineAt);
 try{assert.equal(await m.reviewAiReply(x.env,x.read,x.scope,runId),null);assert.equal((await m.prepareAiReply(x.env,x.read,x.scope,runId,x.input)).status,'unavailable');await noSend(x);}finally{clock.mock.restore();}
});
test('the D1 commit guards knowledge, budget and new input races and saved intent review remains current',{timeout:60000},async()=>{
 const m=await api();
 for(const change of [async(x:Awaited<ReturnType<typeof fixture>>)=>withdrawKnowledge(x.f.db,x.actor,x.documentId,2),async(x:Awaited<ReturnType<typeof fixture>>)=>x.f.db.prepare('UPDATE ai_budget SET enabled=0').run(),async(x:Awaited<ReturnType<typeof fixture>>)=>x.f.db.prepare("UPDATE conversation SET message_sequence=message_sequence+1 WHERE id='conv'").run()]){
  const x=await fixture();try{
   const db=interceptInsert(x.f.db,async statement=>{await change(x);return statement.run();});
   assert.equal((await m.prepareAiReply({...x.env,DB:db},x.read,x.scope,x.run.request.runId,x.input)).status,'unavailable');
   assert.equal((await x.f.db.prepare('SELECT count(*) n FROM ai_reply_intent').first<{n:number}>())?.n,0);await noSend(x);
  }finally{await x.f.close();}
 }
 const x=await fixture();try{
  const db=interceptInsert(x.f.db,async statement=>{const result=await statement.run();assert.ok(await withdrawKnowledge(x.f.db,x.actor,x.documentId,2));return result;});
  assert.equal((await m.prepareAiReply({...x.env,DB:db},x.read,x.scope,x.run.request.runId,x.input)).status,'unavailable');
  assert.equal((await x.f.db.prepare('SELECT count(*) n FROM ai_reply_intent').first<{n:number}>())?.n,1);assert.equal(await m.reviewAiReply(x.env,x.read,x.scope,x.run.request.runId),null);await noSend(x);
 }finally{await x.f.close();}
});
test('lost AI intent commit response stays uncertain and recovers the same identity without duplication',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);const runId=x.run.request.runId;
 const db=interceptInsert(x.f.db,async statement=>{await statement.run();throw new Error('synthetic lost AI intent commit response');});
 const first=await m.prepareAiReply({...x.env,DB:db},x.read,x.scope,runId,x.input);assert.equal(first.status,'unconfirmed');assert.equal(first.canSend,false);assert.equal(first.sent,false);
 assert.deepEqual(await m.prepareAiReply(x.env,x.read,x.scope,runId,x.input),{status:'prepared',intentId:'ai-reply:'+runId,canSend:false,sent:false});
 assert.equal((await x.f.db.prepare('SELECT count(*) n FROM ai_reply_intent').first<{n:number}>())?.n,1);await noSend(x);
});
test('the D1 commit rejects credential, thread or capability changes after preflight',{timeout:60000},async()=>{
 const m=await api();
 for(const sql of ["UPDATE store SET credential_version=2 WHERE id='store'","UPDATE conversation SET platform_thread_id='different-thread' WHERE id='conv'","UPDATE store SET capabilities='[]' WHERE id='store'"]){
  const x=await fixture();try{
   const db=interceptInsert(x.f.db,async statement=>{await x.f.db.prepare(sql).run();return statement.run();});
   assert.equal((await m.prepareAiReply({...x.env,DB:db},x.read,x.scope,x.run.request.runId,x.input)).status,'unavailable');
   assert.equal((await x.f.db.prepare('SELECT count(*) n FROM ai_reply_intent').first<{n:number}>())?.n,0);assert.equal(await m.reviewAiReply(x.env,x.read,x.scope,x.run.request.runId),null);await noSend(x);
  }finally{await x.f.close();}
 }
});
test('takeover immediately after an AI intent commit preserves history while revoking the result and review',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);const runId=x.run.request.runId;
 const db=interceptInsert(x.f.db,async statement=>{
  const result=await statement.run(),state=(await x.f.call('read',{},x.scope)).body.view.state;
  assert.equal((await x.f.call('execute',{command:{commandId:crypto.randomUUID(),action:'takeover',expectedVersion:state.version}},x.scope)).body.outcome,'accepted');return result;
 });
 assert.equal((await m.prepareAiReply({...x.env,DB:db},x.read,x.scope,runId,x.input)).status,'unavailable');
 assert.equal((await x.f.db.prepare('SELECT count(*) n FROM ai_reply_intent').first<{n:number}>())?.n,1);assert.equal(await m.reviewAiReply(x.env,x.read,x.scope,runId),null);await noSend(x);
});
test('saved AI reply authority cannot follow credential rotation, a changed thread or a replaced run',{timeout:60000},async()=>{
 const m=await api();
 for(const sql of ["UPDATE store SET credential_version=2 WHERE id='store'","UPDATE conversation SET platform_thread_id='different-thread' WHERE id='conv'","UPDATE store SET platform_store_id='2' WHERE id='store'"]){
  const x=await fixture();try{assert.equal((await m.prepareAiReply(x.env,x.read,x.scope,x.run.request.runId,x.input)).status,'prepared');await x.f.db.prepare(sql).run();assert.equal(await m.reviewAiReply(x.env,x.read,x.scope,x.run.request.runId),null);assert.equal((await m.prepareAiReply(x.env,x.read,x.scope,x.run.request.runId,x.input)).status,'unavailable');await noSend(x);}finally{await x.f.close();}
 }
 const x=await fixture();try{
  assert.equal((await m.prepareAiReply(x.env,x.read,x.scope,x.run.request.runId,x.input)).status,'prepared');
  const read:AiRunReader=async()=>null;assert.equal(await m.reviewAiReply(x.env,read,x.scope,x.run.request.runId),null);await noSend(x);
 }finally{await x.f.close();}
});
test('0043 rolls back a partial migration and preserves existing rows and foreign keys',{timeout:30000},async t=>{
 const f=await conversationControlFixture('0042');t.after(f.close);
 const tables=(await f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'_cf_METADATA' ORDER BY name").all<{name:string}>()).results.map(r=>r.name);
 const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await f.db.prepare(`SELECT * FROM "${table.replaceAll('"','""')}"`).all()).results.map(row=>JSON.stringify(row)).sort()]))),before=await snapshot();
 const sql=(await readFile(new URL('../migrations/0043_ai_reply_intent.sql',import.meta.url),'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);
 await assert.rejects(f.db.batch([...sql.map(s=>f.db.prepare(s)),f.db.prepare('SELECT * FROM synthetic_missing_migration_table')]));
 assert.equal(await f.db.prepare("SELECT name FROM sqlite_master WHERE name='ai_reply_intent'").first(),null);assert.deepEqual(await snapshot(),before);
 await f.migrateAfter('0042');assert.deepEqual(await snapshot(),before);assert.equal((await f.db.prepare('SELECT count(*) n FROM ai_reply_intent').first<{n:number}>())?.n,0);
 assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
});
