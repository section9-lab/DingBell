import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';

async function fixture(){
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("note migration fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  try{
    const db=await mf.getD1Database('DB') as unknown as D1Database,folder=new URL('../migrations/',import.meta.url);
    const files=readdirSync(folder).filter(name=>name.endsWith('.sql')).sort();
    const statements=(name:string)=>readFileSync(new URL(name,folder),'utf8').split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean);
    for(const name of files.filter(name=>name<'0014'))for(const sql of statements(name))await db.prepare(sql).run();
    await db.batch([
      db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES ('org','Org','org',1)"),
      db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES ('store','org','Store','1','paused',1,1)"),
      db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES ('conv','org','store','chat','BUYER_SELLER','Opened',1,1)"),
      db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES ('msg','org','store','conv','18446744073709551615','Customer','inbound','[\"Здравствуйте\"]',0,0,3,4,'backfill')"),
      db.prepare("INSERT INTO conversation_control(conversation_id,organization_id,store_id,controller_id,schema_version,version,control_epoch,sequence,lifecycle,reception,assigned_member_id,updated_at,work_status,repair_due_at) VALUES ('conv','org','store','controller',2,3,3,3,'open','human','former-member',200,'waiting_internal',300)"),
    ]);
    for(const version of [1,2,3]){
      const action=version===1?'claim':version===2?'set_work_status':'transfer';
      const receipt=JSON.stringify({commandId:`command-${version}`,expectedVersion:version-1,action,...(version===2?{workStatus:'waiting_internal'}:version===3?{targetMemberId:'former-member',reason:'接班'}:{}),actorUserId:'former-user',actorMemberId:'former-member',appliedState:{schemaVersion:version===1?1:2,version,controlEpoch:version,sequence:version,lifecycle:'open',reception:'human',assignedMemberId:'former-member',updatedAt:version*100,...(version>=2?{workStatus:'waiting_internal'}:{})}},null,2);
      await db.prepare("INSERT INTO conversation_control_event(controller_id,organization_id,store_id,conversation_id,sequence,command_id,actor_user_id,actor_member_id,action,receipt,projected_at) VALUES ('controller','org','store','conv',?,?,'former-user','former-member',?,?,200)").bind(version,`command-${version}`,action,receipt).run();
    }
    return {db,sql:files.filter(name=>name.startsWith('0014_')).flatMap(statements),close:()=>mf.dispose()};
  }catch(error){await mf.dispose().catch(()=>{});throw error;}
}
function insertNote(db:D1Database){return db.prepare("INSERT INTO conversation_control_event(controller_id,organization_id,store_id,conversation_id,sequence,command_id,actor_user_id,actor_member_id,action,receipt,projected_at) VALUES ('controller','org','store','conv',4,'note-command','user','member','add_note','{}',301)").run();}

test('0014 expands only the event action contract, preserving parent identity, legacy/work-status/transfer receipt bytes, facts and guards with foreign keys enabled',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const parent=(await f.db.prepare('SELECT * FROM conversation_control').all()).results;
    const parentSchema=await f.db.prepare("SELECT sql,rootpage FROM sqlite_master WHERE type='table' AND name='conversation_control'").first();
    const events=(await f.db.prepare('SELECT * FROM conversation_control_event ORDER BY sequence').all()).results;
    const facts=(await f.db.prepare('SELECT * FROM message').all()).results;
    const guards=(await f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name IN ('conversation_control','conversation_control_event') AND type IN ('trigger','index') ORDER BY type,name").all()).results;
    const keys=(await f.db.prepare('PRAGMA foreign_key_list(conversation_control_event)').all()).results;
    if(f.sql.length)await f.db.batch(f.sql.map(sql=>f.db.prepare(sql)));
    await insertNote(f.db);
    assert.deepEqual((await f.db.prepare('SELECT * FROM conversation_control').all()).results,parent);
    assert.deepEqual(await f.db.prepare("SELECT sql,rootpage FROM sqlite_master WHERE type='table' AND name='conversation_control'").first(),parentSchema,'the parent table must not be rebuilt');
    assert.deepEqual((await f.db.prepare('SELECT * FROM conversation_control_event WHERE sequence<4 ORDER BY sequence').all()).results,events);
    assert.deepEqual((await f.db.prepare('SELECT * FROM message').all()).results,facts);
    assert.deepEqual((await f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name IN ('conversation_control','conversation_control_event') AND type IN ('trigger','index') ORDER BY type,name").all()).results,guards);
    assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_list(conversation_control_event)').all()).results,keys);
    assert.equal(await f.db.prepare('PRAGMA foreign_keys').first('foreign_keys'),1);
    assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
    await assert.rejects(f.db.prepare("UPDATE conversation_control_event SET receipt='{}' WHERE sequence=1").run(),/CONTROL_EVENT_IMMUTABLE/);
    await assert.rejects(f.db.prepare("INSERT INTO conversation_control_event SELECT controller_id,'wrong',store_id,conversation_id,5,'wrong-scope',actor_user_id,actor_member_id,action,receipt,projected_at FROM conversation_control_event WHERE sequence=4").run(),/CONTROL_SCOPE_MISMATCH/);
    await assert.rejects(f.db.prepare("INSERT INTO conversation_control_event SELECT controller_id,organization_id,store_id,conversation_id,sequence,command_id,actor_user_id,actor_member_id,action,'{}',projected_at FROM conversation_control_event WHERE sequence=1").run(),/CONTROL_EVENT_CONFLICT/);
    await assert.rejects(f.db.prepare("INSERT INTO conversation_control_event SELECT controller_id,organization_id,store_id,conversation_id,5,'unknown-action',actor_user_id,actor_member_id,'future-action',receipt,projected_at FROM conversation_control_event WHERE sequence=4").run(),/CHECK constraint/);
    await assert.rejects(f.db.prepare("UPDATE conversation_control SET controller_id='changed'").run(),/CONTROL_SCOPE_IMMUTABLE/);
    await assert.rejects(f.db.prepare('UPDATE conversation_control SET sequence=0').run(),/CONTROL_STATE_REGRESSION/);
    await f.db.prepare("DELETE FROM conversation WHERE id='conv'").run();
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control_event').first('n'),0);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control').first('n'),0);
  }finally{await f.close();}
});

test('a failed 0014 migration batch rolls back schema and raw receipts before retrying successfully',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const schema=(await f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results;
    const parent=(await f.db.prepare('SELECT * FROM conversation_control').all()).results;
    const events=(await f.db.prepare('SELECT * FROM conversation_control_event ORDER BY sequence').all()).results;
    await assert.rejects(f.db.batch([...f.sql.map(sql=>f.db.prepare(sql)),f.db.prepare('SELECT * FROM synthetic_migration_failure')]),/synthetic_migration_failure/);
    assert.deepEqual((await f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results,schema);
    assert.deepEqual((await f.db.prepare('SELECT * FROM conversation_control').all()).results,parent);
    assert.deepEqual((await f.db.prepare('SELECT * FROM conversation_control_event ORDER BY sequence').all()).results,events);
    assert.equal(await f.db.prepare('PRAGMA foreign_keys').first('foreign_keys'),1);
    if(f.sql.length)await f.db.batch(f.sql.map(sql=>f.db.prepare(sql)));
    await insertNote(f.db);
  }finally{await f.close();}
});
