import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';

test('control directory migration preserves populated 0009 facts, grants, checkpoints and immutable triggers',{timeout:30_000},async context=>{
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("migration fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});context.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB') as unknown as D1Database;
  const folder=new URL('../migrations/',import.meta.url),files=readdirSync(folder).filter(name=>name.endsWith('.sql')).sort();
  async function apply(name:string){for(const sql of readFileSync(new URL(name,folder),'utf8').split('--> statement-breakpoint').map(part=>part.trim()).filter(Boolean))await db.prepare(sql).run();}
  for(const name of files.filter(name=>name<'0010'))await apply(name);
  const deadline=Date.now()+120_000;
  await db.batch([
    db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES ('org','Org','org',1)"),
    db.prepare("INSERT INTO user(id,name,email,email_verified) VALUES ('user','User','user@example.invalid',1)"),
    db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('member','org','user','member',1)"),
    db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES ('store','org','Store','1','verified',1,1)"),
    db.prepare("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES ('org','store','member',1)"),
    db.prepare("INSERT INTO store_coordinator(store_id,organization_id,fence,lease_source,lease_token,lease_until,blocked_until) VALUES ('store','org',9,'chat','preserved-lease',?,?)").bind(deadline,deadline),
    db.prepare("INSERT INTO store_sync_source(store_id,organization_id,source,enabled,epoch,credential_version,due_at,updated_at) VALUES ('store','org','chat',1,7,1,100,100),('store','org','products',1,4,1,100,100),('store','org','fbs_postings',1,3,1,100,100)"),
    db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,last_message_at,imported_at) VALUES ('conv','org','store','18446744073709551615','BUYER_SELLER','Opened',1,3,4)"),
    db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES ('msg','org','store','conv','18446744073709551615','Customer','inbound','[\"Здравствуйте\"]',0,0,3,4,'backfill')"),
    db.prepare("INSERT INTO ingest_event(id,organization_id,store_id,conversation_id,message_id,state,trace_id,created_at) VALUES ('event','org','store','conv','msg','historical','trace',4)"),
    db.prepare("INSERT INTO sync_cursor(organization_id,store_id,thread_id,stream,conversation_id,cursor,revision,due_at) VALUES ('org','store','18446744073709551615','backfill','conv','18446744073709551615',2,100)"),
    db.prepare("INSERT INTO product_sync_cursor(store_id,organization_id,epoch,cursor,due_at) VALUES ('store','org',4,'product-next',100)"),
    db.prepare("INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,facts,facts_observed_at,detail_epoch,detail_generation,detail_state,detail_due_at) VALUES ('product','org','store','{}',1,'{\"price\":\"123.45\"}',2,4,1,'complete',100)"),
    db.prepare("INSERT INTO product_source_snapshot(id,organization_id,store_id,product_id,facts,observed_at) VALUES ('snapshot','org','store','product','{\"price\":\"123.45\"}',2)"),
    db.prepare("INSERT INTO fbs_sync_window(store_id,organization_id,epoch,history_start,since,\"to\",cursor,due_at) VALUES ('store','org',3,0,0,1000,'fbs-next',100)"),
    db.prepare("INSERT INTO fbs_posting(posting_number,organization_id,store_id,order_id,order_number,list_facts,detail_epoch,detail_generation,detail_due_at) VALUES ('posting','org','store','18446744073709551615','order','{}',3,1,100)"),
    db.prepare("INSERT INTO fbs_posting_observation(id,organization_id,store_id,posting_number,source,facts,observed_at) VALUES ('observation','org','store','posting','list','{}',1)"),
  ]);
  const preserved=['conversation','message','ingest_event','member','store_grant','store','store_coordinator','store_sync_source','sync_cursor','product','product_sync_cursor','product_source_snapshot','fbs_sync_window','fbs_posting','fbs_posting_observation'];
  const before=await Promise.all(preserved.map(table=>db.prepare(`SELECT * FROM ${table}`).all()));
  for(const name of files.filter(name=>name.startsWith('0010_')))await apply(name);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('conversation_control','conversation_control_event')").first('n'),2);
  for(let i=0;i<preserved.length;i++)assert.deepEqual((await db.prepare(`SELECT * FROM ${preserved[i]}`).all()).results,before[i]!.results,preserved[i]);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM conversation_control').first('n'),0,'history import does not create control objects');
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  await assert.rejects(db.prepare("UPDATE message SET content='[]'").run(),/MESSAGE_IMMUTABLE/);
  await assert.rejects(db.prepare("UPDATE product_source_snapshot SET facts='{}'").run(),/PRODUCT_SNAPSHOT_IMMUTABLE/);
  await assert.rejects(db.prepare("UPDATE fbs_posting_observation SET facts='{\"changed\":true}'").run(),/FBS_OBSERVATION_IMMUTABLE/);
  await assert.rejects(db.prepare("INSERT INTO conversation_control(conversation_id,organization_id,store_id,controller_id,repair_due_at) VALUES ('conv','foreign','store','controller',1)").run(),/FOREIGN KEY/);
  await db.prepare("UPDATE store SET status='paused',revision=revision+1 WHERE id='store'").run();
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM store_sync_source WHERE enabled=1').first('n'),0);
  assert.equal(await db.prepare('SELECT blocked_until FROM store_coordinator').first('blocked_until'),deadline);
});

test('0011 expands only the event action constraint while preserving populated 0010 authority projections and receipt bytes',{timeout:30_000},async context=>{
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("reopen migration fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});context.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB') as unknown as D1Database;
  const folder=new URL('../migrations/',import.meta.url),files=readdirSync(folder).filter(name=>name.endsWith('.sql')).sort();
  async function apply(name:string){for(const sql of readFileSync(new URL(name,folder),'utf8').split('--> statement-breakpoint').map(part=>part.trim()).filter(Boolean))await db.prepare(sql).run();}
  for(const name of files.filter(name=>name<'0011'))await apply(name);
  const receipt=JSON.stringify({commandId:'original-resolve',expectedVersion:0,action:'resolve',actorUserId:'original-user',actorMemberId:'original-member',appliedState:{schemaVersion:1,version:1,controlEpoch:1,sequence:1,lifecycle:'resolved',reception:'human',assignedMemberId:'original-member',updatedAt:100}},null,2);
  const reopened=JSON.stringify({...JSON.parse(receipt),commandId:'new-reopen',expectedVersion:1,action:'reopen',appliedState:{...JSON.parse(receipt).appliedState,version:2,controlEpoch:2,sequence:2,lifecycle:'open',updatedAt:101}});
  await db.batch([
    db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES ('org','Org','org',1)"),
    db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES ('store','org','Store','1','paused',1,1)"),
    db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES ('conv','org','store','thread','BUYER_SELLER','Opened',1,1)"),
    db.prepare("INSERT INTO conversation_control(conversation_id,organization_id,store_id,controller_id,version,control_epoch,sequence,lifecycle,reception,assigned_member_id,updated_at,repair_due_at) VALUES ('conv','org','store','controller',1,1,1,'resolved','human','original-member',100,200)"),
    db.prepare("INSERT INTO conversation_control_event(controller_id,organization_id,store_id,conversation_id,sequence,command_id,actor_user_id,actor_member_id,action,receipt,projected_at) VALUES ('controller','org','store','conv',1,'original-resolve','original-user','original-member','resolve',?,100)").bind(receipt),
  ]);
  const before=await db.prepare('SELECT * FROM conversation_control_event').all();
  const parent=await db.prepare('SELECT * FROM conversation_control').all();
  const preservedSchema=await db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name='conversation_control' OR (tbl_name IN ('conversation_control','conversation_control_event') AND type IN ('index','trigger')) ORDER BY type,name").all();
  const foreignKeys=await db.prepare('PRAGMA foreign_key_list(conversation_control_event)').all();
  const insert=(sequence:number,commandId:string,action:string,scope='org',text=receipt)=>db.prepare("INSERT INTO conversation_control_event(controller_id,organization_id,store_id,conversation_id,sequence,command_id,actor_user_id,actor_member_id,action,receipt,projected_at) VALUES ('controller',?,'store','conv',?,?,'original-user','original-member',?,?,101)").bind(scope,sequence,commandId,action,text);
  await assert.rejects(insert(2,'new-reopen','reopen','org',reopened).run(),/conversation_control_event_action_valid/);
  for(const name of files.filter(name=>name.startsWith('0011_')))await apply(name);
  await insert(2,'new-reopen','reopen','org',reopened).run();
  assert.deepEqual((await db.prepare('SELECT * FROM conversation_control_event WHERE sequence=1').all()).results,before.results,'old receipt and every audit column retain their original bytes');
  assert.deepEqual((await db.prepare('SELECT * FROM conversation_control').all()).results,parent.results,'parent projection is not rebuilt or altered');
  assert.deepEqual((await db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name='conversation_control' OR (tbl_name IN ('conversation_control','conversation_control_event') AND type IN ('index','trigger')) ORDER BY type,name").all()).results,preservedSchema.results);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_list(conversation_control_event)').all()).results,foreignKeys.results);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  assert.equal(await db.prepare('PRAGMA foreign_keys').first('foreign_keys'),1);
  await assert.rejects(insert(3,'unsupported','wait').run(),/conversation_control_event_action_valid/);
  await assert.rejects(insert(3,'wrong-scope','reopen','other').run(),/CONTROL_SCOPE_MISMATCH/);
  await assert.rejects(insert(3,'original-resolve','resolve','org','{}').run(),/CONTROL_EVENT_CONFLICT/);
  await assert.rejects(insert(3,'original-resolve','resolve').run(),/UNIQUE/);
  await assert.rejects(db.prepare("UPDATE conversation_control_event SET receipt='{}'").run(),/CONTROL_EVENT_IMMUTABLE/);
  await assert.rejects(db.prepare("UPDATE conversation_control SET controller_id='changed'").run(),/CONTROL_SCOPE_IMMUTABLE/);
  await assert.rejects(db.prepare('UPDATE conversation_control SET version=0').run(),/CONTROL_STATE_REGRESSION/);
  await db.prepare("DELETE FROM conversation WHERE id='conv'").run();
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM conversation_control_event').first('n'),0,'the original cascade contract is preserved');
});
