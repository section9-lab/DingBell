import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';

async function fixture() {
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("append fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  try {
    const db=await mf.getD1Database('DB') as unknown as D1Database,folder=new URL('../migrations/',import.meta.url);
    const files=readdirSync(folder).filter(name=>name.endsWith('.sql')).sort();
    const statements=(name:string)=>readFileSync(new URL(name,folder),'utf8').split('--> statement-breakpoint').map(sql=>sql.trim()).filter(Boolean);
    for(const name of files.filter(name=>name<'0020'))await db.batch(statements(name).map(sql=>db.prepare(sql)));
    await db.batch([
      db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES ('append-a','A','append-a',1),('append-b','B','append-b',1)"),
      ...[['store-a','append-a'],['store-b','append-b']].map(([id,org])=>db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,credential_key_version,credential_nonce,credential_ciphertext,created_at,updated_at) VALUES (?,?,?,?,'verified','fixture-key','fixture-nonce','fixture-ciphertext',1,1)").bind(id,org,id,id)),
      ...[['chat-a','store-a','append-a'],['chat-b','store-b','append-b']].map(([id,store,org])=>db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES (?,?,?,?,'BUYER_SELLER','OPEN',1,1)").bind(id,org,store,id)),
    ]);
    function message(id:string,time=100,other=false,platformId=id) {
      return db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES (?,?,?,?,?,'customer','Customer','inbound',?,0,0,?,200,'backfill') ON CONFLICT DO NOTHING")
        .bind(id,other?'append-b':'append-a',other?'store-b':'store-a',other?'chat-b':'chat-a',platformId,JSON.stringify(['  原文\r\nЗдравствуйте!  ']),time);
    }
    await db.batch([message('old-a',300),message('old-b',100),message('other-a',500,true)]);
    return {db,message,sql:files.filter(name=>name.startsWith('0020_')).flatMap(statements),close:()=>mf.dispose()};
  } catch(error) { await mf.dispose(); throw error; }
}

test('0020 assigns durable per-conversation append order and preserves original data and rollback boundaries',{timeout:60_000},async t=>{
  const f=await fixture();t.after(f.close);const {db}=f;
  assert.ok(f.sql.length,'the message append migration is required');
  const before=(await db.prepare('SELECT * FROM message ORDER BY id').all()).results;
  const guards=(await db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all()).results;
  const roots=(await db.prepare("SELECT name,rootpage FROM sqlite_master WHERE type='table' AND name IN ('conversation','message') ORDER BY name").all()).results;
  await db.batch(f.sql.map(sql=>db.prepare(sql)));
  const order=async(id='chat-a')=>(await db.prepare('SELECT message_id AS id,sequence FROM message_append WHERE conversation_id=? ORDER BY sequence').bind(id).all()).results;
  const sequence=async(id='chat-a')=>(await db.prepare('SELECT message_sequence AS value FROM conversation WHERE id=?').bind(id).first<{value:number}>())!.value;
  await t.test('migration numbers existing immutable messages deterministically without changing their content',async()=>{
    assert.deepEqual((await db.prepare('SELECT * FROM message ORDER BY id').all()).results,before);
    assert.deepEqual((await db.prepare("SELECT name,rootpage FROM sqlite_master WHERE type='table' AND name IN ('conversation','message') ORDER BY name").all()).results,roots,'neither parent table may be rebuilt');
    const current=(await db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all()).results;
    assert.deepEqual(current.filter(row=>guards.some(guard=>guard.name===row.name)),guards);assert.equal(current.length,guards.length+6);
    assert.deepEqual(await order(),[{id:'old-b',sequence:1},{id:'old-a',sequence:2}]);assert.equal(await sequence(),2);
    assert.deepEqual(await order('chat-b'),[{id:'other-a',sequence:1}]);assert.equal(await sequence('chat-b'),1);
  });
  await t.test('late and simultaneous inserts use commit order, not event time, while other conversations stay independent',async()=>{
    await db.batch([f.message('late',1),f.message('same-time',300)]);
    await Promise.all([f.message('parallel-a',300).run(),f.message('parallel-b',300).run()]);
    const rows=await order();assert.deepEqual(rows.slice(2,4),[{id:'late',sequence:3},{id:'same-time',sequence:4}]);
    assert.deepEqual(new Set(rows.slice(4).map(row=>row.id)),new Set(['parallel-a','parallel-b']));assert.deepEqual(rows.slice(4).map(row=>row.sequence),[5,6]);assert.equal(await sequence('chat-b'),1);
  });
  await t.test('duplicate imports and a failed page transaction cannot advance the append boundary',async()=>{
    const old=await order();await f.message('duplicate-id',1,false,'late').run();assert.deepEqual(await order(),old);
    await assert.rejects(()=>db.batch([f.message('rolled-back',0),db.prepare('SELECT missing_append_function()')]));
    assert.equal(await db.prepare("SELECT id FROM message WHERE id='rolled-back'").first(),null);assert.deepEqual(await order(),old);assert.equal(await sequence(),6);
    await assert.rejects(()=>db.prepare("UPDATE message SET content='[\"changed\"]' WHERE id='late'").run(),/MESSAGE_IMMUTABLE/);
  });
  await t.test('deleting the latest message never reuses its number and direct append edits cannot detach an existing message',async()=>{
    const newest=(await order()).at(-1)!;await assert.rejects(()=>db.prepare('DELETE FROM message_append WHERE message_id=?').bind(newest.id).run(),/MESSAGE_APPEND/);
    await assert.rejects(()=>db.prepare('UPDATE message_append SET sequence=sequence WHERE message_id=?').bind(newest.id).run(),/MESSAGE_APPEND/);
    await db.prepare('DELETE FROM message WHERE id=?').bind(newest.id).run();assert.equal(await sequence(),6);
    await f.message('after-delete',0).run();assert.deepEqual((await order()).at(-1),{id:'after-delete',sequence:7});
    await assert.rejects(()=>db.prepare("UPDATE conversation SET message_sequence=0 WHERE id='chat-a'").run(),/MESSAGE_SEQUENCE/);
    await assert.rejects(()=>db.prepare("INSERT OR REPLACE INTO message_append SELECT * FROM message_append WHERE message_id='after-delete'").run(),/MESSAGE_APPEND/);
  });
  await t.test('foreign scope append rows and unsafe counter increments fail without adding a message',async()=>{
    await assert.rejects(()=>db.prepare("INSERT INTO message_append(conversation_id,organization_id,store_id,message_id,sequence) VALUES ('chat-b','append-b','store-b','late',2)").run());
    const guard=f.sql.find(sql=>sql.startsWith('CREATE TRIGGER conversation_message_sequence_update'))!;assert.ok(guard);
    await db.prepare('DROP TRIGGER conversation_message_sequence_update').run();await db.prepare("UPDATE conversation SET message_sequence=? WHERE id='chat-a'").bind(Number.MAX_SAFE_INTEGER-1).run();await db.prepare(guard).run();
    await f.message('last-safe',0).run();assert.equal(await sequence(),Number.MAX_SAFE_INTEGER);
    await assert.rejects(()=>f.message('unsafe',0).run(),/MESSAGE_SEQUENCE/);assert.equal(await db.prepare("SELECT id FROM message WHERE id='unsafe'").first(),null);
    assert.equal(await sequence(),Number.MAX_SAFE_INTEGER);assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
  });
  await t.test('parent deletion cascades only its append records without leaving detached rows',async()=>{
    await db.prepare("DELETE FROM conversation WHERE id='chat-b'").run();assert.deepEqual(await order('chat-b'),[]);
    assert.equal(await db.prepare("SELECT id FROM message WHERE id='other-a'").first(),null);assert.ok((await order()).length);
    assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
  });
});

test('0020 failed migration leaves the old schema, messages and existing guards intact',{timeout:30_000},async t=>{
  const f=await fixture();t.after(f.close);assert.ok(f.sql.length,'the message append migration is required');
  const before=(await f.db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()).results;
  await assert.rejects(()=>f.db.batch([...f.sql.map(sql=>f.db.prepare(sql)),f.db.prepare('SELECT missing_append_function()')]));
  assert.deepEqual((await f.db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()).results,before);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM message').first<{count:number}>())!.count,3);
});
