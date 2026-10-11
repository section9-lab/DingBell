import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';

async function fixture(){
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("work status migration fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  const db=await mf.getD1Database('DB') as unknown as D1Database,folder=new URL('../migrations/',import.meta.url);
  const files=readdirSync(folder).filter(name=>name.endsWith('.sql')).sort();
  const statements=(name:string)=>readFileSync(new URL(name,folder),'utf8').split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean);
  for(const name of files.filter(name=>name<'0012'))for(const sql of statements(name))await db.prepare(sql).run();
  await db.batch([
    db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES ('org','Org','org',1)"),
    db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES ('store','org','Store','1','paused',1,1)"),
    db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES ('open','org','store','open','BUYER_SELLER','Opened',1,1),('resolved','org','store','resolved','BUYER_SELLER','Opened',1,1),('new','org','store','new','BUYER_SELLER','Opened',1,1)"),
    db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES ('msg','org','store','open','18446744073709551615','Customer','inbound','[\"Здравствуйте\"]',0,0,3,4,'backfill')"),
  ]);
  for(const lifecycle of ['open','resolved']){
    const action=lifecycle==='open'?'claim':'resolve';
    const receipt=JSON.stringify({commandId:`${lifecycle}-command`,expectedVersion:0,action,actorUserId:'former-user',actorMemberId:'former-member',appliedState:{schemaVersion:1,version:1,controlEpoch:1,sequence:1,lifecycle,reception:'human',assignedMemberId:'former-member',updatedAt:100}},null,2);
    await db.batch([
      db.prepare("INSERT INTO conversation_control(conversation_id,organization_id,store_id,controller_id,version,control_epoch,sequence,lifecycle,reception,assigned_member_id,updated_at,repair_due_at) VALUES (?,'org','store',?,1,1,1,?,'human','former-member',100,200)").bind(lifecycle,`${lifecycle}-controller`,lifecycle),
      db.prepare("INSERT INTO conversation_control_event(controller_id,organization_id,store_id,conversation_id,sequence,command_id,actor_user_id,actor_member_id,action,receipt,projected_at) VALUES (?,'org','store',?,1,?,'former-user','former-member',?,?,100)").bind(`${lifecycle}-controller`,lifecycle,`${lifecycle}-command`,action,receipt),
    ]);
  }
  return {db,sql:files.filter(name=>name.startsWith('0012_')).flatMap(statements),close:()=>mf.dispose()};
}

test('0012 keeps populated v1 parent/child data and raw receipts with foreign keys active while admitting checked v2 states',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const parent=(await f.db.prepare('SELECT * FROM conversation_control ORDER BY conversation_id').all()).results;
    const events=(await f.db.prepare('SELECT * FROM conversation_control_event ORDER BY controller_id').all()).results;
    const facts=(await f.db.prepare('SELECT * FROM message').all()).results;
    const contracts=(await f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name IN ('conversation_control','conversation_control_event') AND type IN ('trigger','index') ORDER BY type,name").all()).results;
    const keys=(await f.db.prepare('PRAGMA foreign_key_list(conversation_control_event)').all()).results;
    if(f.sql.length)await f.db.batch(f.sql.map(sql=>f.db.prepare(sql)));
    const rows=(await f.db.prepare('SELECT * FROM conversation_control ORDER BY conversation_id').all()).results;
    assert.ok(rows.every(row=>row.schema_version===1&&row.work_status===null),'legacy rows keep schema 1 with a new NULL work_status column');
    assert.deepEqual(rows.map(({work_status,...row})=>row),parent);
    assert.deepEqual((await f.db.prepare('SELECT * FROM conversation_control_event ORDER BY controller_id').all()).results,events);
    assert.deepEqual((await f.db.prepare('SELECT * FROM message').all()).results,facts);
    assert.deepEqual((await f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name IN ('conversation_control','conversation_control_event') AND type IN ('trigger','index') ORDER BY type,name").all()).results,contracts);
    assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_list(conversation_control_event)').all()).results,keys);
    assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
    assert.equal(await f.db.prepare('PRAGMA foreign_keys').first('foreign_keys'),1);
    assert.equal(await f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '__new_conversation_control%'").first('n'),0);
    for(const work of ['needs_reply','waiting_customer','waiting_internal'])await f.db.prepare("UPDATE conversation_control SET schema_version=2,work_status=? WHERE conversation_id='open'").bind(work).run();
    await f.db.prepare("UPDATE conversation_control SET schema_version=2,work_status=NULL WHERE conversation_id='resolved'").run();
    for(const [version,lifecycle,work]of [[1,'open','needs_reply'],[2,'open',null],[2,'open','unknown'],[2,'resolved','needs_reply'],[3,'open','needs_reply']] as const)
      await assert.rejects(f.db.prepare("UPDATE conversation_control SET schema_version=?,lifecycle=?,work_status=? WHERE conversation_id='open'").bind(version,lifecycle,work).run(),/CHECK constraint/);
    await f.db.prepare("INSERT INTO conversation_control(conversation_id,organization_id,store_id,controller_id,repair_due_at) VALUES ('new','org','store','new-controller',1)").run();
    assert.deepEqual(await f.db.prepare("SELECT schema_version,work_status FROM conversation_control WHERE conversation_id='new'").first(),{schema_version:1,work_status:null},'the old insert contract remains usable during deployment');
    await f.db.prepare("INSERT INTO conversation_control_event(controller_id,organization_id,store_id,conversation_id,sequence,command_id,actor_user_id,actor_member_id,action,receipt,projected_at) VALUES ('open-controller','org','store','open',2,'new-command','user','member','set_work_status','{}',101)").run();
    await assert.rejects(f.db.prepare("UPDATE conversation_control_event SET receipt='{}' WHERE sequence=1").run(),/CONTROL_EVENT_IMMUTABLE/);
    await assert.rejects(f.db.prepare("INSERT INTO conversation_control_event SELECT controller_id,'wrong',store_id,conversation_id,sequence,command_id,actor_user_id,actor_member_id,action,receipt,projected_at FROM conversation_control_event WHERE sequence=1").run(),/CONTROL_SCOPE_MISMATCH/);
    await assert.rejects(f.db.prepare("INSERT INTO conversation_control_event SELECT controller_id,organization_id,store_id,conversation_id,sequence,command_id,actor_user_id,actor_member_id,action,'{}',projected_at FROM conversation_control_event WHERE sequence=1").run(),/CONTROL_EVENT_CONFLICT/);
    await assert.rejects(f.db.prepare("UPDATE conversation_control SET controller_id='changed'").run(),/CONTROL_SCOPE_IMMUTABLE/);
    await assert.rejects(f.db.prepare('UPDATE conversation_control SET sequence=0 WHERE sequence=1').run(),/CONTROL_STATE_REGRESSION/);
    await f.db.prepare("DELETE FROM conversation WHERE id='open'").run();
    assert.equal(await f.db.prepare("SELECT COUNT(*) AS n FROM conversation_control_event WHERE controller_id='open-controller'").first('n'),0);
    assert.equal(await f.db.prepare("SELECT COUNT(*) AS n FROM conversation_control_event WHERE controller_id='resolved-controller'").first('n'),1);
  }finally{await f.close();}
});

test('a failing 0012 transaction restores the original schema, state and immutable receipts before a successful retry',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const schema=(await f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results;
    const parent=(await f.db.prepare('SELECT * FROM conversation_control ORDER BY conversation_id').all()).results;
    const child=(await f.db.prepare('SELECT * FROM conversation_control_event ORDER BY controller_id').all()).results;
    await assert.rejects(f.db.batch([...f.sql.map(sql=>f.db.prepare(sql)),f.db.prepare('SELECT * FROM synthetic_migration_failure')]),/synthetic_migration_failure/);
    assert.deepEqual((await f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results,schema);
    assert.deepEqual((await f.db.prepare('SELECT * FROM conversation_control ORDER BY conversation_id').all()).results,parent);
    assert.deepEqual((await f.db.prepare('SELECT * FROM conversation_control_event ORDER BY controller_id').all()).results,child);
    assert.equal(await f.db.prepare('PRAGMA foreign_keys').first('foreign_keys'),1);
    assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
    if(f.sql.length)await f.db.batch(f.sql.map(sql=>f.db.prepare(sql)));
    await f.db.prepare("UPDATE conversation_control SET schema_version=2,work_status='needs_reply' WHERE conversation_id='open'").run();
  }finally{await f.close();}
});
