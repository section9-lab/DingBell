import {aiAnswerFixture as fixture} from './fixtures/ai-answer.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {URL} from 'node:url';
import {conversationControlFixture} from './fixtures/conversation-control.ts';
import {withdrawKnowledge} from '../src/modules/knowledge/storage.ts';
import {searchAiKnowledge} from '../src/modules/ai-runs/knowledge.ts';
import type {AiRunReader} from '../src/modules/ai-runs/storage.ts';
async function api(){const m=await import('../src/modules/ai-runs/answer.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.submitAiAnswer,'function','A cited draft must be committed with current run and knowledge authority');return m!;}
test('a cited answer is immutable, scoped, idempotent and never a send permission',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);const id=x.run.request.runId;
 assert.equal((await searchAiKnowledge(x.env,x.read,x.scope,id)).status,'found');
 const first=await m.submitAiAnswer(x.env,x.read,x.scope,id,x.input);assert.equal(first.status,'submitted');assert.equal(first.canSend,false);assert.equal(first.reviewRequired,true);
 assert.deepEqual(await m.submitAiAnswer(x.env,x.read,x.scope,id,x.input),first);
 assert.equal((await m.submitAiAnswer(x.env,x.read,x.scope,id,{...x.input,body:'Different answer.'})).status,'conflict');
 assert.equal((await m.submitAiAnswer(x.env,x.read,{...x.scope,storeId:'foreign'},id,x.input)).status,'unavailable');
 assert.equal((await x.f.db.prepare('SELECT count(*) n FROM ai_answer').first<any>()).n,1);
 assert.equal((await x.f.db.prepare('SELECT count(*) n FROM send_intent').first<any>()).n,0);
 await assert.rejects(x.f.db.prepare("UPDATE ai_answer SET body='replaced'").run());await assert.rejects(x.f.db.prepare('DELETE FROM ai_answer').run());
 const reviewed=await m.reviewAiAnswer(x.env,x.read,x.scope,id);assert.equal(reviewed?.body,x.input.body);assert.deepEqual(reviewed?.citations,x.input.citations);
 assert.ok(await withdrawKnowledge(x.f.db,x.actor,x.documentId,2));assert.equal(await m.reviewAiAnswer(x.env,x.read,x.scope,id),null);
 assert.equal((await m.submitAiAnswer(x.env,x.read,x.scope,id,x.input)).status,'unavailable');
});
test('answer submission rejects invented citations, authority, invalid text, stale runs and races',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);const id=x.run.request.runId;
 for(const input of [{...x.input,citations:[]},{...x.input,citations:['a'.repeat(64)]},{...x.input,citations:[...x.input.citations,...x.input.citations]},{...x.input,storeId:'foreign'},{...x.input,body:' '},{...x.input,body:'x'.repeat(1001)}])assert.equal((await m.submitAiAnswer(x.env,x.read,x.scope,id,input)).status,'unavailable');
 assert.equal((await m.submitAiAnswer({...x.env,AI_RECEPTION_ENABLED:'false'},x.read,x.scope,id,x.input)).status,'unavailable');
 const read:AiRunReader=async(s,r)=>{const result=await x.read(s,r);await x.f.db.prepare("UPDATE conversation SET message_sequence=message_sequence+1 WHERE id='conv'").run();return result;};
 assert.equal((await m.submitAiAnswer(x.env,read,x.scope,id,x.input)).status,'unavailable');assert.equal((await x.f.db.prepare('SELECT count(*) n FROM ai_answer').first<any>()).n,0);
});
test('only the new answer version can submit and concurrent callers cannot replace a draft',{timeout:30000},async t=>{
 const m=await api(),old=await fixture('support-knowledge-v1');t.after(old.f.close);
 assert.equal((await m.submitAiAnswer(old.env,old.read,old.scope,old.run.request.runId,old.input)).status,'unavailable');
 const x=await fixture();t.after(x.f.close);const id=x.run.request.runId;
 const values=await Promise.all([x.input,{...x.input,body:'Другой черновик.'}].map(input=>m.submitAiAnswer(x.env,x.read,x.scope,id,input)));
 assert.deepEqual(values.map(r=>r.status).sort(),['conflict','submitted']);
 const before=await m.reviewAiAnswer(x.env,x.read,x.scope,id);assert.ok(before);
 const state=(await x.f.call('read',{},x.scope)).body.view.state;
 const taken=await x.f.call('execute',{command:{commandId:crypto.randomUUID(),action:'takeover',expectedVersion:state.version}},x.scope);assert.equal(taken.body.outcome,'accepted');
 assert.equal(await m.reviewAiAnswer(x.env,x.read,x.scope,id),null);assert.equal((await m.submitAiAnswer(x.env,x.read,x.scope,id,x.input)).status,'unavailable');
});
function interceptInsert(db:D1Database,write:(statement:D1PreparedStatement)=>Promise<unknown>):D1Database{
 return {batch:db.batch.bind(db),prepare(sql:string){const statement=db.prepare(sql);return sql.startsWith('INSERT INTO ai_answer')?{bind(...args:unknown[]){return {run:()=>write(statement.bind(...args))};}}:statement;}} as D1Database;
}
test('knowledge withdrawn immediately before the insert cannot be committed as a new draft',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);
 const db=interceptInsert(x.f.db,async statement=>{assert.ok(await withdrawKnowledge(x.f.db,x.actor,x.documentId,2));return statement.run();});
 assert.equal((await m.submitAiAnswer({...x.env,DB:db},x.read,x.scope,x.run.request.runId,x.input)).status,'unavailable');
 assert.equal((await x.f.db.prepare('SELECT count(*) n FROM ai_answer').first<any>()).n,0);
});
test('a lost commit response is explicitly uncertain and rereading the same run never creates another draft',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);
 const db=interceptInsert(x.f.db,async statement=>{await statement.run();throw new Error('synthetic lost commit response');});
 const first=await m.submitAiAnswer({...x.env,DB:db},x.read,x.scope,x.run.request.runId,x.input);assert.equal(first.status,'unconfirmed');assert.equal(first.canSend,false);
 assert.equal((await m.submitAiAnswer(x.env,x.read,x.scope,x.run.request.runId,x.input)).status,'submitted');
 assert.equal((await x.f.db.prepare('SELECT count(*) n FROM ai_answer').first<any>()).n,1);
});
test('0042 rolls back a partial migration and preserves all existing control, knowledge and financial rows',{timeout:30000},async t=>{
 const f=await conversationControlFixture('0041');t.after(f.close);
 const tables=(await f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'_cf_METADATA' ORDER BY name").all<{name:string}>()).results.map(r=>r.name);
 const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await f.db.prepare(`SELECT * FROM "${table.replaceAll('"','""')}"`).all()).results.map(row=>JSON.stringify(row)).sort()]))),before=await snapshot();
 const sql=(await readFile(new URL('../migrations/0042_ai_answer.sql',import.meta.url),'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);
 await assert.rejects(f.db.batch([...sql.map(s=>f.db.prepare(s)),f.db.prepare('SELECT * FROM synthetic_missing_migration_table')]));
 assert.equal(await f.db.prepare("SELECT name FROM sqlite_master WHERE name='ai_answer'").first(),null);assert.deepEqual(await snapshot(),before);
 await f.migrateAfter('0041');assert.deepEqual(await snapshot(),before);assert.equal((await f.db.prepare('SELECT count(*) n FROM ai_answer').first<any>()).n,0);assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
});
