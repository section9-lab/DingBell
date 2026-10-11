import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {URL} from 'node:url';
import {checkedReply,replyView} from '../src/modules/conversations/reply-state.ts';
import {controlCommandSchema} from '../src/modules/conversations/control-state.ts';
import {projectReplyEvents} from '../src/modules/conversations/reply-storage.ts';
import {projectControlEvents} from '../src/modules/conversations/control-storage.ts';
import {conversationControlFixture} from './fixtures/conversation-control.ts';
import {aiAnswerFixture} from './fixtures/ai-answer.ts';
import {encryptCredentials} from '../src/modules/stores/credentials.ts';
import {prepareAiReply} from '../src/modules/ai-runs/reply-intent.ts';
import type {ReplySnapshot} from '../src/modules/conversations/reply-types.ts';
import * as v from 'valibot';

const runId='57a9a1f4-f8cc-4340-a6d4-39f3f0856bcc';
function human():ReplySnapshot{return {intent:{schemaVersion:1,id:'legacy',commandId:'legacy',actorUserId:'former-user',actorMemberId:'former-member',body:'  Ответ\r\n正文  ',bodyHash:'a'.repeat(64),platformThreadId:'thread',credentialVersion:1,controlEpoch:2,state:'queued',revision:1,createdAt:100,updatedAt:100,dueAt:200,lastError:null},attempt:null};}
function ai(id=runId):ReplySnapshot{return {...human(),intent:{...human().intent,schemaVersion:2,origin:'ai',runId:id,id:'ai-reply:'+id,commandId:'ai-reply:'+id,actorUserId:null,actorMemberId:null}} as ReplySnapshot;}
function sent(value:ReplySnapshot):ReplySnapshot{return {intent:{...value.intent,state:'sent',revision:3,updatedAt:150,dueAt:null},attempt:{id:value.intent.id+':1',intentId:value.intent.id,state:'sent',startedAt:120,deadlineAt:300,finishedAt:150,httpStatus:200,providerResult:'success',errorCode:null}};}
async function receiptApi(){
 const m=await import('../src/modules/conversations/ai-reply-receipt.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});
 assert.equal(typeof m?.checkedAiSendReceipt,'function','AI delivery needs its own null-actor receipt, never a fabricated merchant');return m!;
}
function receipt(id=runId){return {action:'ai_send_reply',origin:'ai',runId:id,commandId:'ai-reply:'+id,intentId:'ai-reply:'+id,body:'  Ответ\r\n正文  ',expectedVersion:3,actorUserId:null,actorMemberId:null,appliedState:{schemaVersion:2,version:4,controlEpoch:2,sequence:4,lifecycle:'open',reception:'ai',workStatus:'needs_reply',assignedMemberId:null,updatedAt:100}};}
test('human snapshots retain their original shape while AI queue identity stays explicit and employee-free',()=>{
 const legacy=human();assert.deepEqual(checkedReply(legacy),legacy);assert.equal('origin' in checkedReply(legacy).intent,false);assert.equal('runId' in checkedReply(legacy).intent,false);
 const value=ai();assert.deepEqual(checkedReply(value),value);assert.deepEqual(checkedReply(sent(value)),sent(value));
 for(const change of [{schemaVersion:1},{origin:'human'},{origin:undefined},{runId:undefined},{runId:'invalid'},{actorUserId:'owner'},{actorMemberId:'owner-member'},{commandId:'different'},{id:'unrelated',commandId:'unrelated'},{runId:crypto.randomUUID()}])assert.throws(()=>checkedReply({...value,intent:{...value.intent,...change}}),/INVALID_REPLY_STATE/);
 for(const change of [{origin:'ai'},{runId},{actorUserId:null},{actorMemberId:null}])assert.throws(()=>checkedReply({...legacy,intent:{...legacy.intent,...change}}),/INVALID_REPLY_STATE/);
 const view=replyView(value);assert.equal(view.body,value.intent.body);assert.equal('runId' in view,false);assert.equal('actorUserId' in view,false);assert.equal('platformThreadId' in view,false);
 const delivered=sent(value);assert.throws(()=>checkedReply({...delivered,attempt:{...delivered.attempt,id:value.intent.id+':2'}}),/INVALID_REPLY_STATE/);
});
test('AI send receipts strictly identify the original intent without becoming a public employee command',async()=>{
 const m=await receiptApi(),value=receipt();assert.deepEqual(m.checkedAiSendReceipt(value),value);assert.equal(v.is(controlCommandSchema,value),false);
 for(const change of [{origin:'human'},{runId:'invalid'},{intentId:'other'},{commandId:'other'},{actorUserId:'owner'},{actorMemberId:'owner-member'},{expectedVersion:4},{body:' '},{extra:'invented'}])assert.throws(()=>m.checkedAiSendReceipt({...value,...change}));
 for(const change of [{schemaVersion:1},{version:3},{sequence:0},{lifecycle:'resolved'},{reception:'human'},{workStatus:'waiting_customer'},{assignedMemberId:'owner-member'}])assert.throws(()=>m.checkedAiSendReceipt({...value,appliedState:{...value.appliedState,...change}}));
});
async function outboundFixture(){
 const x=await aiAnswerFixture('support-reply-v1');
 try{
  const key=await encryptCredentials(x.f.credentialEnv,{orgId:'org',storeId:'store',platformStoreId:'1',credentialVersion:1},{apiKey:'synthetic-api-key'});
  await x.f.db.prepare("UPDATE store SET outbound_enabled=1,credential_key_version=?,credential_nonce=?,credential_ciphertext=?,capabilities=?,expires_at=? WHERE id='store'")
   .bind(key.keyVersion,key.nonce,key.ciphertext,JSON.stringify([{code:'auth',status:'available'},{code:'reply',status:'available'}]),Date.now()+3600000).run();
  const prepared=await prepareAiReply({...x.env,AI_OUTBOUND_ENABLED:'true',OUTBOUND_ENABLED:'true'},x.read,x.scope,x.run.request.runId,x.input);assert.equal(prepared.status,'prepared');return x;
 }catch(e){await x.f.close();throw e;}
}
test('AI receipt and delivery projections preserve null actors, immutable provenance and monotonic attempts',{timeout:30000},async t=>{
 await receiptApi();const x=await outboundFixture();t.after(x.f.close);const id=x.run.request.runId,queued=ai(id);
 queued.intent.body=x.input.body;queued.intent.controlEpoch=x.run.controlEpoch;queued.intent.bodyHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x.input.body)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
 const delivered=sent(queued);
 await projectReplyEvents(x.f.db,x.scope,[queued,delivered,queued],500);
 assert.deepEqual(await x.f.db.prepare('SELECT schema_version,actor_user_id,actor_member_id,ai_run_id,state,revision,body FROM send_intent').first(),{schema_version:2,actor_user_id:null,actor_member_id:null,ai_run_id:id,state:'sent',revision:3,body:queued.intent.body});
 assert.deepEqual(await x.f.db.prepare('SELECT state,revision,provider_result FROM send_attempt').first(),{state:'sent',revision:3,provider_result:'success'});
 await assert.rejects(projectReplyEvents(x.f.db,x.scope,[{...delivered,intent:{...delivered.intent,revision:4,updatedAt:160,body:'Rebased body'}}],600),/REPLY_AI_INTENT_MISMATCH/);
 for(const change of [{platformThreadId:'other-thread'},{credentialVersion:2},{controlEpoch:x.run.controlEpoch+1}])await assert.rejects(projectReplyEvents(x.f.db,x.scope,[{...queued,intent:{...queued.intent,...change}}],600),/REPLY_AI_INTENT_MISMATCH/);
 const event=receipt(id);event.body=x.input.body;event.appliedState.controlEpoch=x.run.controlEpoch;
 await projectControlEvents(x.f.db,x.scope,[{scope:x.scope,receipt:event} as never],500);
 const saved=await x.f.db.prepare('SELECT action,actor_user_id,actor_member_id,receipt FROM conversation_control_event WHERE command_id=?').bind(event.commandId).first();
 assert.ok(saved);assert.deepEqual({...saved,receipt:JSON.parse(String(saved.receipt))},{action:'ai_send_reply',actor_user_id:null,actor_member_id:null,receipt:event});
 await projectControlEvents(x.f.db,x.scope,[{scope:x.scope,receipt:event} as never],600);
 assert.equal((await x.f.db.prepare('SELECT count(*) n FROM conversation_control_event WHERE command_id=?').bind(event.commandId).first<{n:number}>())?.n,1);
 await assert.rejects(x.f.db.prepare('UPDATE send_intent SET ai_run_id=NULL').run());await assert.rejects(x.f.db.prepare("UPDATE send_intent SET actor_member_id='owner-member'").run());
 assert.deepEqual((await x.f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.deepEqual(x.f.providerRequests,[]);
});
test('AI dispatch context reads the exact tenant channel without borrowing an employee identity',{timeout:30000},async t=>{
 const m=await import('../src/modules/conversations/reply-storage.ts');assert.equal(typeof m.readAiReplyDispatchContext,'function','AI dispatch must read the store independently of merchant membership');
 const f=await conversationControlFixture();t.after(f.close);await f.db.prepare("UPDATE store SET status='verified',outbound_enabled=1,expires_at=?,capabilities=? WHERE id='store'").bind(Date.now()+3600000,JSON.stringify([{code:'auth',status:'available'},{code:'reply',status:'available'}])).run();
 await f.db.prepare("UPDATE user SET email_verified=0 WHERE id IN (SELECT user_id FROM member WHERE organization_id='org')").run();
 assert.equal(await m.readReplyDispatchContext(f.db,f.scope,'owner','owner-member'),null);const value=await m.readAiReplyDispatchContext(f.db,f.scope);assert.ok(value);
 assert.equal(value.store.id,'store');assert.equal(value.outboundEnabled,true);assert.equal(value.replyAvailable,true);assert.equal(value.platformThreadId,'thread');assert.equal(value.platformType,'BUYER_SELLER');
 for(const changed of [{organizationId:'other-org'},{storeId:'foreign'},{conversationId:'second'},{controllerId:'wrong'}])assert.equal(await m.readAiReplyDispatchContext(f.db,{...f.scope,...changed}),null);
 await f.db.prepare("UPDATE store SET expires_at=1,credential_version=2,outbound_enabled=0 WHERE id='store'").run();const closed=await m.readAiReplyDispatchContext(f.db,f.scope);assert.ok(closed);assert.equal(closed.replyAvailable,false);assert.equal(closed.outboundEnabled,false);assert.equal(closed.store.credentialVersion,2);
 await assert.rejects(m.readAiReplyDispatchContext(f.db,{...f.scope,organizationId:''}),/INVALID_REPLY_SCOPE/);assert.deepEqual(f.providerRequests,[]);
});
async function migrationFixture(){
 const folder=new URL('../migrations/',import.meta.url),files=(await readdir(folder)).filter(name=>name.startsWith('0044_')&&name.endsWith('.sql'));
 assert.equal(files.length,1,'A rollback-safe AI sender migration is required');const sql=(await readFile(new URL(files[0]!,folder),'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);
 const f=await conversationControlFixture('0043');
 try{
  // Seed the previous release's columns without invoking the newer projection on its old schema.
  const scope=[f.scope.controllerId,f.scope.organizationId,f.scope.storeId,f.scope.conversationId];
  for(const {intent,attempt} of [human(),sent({...human(),intent:{...human().intent,id:'delivered',commandId:'delivered'}})]){
   await f.db.prepare('INSERT INTO send_intent(controller_id,organization_id,store_id,conversation_id,id,schema_version,command_id,actor_user_id,actor_member_id,body,body_hash,platform_thread_id,credential_version,control_epoch,state,revision,created_at,updated_at,due_at,last_error,projected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(...scope,intent.id,intent.schemaVersion,intent.commandId,intent.actorUserId,intent.actorMemberId,intent.body,intent.bodyHash,intent.platformThreadId,intent.credentialVersion,intent.controlEpoch,intent.state,intent.revision,intent.createdAt,intent.updatedAt,intent.dueAt,intent.lastError,500).run();
   if(attempt)await f.db.prepare('INSERT INTO send_attempt(controller_id,organization_id,store_id,conversation_id,id,intent_id,revision,state,started_at,deadline_at,finished_at,http_status,provider_result,error_code,projected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(...scope,attempt.id,attempt.intentId,intent.revision,attempt.state,attempt.startedAt,attempt.deadlineAt,attempt.finishedAt,attempt.httpStatus,attempt.providerResult,attempt.errorCode,500).run();
  }
  await f.db.prepare("INSERT INTO conversation_control_event(controller_id,organization_id,store_id,conversation_id,sequence,command_id,actor_user_id,actor_member_id,action,receipt,projected_at) VALUES (?,?,?,?,1,'historical','former-user','former-member','send_reply',?,500)").bind(f.scope.controllerId,f.scope.organizationId,f.scope.storeId,f.scope.conversationId,'{\n  "original": "  exact\\r\\n正文  "\n}').run();
  return {...f,sql};
 }catch(e){await f.close();throw e;}
}
const rows=async(db:D1Database,table:string)=>(await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
test('0044 rebuild preserves historical intent, attempts, receipt bytes and unrelated schema',{timeout:30000},async t=>{
 const f=await migrationFixture();t.after(f.close);const tables=['send_intent','send_attempt','conversation_control_event'],before=await Promise.all(tables.map(table=>rows(f.db,table)));
 const unrelated="SELECT type,name,sql,rootpage FROM sqlite_master WHERE tbl_name NOT IN ('send_intent','send_attempt','conversation_control_event') ORDER BY name",schema=(await f.db.prepare(unrelated).all()).results;
 await f.db.batch(f.sql.map(sql=>f.db.prepare(sql)));
 const after=await Promise.all(tables.map(table=>rows(f.db,table)));assert.deepEqual(after[0]!.map(({ai_run_id,...row})=>{assert.equal(ai_run_id,null);return row;}),before[0]);assert.deepEqual(after.slice(1),before.slice(1));assert.deepEqual((await f.db.prepare(unrelated).all()).results,schema);
 assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.equal((await f.db.prepare('PRAGMA foreign_keys').first())?.foreign_keys,1);
 await assert.rejects(f.db.prepare("UPDATE send_intent SET actor_user_id=NULL WHERE id='legacy'").run());await assert.rejects(f.db.prepare("UPDATE send_intent SET schema_version=2 WHERE id='legacy'").run());
 await assert.rejects(f.db.prepare("UPDATE conversation_control_event SET receipt='{}' WHERE command_id='historical'").run(),/CONTROL_EVENT_IMMUTABLE/);
 await assert.rejects(f.db.prepare("UPDATE send_intent SET body='changed' WHERE id='legacy'").run(),/REPLY_PROJECTION_CONFLICT/);
 await assert.rejects(f.db.prepare("UPDATE send_intent SET state='queued',revision=4,updated_at=160,due_at=200 WHERE id='delivered'").run(),/REPLY_PROJECTION_CONFLICT/);
});
test('0044 failed migration atomically restores the original parent, child and trigger schema',{timeout:30000},async t=>{
 const f=await migrationFixture();t.after(f.close);const tables=['send_intent','send_attempt','conversation_control_event'],before=await Promise.all(tables.map(table=>rows(f.db,table))),schema=(await f.db.prepare('SELECT type,name,sql,rootpage FROM sqlite_master ORDER BY name').all()).results;
 await assert.rejects(f.db.batch([...f.sql.map(sql=>f.db.prepare(sql)),f.db.prepare('SELECT * FROM synthetic_missing_ai_sender_table')]),/no such table/);
 assert.deepEqual(await Promise.all(tables.map(table=>rows(f.db,table))),before);assert.deepEqual((await f.db.prepare('SELECT type,name,sql,rootpage FROM sqlite_master ORDER BY name').all()).results,schema);assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
});
