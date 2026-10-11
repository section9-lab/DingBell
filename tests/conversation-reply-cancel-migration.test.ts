import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';

async function fixture(){
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("cancel migration fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  try{
    const db=await mf.getD1Database('DB') as unknown as D1Database,folder=new URL('../migrations/',import.meta.url);
    const files=readdirSync(folder).filter(name=>name.endsWith('.sql')).sort();
    const statements=(name:string)=>readFileSync(new URL(name,folder),'utf8').split('--> statement-breakpoint').map(sql=>sql.trim()).filter(Boolean);
    for(const name of files.filter(name=>name<'0019'))await db.batch(statements(name).map(sql=>db.prepare(sql)));
    await db.batch([
      db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES ('org','Org','org',1)"),
      db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES ('store','org','Store','1','paused',1,1)"),
      db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES ('conv','org','store','thread','BUYER_SELLER','Opened',1,1)"),
      db.prepare("INSERT INTO conversation_control(conversation_id,organization_id,store_id,controller_id,schema_version,work_status,repair_due_at) VALUES ('conv','org','store','controller',2,'needs_reply',1)"),
      db.prepare("INSERT INTO conversation_control_event(controller_id,organization_id,store_id,conversation_id,sequence,command_id,actor_user_id,actor_member_id,action,receipt,projected_at) VALUES ('controller','org','store','conv',1,'legacy','former-user','former-member','send_reply',?,1)").bind('{\n  "original": "  unchanged\\r\\n正文  "\n}'),
    ]);
    for(const state of ['queued','sending','sent','failed','unknown','skipped']){
      await db.prepare("INSERT INTO send_intent(controller_id,organization_id,store_id,conversation_id,id,schema_version,command_id,actor_user_id,actor_member_id,body,body_hash,platform_thread_id,credential_version,control_epoch,state,revision,created_at,updated_at,due_at,last_error,projected_at) VALUES ('controller','org','store','conv',?,1,?,'former-user','former-member',? ,?,'thread',1,0,?,3,10,30,?,?,40)")
        .bind(state,state,'  Ответ\r\n'+state,'a'.repeat(64),state,['queued','sending'].includes(state)?100:null,['failed','unknown','skipped'].includes(state)?'SYNTHETIC':null).run();
      if(['sending','sent','failed','unknown'].includes(state))await db.prepare("INSERT INTO send_attempt(controller_id,organization_id,store_id,conversation_id,id,intent_id,revision,state,started_at,deadline_at,finished_at,http_status,provider_result,error_code,projected_at) VALUES ('controller','org','store','conv',?,?,3,?,20,100,?,?,?,?,40)")
        .bind(state+':1',state,state,state==='sending'?null:30,state==='sent'?200:state==='failed'?403:null,state==='sent'?'success':null,['failed','unknown'].includes(state)?'SYNTHETIC':null).run();
    }
    return {db,sql:files.filter(name=>name.startsWith('0019_')).flatMap(statements),close:()=>mf.dispose()};
  }catch(error){await mf.dispose().catch(()=>{});throw error;}
}
const rows=async(db:D1Database,table:string)=>(await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
const unrelated=async(db:D1Database)=>(await db.prepare("SELECT type,name,sql,rootpage FROM sqlite_master WHERE tbl_name NOT IN ('send_intent','send_attempt','conversation_control_event') ORDER BY name").all()).results;

test('0019 preserves historical attempts, receipt bytes and unrelated tables while adding cancellation',{timeout:30_000},async()=>{
  const f=await fixture();try{
    assert.ok(f.sql.length,'cancellation migration is required');
    const before=await Promise.all(['send_intent','send_attempt','conversation_control_event'].map(table=>rows(f.db,table))),schema=await unrelated(f.db);
    await f.db.batch(f.sql.map(sql=>f.db.prepare(sql)));
    assert.deepEqual(await Promise.all(['send_intent','send_attempt','conversation_control_event'].map(table=>rows(f.db,table))),before);
    assert.deepEqual(await unrelated(f.db),schema);assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
    assert.equal((await f.db.prepare('PRAGMA foreign_keys').first())?.foreign_keys,1);
    await f.db.prepare("INSERT INTO conversation_control_event(controller_id,organization_id,store_id,conversation_id,sequence,command_id,actor_user_id,actor_member_id,action,receipt,projected_at) VALUES ('controller','org','store','conv',2,'cancel','user','member','cancel_reply','{}',50)").run();
    await assert.rejects(f.db.prepare("UPDATE conversation_control_event SET receipt='{}' WHERE command_id='legacy'").run(),/CONTROL_EVENT_IMMUTABLE/);
    await f.db.prepare("UPDATE send_intent SET state='canceled',revision=4,updated_at=40,due_at=NULL WHERE id='queued'").run();
    await assert.rejects(f.db.prepare("UPDATE send_intent SET state='queued',revision=5,updated_at=50,due_at=100 WHERE id='queued'").run(),/REPLY_PROJECTION_CONFLICT/);
    await assert.rejects(f.db.prepare("UPDATE send_intent SET state='canceled',revision=4,updated_at=40,due_at=NULL WHERE id='sending'").run(),/REPLY_CANCELLATION_CONFLICT/);
    await assert.rejects(f.db.prepare("INSERT INTO send_attempt SELECT controller_id,organization_id,store_id,conversation_id,'queued:1','queued',4,'sending',20,100,NULL,NULL,NULL,NULL,40 FROM send_attempt WHERE intent_id='sending'").run(),/REPLY_CANCELLATION_CONFLICT/);
    await assert.rejects(f.db.prepare("UPDATE send_intent SET revision=5,due_at=100 WHERE id='queued'").run(),/CHECK constraint failed/);
  }finally{await f.close();}
});

test('0019 failed migration rolls back parent and child rebuilds without losing attempts',{timeout:30_000},async()=>{
  const f=await fixture();try{
    assert.ok(f.sql.length,'cancellation migration is required');
    const tables=['send_intent','send_attempt','conversation_control_event'],before=await Promise.all(tables.map(table=>rows(f.db,table)));
    const schema=(await f.db.prepare('SELECT type,name,sql,rootpage FROM sqlite_master ORDER BY name').all()).results;
    await assert.rejects(f.db.batch([...f.sql.map(sql=>f.db.prepare(sql)),f.db.prepare('SELECT * FROM synthetic_missing_cancel_table')]),/no such table/);
    assert.deepEqual(await Promise.all(tables.map(table=>rows(f.db,table))),before);
    assert.deepEqual((await f.db.prepare('SELECT type,name,sql,rootpage FROM sqlite_master ORDER BY name').all()).results,schema);
    assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  }finally{await f.close();}
});
