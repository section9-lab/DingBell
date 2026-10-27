import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {test} from 'node:test';
import {URL} from 'node:url';
import {Miniflare} from 'miniflare';

const folder=new URL('../migrations/',import.meta.url),statements=(name:string)=>readFileSync(new URL(name,folder),'utf8').split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean);
test('0049 rolls back atomically and restores its guarded immutable item event ledger on retry',{timeout:30000},async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("handoff item migration")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
 try{
  const db=await mf.getD1Database('DB') as unknown as D1Database,files=readdirSync(folder).filter(name=>name.endsWith('.sql')).sort();for(const name of files.filter(name=>name<'0049_'))for(const sql of statements(name))await db.prepare(sql).run();
  const before=(await db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results,migration=files.find(name=>name.startsWith('0049_'))!;
  await assert.rejects(db.batch([...statements(migration).map(sql=>db.prepare(sql)),db.prepare('SELECT * FROM synthetic_handoff_item_migration_failure')]),/synthetic_handoff_item_migration_failure/);assert.deepEqual((await db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results,before);
  assert.equal(await db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'handoff_follow_up_item_%'").first('n'),0);await db.batch(statements(migration).map(sql=>db.prepare(sql)));
  assert.equal(await db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('handoff_follow_up_item_event','handoff_follow_up_item_guard','handoff_follow_up_item_immutable','handoff_follow_up_item_command_unique','handoff_follow_up_item_run_idx')").first('n'),5);assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.equal(await db.prepare('PRAGMA foreign_keys').first('foreign_keys'),1);
 }finally{await mf.dispose();}
});
