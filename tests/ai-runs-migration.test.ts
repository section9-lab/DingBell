import assert from 'node:assert/strict';
import {test} from 'node:test';
import {conversationControlFixture} from './fixtures/conversation-control.ts';
test('0033 adds AI financial tables without rewriting existing rows, audits or foreign-key relationships',{timeout:30000},async t=>{
 const f=await conversationControlFixture('0032');t.after(f.close);
 assert.equal((await f.call('execute',{command:{commandId:crypto.randomUUID(),action:'claim',expectedVersion:0}})).body.outcome,'accepted');
 const tables=(await f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'_cf_METADATA'").all<{name:string}>()).results.map(r=>r.name);
 const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await f.db.prepare(`SELECT * FROM "${table.replaceAll('"','""')}"`).all()).results.map(row=>JSON.stringify(row)).sort()])));
 const before=await snapshot();await f.migrateAfter('0032');assert.deepEqual(await snapshot(),before);
 const added=(await f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ai_%' ORDER BY name").all<{name:string}>()).results.map(r=>r.name);assert.deepEqual(added,['ai_answer','ai_budget','ai_budget_audit','ai_dispatch','ai_execution','ai_generation','ai_knowledge_query','ai_reply_intent']);
 assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
});
