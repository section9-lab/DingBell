import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { projectReplyEvents,readReplyDispatchContext } from '../src/modules/conversations/reply-storage.ts';
import { projectControlEvents } from '../src/modules/conversations/control-storage.ts';
import type { ControlEvent,ControlScope } from '../src/modules/conversations/control-types.ts';
import type { HumanReplyIntent,ReplySnapshot } from '../src/modules/conversations/reply-types.ts';
const scope:ControlScope={organizationId:'org',storeId:'store',conversationId:'conv',controllerId:'controller'};
async function fixture(){
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("reply fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  try{
    const db=await mf.getD1Database('DB') as unknown as D1Database,folder=new URL('../migrations/',import.meta.url);
    for(const file of readdirSync(folder).filter(name=>name.endsWith('.sql')).sort())for(const sql of readFileSync(new URL(file,folder),'utf8').split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean))await db.prepare(sql).run();
    await db.batch([
      db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES ('org','Org','org',1),('other','Other','other',1)"),
      db.prepare("INSERT INTO user(id,name,email,email_verified) VALUES ('owner','Owner','owner@example.invalid',1),('staff','Staff','staff@example.invalid',1),('unverified','Unverified','unverified@example.invalid',0)"),
      db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('owner-member','org','owner','owner',1),('staff-member','org','staff','member',1),('foreign-member','other','owner','owner',1),('unverified-member','org','unverified','admin',1)"),
      db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,capabilities,expires_at,credential_key_version,credential_nonce,credential_ciphertext,created_at,updated_at) VALUES ('store','org','Store','1','verified',?,?, 'synthetic','nonce','cipher',1,1),('foreign','other','Foreign','2','verified',NULL,NULL,NULL,NULL,NULL,1,1)").bind(JSON.stringify([{code:'auth',status:'available'},{code:'reply',status:'available'}]),Date.now()+120_000),
      db.prepare("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES ('org','store','staff-member',1)"),
      db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES ('conv','org','store','18446744073709551615','BUYER_SELLER','Opened',1,1),('conv-2','org','store','chat-2','BUYER_SELLER','Opened',1,1)"),
      db.prepare("INSERT INTO conversation_control(conversation_id,organization_id,store_id,controller_id,schema_version,work_status,repair_due_at) VALUES ('conv','org','store','controller',2,'needs_reply',1),('conv-2','org','store','controller-2',2,'needs_reply',1)"),
    ]);
    return {db,close:()=>mf.dispose()};
  }catch(error){await mf.dispose().catch(()=>{});throw error;}
}
function snapshot(revision=1,state:ReplySnapshot['intent']['state']='queued'):ReplySnapshot & {intent:HumanReplyIntent}{
  return {intent:{schemaVersion:1,id:'command',commandId:'command',actorUserId:'staff',actorMemberId:'staff-member',body:'  Ответ\r\n请确认  ',bodyHash:'a'.repeat(64),platformThreadId:'18446744073709551615',credentialVersion:1,controlEpoch:2,state,revision,createdAt:100,updatedAt:110+revision*10,dueAt:state==='queued'||state==='sending'?210:null,lastError:state==='unknown'?'TRANSPORT_UNKNOWN':null},attempt:state==='queued'||state==='skipped'?null:{id:'command:1',intentId:'command',state:state as 'sending'|'sent'|'failed'|'unknown',startedAt:110,deadlineAt:210,finishedAt:state==='sending'?null:120,httpStatus:state==='sent'?200:null,providerResult:state==='sent'?'success':null,errorCode:state==='unknown'?'TRANSPORT_UNKNOWN':null}};
}

test('reply preflight uses current exact original membership without a browser session and returns the default closed gate',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const access=await readReplyDispatchContext(f.db,scope,'staff','staff-member');assert.ok(access);
    assert.equal(access.outboundEnabled,false);assert.equal(access.replyAvailable,true);assert.equal(access.platformThreadId,'18446744073709551615');assert.equal(access.store.credentialVersion,1);assert.equal(access.store.credentialCiphertext,'cipher');
    assert.ok(await readReplyDispatchContext(f.db,scope,'owner','owner-member'));
    assert.equal(await readReplyDispatchContext(f.db,scope,'unverified','unverified-member'),null);
    assert.equal(await readReplyDispatchContext(f.db,scope,'staff','owner-member'),null);
    for(const changed of [{organizationId:'other'},{storeId:'foreign'},{conversationId:'conv-2'},{controllerId:'controller-2'}])assert.equal(await readReplyDispatchContext(f.db,{...scope,...changed},'owner','owner-member'),null);
    await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
    assert.equal(await readReplyDispatchContext(f.db,scope,'staff','staff-member'),null);
    assert.ok(await readReplyDispatchContext(f.db,scope,'owner','owner-member'));
    await f.db.prepare("DELETE FROM member WHERE id='staff-member'").run();
    await f.db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('staff-new','org','staff','admin',1)").run();
    assert.equal(await readReplyDispatchContext(f.db,scope,'staff','staff-member'),null);
    assert.ok(await readReplyDispatchContext(f.db,scope,'staff','staff-new'));
  }finally{await f.close();}
});
test('reply preflight reports fresh capability and store gates from the final SQL snapshot',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await f.db.prepare("UPDATE store SET outbound_enabled=1,status='paused',credential_version=2,expires_at=1 WHERE id='store'").run();
    const paused=await readReplyDispatchContext(f.db,scope,'staff','staff-member');assert.ok(paused);
    assert.equal(paused.outboundEnabled,true);assert.equal(paused.store.status,'paused');assert.equal(paused.store.credentialVersion,2);assert.equal(paused.replyAvailable,false);
    await f.db.prepare("UPDATE store SET expires_at=?,capabilities=? WHERE id='store'").bind(Date.now()+120_000,JSON.stringify([{code:'reply',status:'available'}])).run();
    assert.equal((await readReplyDispatchContext(f.db,scope,'staff','staff-member'))?.replyAvailable,false);
    await f.db.prepare("UPDATE user SET email_verified=0 WHERE id='staff'").run();
    assert.equal(await readReplyDispatchContext(f.db,scope,'staff','staff-member'),null);
    await assert.rejects(readReplyDispatchContext(f.db,scope,'','staff-member'),/INVALID_REPLY/);
  }finally{await f.close();}
});
test('reply projections are controller scoped, atomic, monotonic and replayable after the original actor leaves',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const queued=snapshot(),sending=snapshot(2,'sending'),sent=snapshot(3,'sent');
    await projectReplyEvents(f.db,scope,[queued,sending,sent],1000);
    await f.db.prepare("DELETE FROM member WHERE id='staff-member'").run();
    await projectReplyEvents(f.db,scope,[queued,sending,sent],1001);
    assert.deepEqual(await f.db.prepare('SELECT state,revision,body FROM send_intent').first(),{state:'sent',revision:3,body:queued.intent.body});
    assert.deepEqual(await f.db.prepare('SELECT state,revision,provider_result FROM send_attempt').first(),{state:'sent',revision:3,provider_result:'success'});
    await projectReplyEvents(f.db,{...scope,conversationId:'conv-2',controllerId:'controller-2'},[queued],1002);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM send_intent').first('n'),2);
    await assert.rejects(projectReplyEvents(f.db,{...scope,organizationId:'other'},[queued],1003),/REPLY_SCOPE_MISMATCH|FOREIGN KEY/);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM send_intent').first('n'),2);
  }finally{await f.close();}
});
test('same-revision reply conflicts and immutable intent changes roll back the entire projection batch',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const queued=snapshot();await projectReplyEvents(f.db,scope,[queued],1000);
    const changed={...snapshot(2,'sending'),intent:{...snapshot(2,'sending').intent,updatedAt:201}};
    await assert.rejects(projectReplyEvents(f.db,scope,[snapshot(2,'sending'),changed],1001),/REPLY_PROJECTION_CONFLICT/);
    assert.equal(await f.db.prepare('SELECT revision FROM send_intent').first('revision'),1);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM send_attempt').first('n'),0);
    for(const mutation of [{body:'changed'},{bodyHash:'b'.repeat(64)},{actorMemberId:'other'},{credentialVersion:2},{platformThreadId:'changed'},{createdAt:99},{controlEpoch:3}])await assert.rejects(projectReplyEvents(f.db,scope,[{...snapshot(2,'sending'),intent:{...snapshot(2,'sending').intent,...mutation}}],1002),/REPLY_PROJECTION_CONFLICT/);
    await projectReplyEvents(f.db,scope,[snapshot(2,'sending')],1003);
    const unknown=snapshot(3,'unknown');unknown.attempt!.startedAt=111;
    await assert.rejects(projectReplyEvents(f.db,scope,[unknown],1004),/REPLY_PROJECTION_CONFLICT/);
    assert.equal(await f.db.prepare('SELECT revision FROM send_intent').first('revision'),2);
  }finally{await f.close();}
});
test('reply projection validation rejects malformed snapshots before writes and protects one-attempt unknown outcomes',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const values=[{...snapshot(),intent:{...snapshot().intent,body:'\u0001'}},{...snapshot(),intent:{...snapshot().intent,id:'other'}},
      {...snapshot(),intent:{...snapshot().intent,bodyHash:'x'}},{...snapshot(),intent:{...snapshot().intent,revision:0}},
      {...snapshot(2,'sending'),attempt:{...snapshot(2,'sending').attempt!,id:'command:2'}},{...snapshot(2,'sent'),attempt:null}];
    for(const value of values)await assert.rejects(projectReplyEvents(f.db,scope,[snapshot(),value],1000),/INVALID_REPLY/);
    await assert.rejects(projectReplyEvents(f.db,scope,Array.from({length:21},()=>snapshot()),1000),/INVALID_REPLY/);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM send_intent').first('n'),0);
    await projectReplyEvents(f.db,scope,[snapshot(3,'unknown')],1001);
    await projectReplyEvents(f.db,scope,[snapshot(2,'sending')],1002);
    assert.equal(await f.db.prepare('SELECT state FROM send_intent').first('state'),'unknown');
    assert.equal(await f.db.prepare('SELECT state FROM send_attempt').first('state'),'unknown');
  }finally{await f.close();}
});
test('send reply control receipts preserve exact body and existing canonical receipts while rejecting extra legacy fields',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const old:ControlEvent={scope,receipt:{commandId:'claim',expectedVersion:0,action:'claim',actorUserId:'staff',actorMemberId:'staff-member',appliedState:{schemaVersion:1,version:1,controlEpoch:1,sequence:1,lifecycle:'open',reception:'human',assignedMemberId:'staff-member',updatedAt:100}}};
    await projectControlEvents(f.db,scope,[old],1000);
    const raw=await f.db.prepare("SELECT receipt FROM conversation_control_event WHERE command_id='claim'").first('receipt');
    const reply={scope,receipt:{commandId:'command',expectedVersion:1,action:'send_reply',body:snapshot().intent.body,intentId:'command',actorUserId:'staff',actorMemberId:'staff-member',appliedState:{schemaVersion:2,version:2,controlEpoch:1,sequence:2,lifecycle:'open',reception:'human',assignedMemberId:'staff-member',workStatus:'needs_reply',updatedAt:200}}} as ControlEvent;
    await projectControlEvents(f.db,scope,[reply,old,reply],1001);
    assert.equal(await f.db.prepare("SELECT receipt FROM conversation_control_event WHERE command_id='claim'").first('receipt'),raw);
    const body=JSON.parse((await f.db.prepare("SELECT receipt FROM conversation_control_event WHERE command_id='command'").first<string>('receipt'))!);assert.equal(body.intentId,'command');assert.equal(body.body,snapshot().intent.body);
    for(const receipt of [{...old.receipt,intentId:'claim'},{...reply.receipt,intentId:'wrong'},{...reply.receipt,authorName:'wrong'},{...reply.receipt,appliedState:old.receipt.appliedState}])await assert.rejects(projectControlEvents(f.db,scope,[{scope,receipt:receipt as ControlEvent['receipt']}],1002),/INVALID_CONTROL_EVENT/);
  }finally{await f.close();}
});

test('reply preflight performs one final authorization query, so immediate revocation and database failure cannot become permission',{timeout:30_000},async()=>{
  const f=await fixture();try{
    let injected=false;
    const revoked={prepare(sql:string){const statement=f.db.prepare(sql);return {bind(...values:unknown[]){statement.bind(...values);return {async first(){
      if(!injected){injected=true;await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();}
      return statement.bind(...values).first();
    }};}};}} as D1Database;
    assert.equal(await readReplyDispatchContext(revoked,scope,'staff','staff-member'),null);assert.equal(injected,true);
    const failure=new Error('synthetic database failure');
    await assert.rejects(readReplyDispatchContext({prepare(){throw failure;}} as unknown as D1Database,scope,'owner','owner-member'),error=>error===failure);
  }finally{await f.close();}
});
test('reply projection SQL guards preserve scoped immutable facts and terminal unknown state even against direct stale writes',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await projectReplyEvents(f.db,scope,[snapshot(3,'unknown')],1000);
    await assert.rejects(f.db.prepare("UPDATE send_intent SET body='changed',revision=4").run(),/REPLY_PROJECTION_CONFLICT/);
    await assert.rejects(f.db.prepare("UPDATE send_intent SET state='sending',revision=4").run(),/REPLY_PROJECTION_CONFLICT/);
    await assert.rejects(f.db.prepare("UPDATE send_attempt SET state='sending',revision=4").run(),/REPLY_PROJECTION_CONFLICT/);
    await assert.rejects(f.db.prepare('UPDATE send_attempt SET revision=2').run(),/REPLY_PROJECTION_CONFLICT/);
    await assert.rejects(projectReplyEvents(f.db,scope,[snapshot(4,'sending')],1001),/REPLY_PROJECTION_CONFLICT/);
    assert.equal(await f.db.prepare('SELECT state FROM send_intent').first('state'),'unknown');
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM send_attempt').first('n'),1);
    await f.db.prepare("DELETE FROM conversation WHERE id='conv'").run();
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM send_attempt').first('n'),0);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM send_intent').first('n'),0);
    assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  }finally{await f.close();}
});
