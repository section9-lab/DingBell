import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';

const folder = new URL('../migrations/', import.meta.url);
async function apply(db: D1Database, name: string) {
  for (const sql of readFileSync(new URL(name,folder),'utf8').split('--> statement-breakpoint').map(part=>part.trim()).filter(Boolean)) await db.prepare(sql).run();
}

test('existing chat data migrates into independent source authorization and a fenced store coordinator', {timeout:30_000}, async context => {
  const mf = new Miniflare({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  context.after(()=>mf.dispose());
  const db = await mf.getD1Database('DB') as unknown as D1Database;
  const migrations = readdirSync(folder).filter(name=>name.endsWith('.sql')).sort();
  for (const name of migrations.filter(name=>name<'0007')) await apply(db,name);
  const deadline=Date.now()+120_000;
  await db.batch([
    db.prepare("INSERT INTO organization (id,name,slug,created_at) VALUES ('org','Org','org',1)"),
    db.prepare("INSERT INTO store (id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES ('store','org','Store','1','verified',1,1)"),
    db.prepare("INSERT INTO store_sync (store_id,organization_id,enabled,epoch,fence,credential_version,lease_token,lease_until,commit_token,due_at,blocked_until,last_success_at,last_error,failures,updated_at) VALUES ('store','org',1,7,12,1,'old-lease',?,'old-commit',100,?,90,'rate_limited',2,100)").bind(deadline,deadline),
    db.prepare("INSERT INTO conversation (id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES ('conversation','org','store','chat','BUYER_SELLER','Opened',1,1)"),
    db.prepare("INSERT INTO message (id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES ('message','org','store','conversation','18446744073709551615','Customer','inbound','[\"historical\"]',0,0,1,1,'backfill')"),
    db.prepare("INSERT INTO ingest_event (id,organization_id,store_id,conversation_id,message_id,state,trace_id,created_at) VALUES ('event','org','store','conversation','message','historical','trace',1)"),
    db.prepare("INSERT INTO sync_cursor (organization_id,store_id,thread_id,stream,conversation_id,cursor,recent_cursors,revision,due_at) VALUES ('org','store','chat','backfill','conversation','18446744073709551615','[\"opaque-previous\"]',3,100)"),
  ]);
  for (const name of migrations.filter(name=>name.startsWith('0007_'))) await apply(db,name);
  const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>()).results.map(row=>row.name);
  assert.ok(tables.includes('store_coordinator'),'the shared coordinator must be migrated');
  assert.ok(tables.includes('store_sync_source'),'each resource needs its own authorization');
  assert.ok(!tables.includes('store_sync'),'the old mixed ownership table must not remain authoritative');
  const source=await db.prepare('SELECT * FROM store_sync_source').first();
  assert.equal(source?.source,'chat'); assert.equal(source?.enabled,1); assert.equal(source?.epoch,7);
  assert.equal(source?.credential_version,1); assert.equal(source?.last_error,'rate_limited'); assert.equal(source?.failures,2);
  const coordinator=await db.prepare('SELECT * FROM store_coordinator').first();
  assert.equal(coordinator?.fence,13); assert.equal(coordinator?.lease_token,null); assert.equal(coordinator?.lease_until,null);
  assert.equal(coordinator?.commit_token,null); assert.equal(coordinator?.blocked_until,deadline);
  assert.equal(await db.prepare('SELECT count(*) AS n FROM conversation').first('n'),1);
  assert.equal(await db.prepare('SELECT count(*) AS n FROM message').first('n'),1);
  assert.equal(await db.prepare('SELECT state FROM ingest_event').first('state'),'historical');
  const cursor=await db.prepare('SELECT cursor,recent_cursors,revision,source FROM sync_cursor').first();
  assert.equal(cursor?.cursor,'18446744073709551615'); assert.equal(cursor?.revision,3); assert.equal(cursor?.source,'chat');
  assert.equal(cursor?.recent_cursors,'["opaque-previous"]');
  assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
  await db.prepare("UPDATE store SET status='paused',revision=revision+1 WHERE id='store'").run();
  assert.equal(await db.prepare("SELECT enabled FROM store_sync_source WHERE source='chat'").first('enabled'),0);
  assert.equal(await db.prepare('SELECT blocked_until FROM store_coordinator').first('blocked_until'),deadline);
});

test('adding FBS source preserves populated chat and product state while fencing old leases', {timeout:30_000}, async context => {
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  context.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB') as unknown as D1Database;
  const migrations=readdirSync(folder).filter(name=>name.endsWith('.sql')).sort();
  for(const name of migrations.filter(name=>name<'0008')) await apply(db,name);
  const deadline=Date.now()+120_000;
  await db.batch([
    db.prepare("INSERT INTO organization (id,name,slug,created_at) VALUES ('org','Org','org',1)"),
    db.prepare("INSERT INTO store (id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES ('store','org','Store','1','verified',1,1)"),
    db.prepare("INSERT INTO store_coordinator (store_id,organization_id,fence,lease_source,lease_token,lease_until,commit_token,blocked_until) VALUES ('store','org',12,'products','old-lease',?,'old-commit',?)").bind(deadline,deadline),
    db.prepare("INSERT INTO store_sync_source (store_id,organization_id,source,enabled,epoch,credential_version,due_at,last_success_at,last_error,failures,last_attempt_at,updated_at) VALUES ('store','org','chat',0,7,1,100,90,'permission_denied',2,99,100),('store','org','products',1,4,1,80,70,'rate_limited',1,79,80)"),
    db.prepare("INSERT INTO conversation (id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES ('conversation','org','store','chat','BUYER_SELLER','Opened',1,1)"),
    db.prepare("INSERT INTO message (id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES ('message','org','store','conversation','18446744073709551615','Customer','inbound','[\"historical\"]',0,0,1,1,'backfill')"),
    db.prepare("INSERT INTO ingest_event (id,organization_id,store_id,conversation_id,message_id,state,trace_id,created_at) VALUES ('event','org','store','conversation','message','historical','trace',1)"),
    db.prepare("INSERT INTO sync_cursor (organization_id,store_id,thread_id,stream,conversation_id,cursor,recent_cursors,revision,due_at) VALUES ('org','store','chat','backfill','conversation','18446744073709551615','[\"opaque-previous\"]',3,100)"),
    db.prepare("INSERT INTO product_sync_cursor (store_id,organization_id,epoch,generation,cursor,revision,recent_cursors,due_at,last_kind,last_completed_at) VALUES ('store','org',4,3,'opaque-product',8,'[\"previous\"]',80,'list',70)"),
    db.prepare("INSERT INTO product (id,organization_id,store_id,listing,list_observed_at,facts,facts_observed_at,detail_epoch,detail_generation,detail_revision,detail_state,detail_attempt,detail_due_at,detail_error) VALUES ('18446744073709551615','org','store','{\"id\":\"18446744073709551615\"}',90,'{\"price\":\"123.4500\"}',80,4,3,9,'error',3,100,'product_details_missing')"),
    db.prepare("INSERT INTO product_source_snapshot (id,organization_id,store_id,product_id,facts,observed_at) VALUES ('snapshot','org','store','18446744073709551615','{\"price\":\"123.4500\"}',80)"),
  ]);
  const preserved=['store_sync_source','conversation','message','ingest_event','sync_cursor','product_sync_cursor','product','product_source_snapshot'];
  const before=await Promise.all(preserved.map(table=>db.prepare(`SELECT * FROM ${table}`).all()));
  for(const name of migrations.filter(name=>name.startsWith('0008_'))) await apply(db,name);
  const coordinator=await db.prepare('SELECT * FROM store_coordinator').first();
  assert.equal(coordinator?.fence,13,'a migration must fence every old in-flight lease');
  assert.equal(coordinator?.lease_source,null);assert.equal(coordinator?.lease_token,null);assert.equal(coordinator?.lease_until,null);assert.equal(coordinator?.commit_token,null);
  assert.equal(coordinator?.blocked_until,deadline);
  for(let index=0;index<preserved.length;index++) assert.deepEqual((await db.prepare(`SELECT * FROM ${preserved[index]}`).all()).results,before[index]!.results,preserved[index]);
  assert.equal(await db.prepare('PRAGMA foreign_keys').first('foreign_keys'),1);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  await assert.rejects(db.prepare("UPDATE message SET content='[\"changed\"]'").run(),/MESSAGE_IMMUTABLE/);
  await assert.rejects(db.prepare("UPDATE product_source_snapshot SET facts='{}'").run(),/PRODUCT_SNAPSHOT_IMMUTABLE/);
  await db.prepare("INSERT INTO store_sync_source (store_id,organization_id,source,enabled,epoch,credential_version,due_at,updated_at) VALUES ('store','org','fbs_postings',1,1,1,100,100)").run();
  await db.prepare("UPDATE store_coordinator SET lease_source='fbs_postings',lease_token='fbs-lease',lease_until=? WHERE store_id='store'").bind(deadline).run();
  await db.prepare("UPDATE store SET credential_version=credential_version+1,revision=revision+1 WHERE id='store'").run();
  assert.equal(await db.prepare('SELECT count(*) AS n FROM store_sync_source WHERE enabled=1').first('n'),0);
  assert.equal(await db.prepare('SELECT lease_token FROM store_coordinator').first('lease_token'),null);
  assert.equal(await db.prepare('SELECT blocked_until FROM store_coordinator').first('blocked_until'),deadline);
  assert.equal(await db.prepare('SELECT count(*) AS n FROM product_source_snapshot').first('n'),1);
});
