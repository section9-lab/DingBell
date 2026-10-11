import assert from 'node:assert/strict';
import {test} from 'node:test';
import {conversationControlFixture} from './fixtures/conversation-control.ts';
test('0032 preserves authority, byte-exact audits and delivery history with foreign keys enabled', {timeout:30000},async t=>{
 const f=await conversationControlFixture('0031');t.after(f.close);
 const first=await f.call('execute',{command:{commandId:'prior-claim',expectedVersion:0,action:'claim'}});assert.equal(first.body.outcome,'accepted');
 const scope=f.scope;
 for(const state of ['queued','sending','sent','failed','unknown','skipped','canceled']){
  await f.db.prepare("INSERT INTO send_intent(controller_id,organization_id,store_id,conversation_id,id,schema_version,command_id,actor_user_id,actor_member_id,body,body_hash,platform_thread_id,credential_version,control_epoch,state,revision,created_at,updated_at,due_at,last_error,projected_at) VALUES (?,'org','store','conv',?,1,?,'former-user','former-member',?,?,'thread',1,0,?,3,10,30,?,?,40)")
   .bind(scope.controllerId,state,state,'  Ответ\r\n'+state,'a'.repeat(64),state,['queued','sending'].includes(state)?100:null,['failed','unknown','skipped'].includes(state)?'SYNTHETIC':null).run();
  if(['sending','sent','failed','unknown'].includes(state))await f.db.prepare("INSERT INTO send_attempt(controller_id,organization_id,store_id,conversation_id,id,intent_id,revision,state,started_at,deadline_at,finished_at,http_status,provider_result,error_code,projected_at) VALUES (?,'org','store','conv',?,?,3,?,20,100,?,?,?,?,40)")
   .bind(scope.controllerId,state+':1',state,state,state==='sending'?null:30,state==='sent'?200:null,state==='sent'?'success':null,state==='failed'?'SYNTHETIC':null).run();
 }
 const tables=['conversation_control','conversation_control_event','send_intent','send_attempt'],before=[];
 for(const table of tables)before.push((await f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results);
 await f.migrateAfter('0031');
 for(const [i,table]of tables.entries())assert.deepEqual((await f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results,table==='send_intent'?before[i].map(row=>({...row,ai_run_id:null})):before[i],table);
 assert.equal((await f.db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
 await assert.rejects(()=>f.db.prepare("UPDATE conversation_control_event SET receipt='{}'").run(),/IMMUTABLE/);
 await assert.rejects(()=>f.db.prepare("INSERT INTO conversation_control_event(controller_id,organization_id,store_id,conversation_id,sequence,command_id,action,receipt,projected_at) VALUES (?,'org','store','conv',2,'invalid-human','claim','{}',1)").bind(scope.controllerId).run());
 await f.db.prepare("INSERT INTO conversation_control_event(controller_id,organization_id,store_id,conversation_id,sequence,command_id,action,receipt,projected_at) VALUES (?,'org','store','conv',2,'system-run','ai_start','{}',1)").bind(scope.controllerId).run();
 await f.db.prepare("UPDATE conversation_control SET reception='ai',assigned_member_id=NULL WHERE controller_id=?").bind(scope.controllerId).run();
 await assert.rejects(()=>f.db.prepare("UPDATE conversation_control SET lifecycle='resolved',work_status=NULL WHERE controller_id=?").bind(scope.controllerId).run());
});
