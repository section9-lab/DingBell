import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { bindTranslationReceipt,claimTranslationProviderRequest,createTranslationBudget,readTranslationExecutionContext,readTranslationBudget,readTranslationRun,releaseUnstartedTranslation,reserveTranslation,setTranslationBudgetEnabled,settleTranslationUsage } from '../src/modules/translations/storage.ts';
import * as outputStorage from '../src/modules/translations/storage.ts';
import type { TranslationActor,TranslationConfig,TranslationInput,TranslationReceipt,TranslationRun,TranslationScope,TranslationUsage,UnstartedTranslationEvidence } from '../src/modules/translations/types.ts';

const actor:TranslationActor={orgId:'org',actorUserId:'staff',sessionId:'staff-session'};
const manager:TranslationActor={orgId:'org',actorUserId:'owner',sessionId:'owner-session'};
const scope:TranslationScope={organizationId:'org',storeId:'store',conversationId:'conv'};
const config:TranslationConfig={provider:'nvidia',model:'reviewed-model',modelConfigVersion:'model-v1',promptVersion:'prompt-v1',maxInputTokens:10,maxOutputTokens:10,
  pricing:{version:'price-v1',currency:'USD',inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:2_000_000,cacheReadMicrosPerMillion:500_000,cacheWriteMicrosPerMillion:1_500_000}};
const input:TranslationInput={requestId:'request',storeId:'store',conversationId:'conv',expectedMemberId:'staff-member',source:'  您好，三件商品还未到货。\r\n请确认。  ',sourceRevision:2,budgetId:'budget'};
const receipt:TranslationReceipt={submissionId:'submission-1',uid:'incarnation-1',acceptedAt:'2026-10-10T10:00:00.000Z'};
const usage:TranslationUsage={input:5,output:3,cacheRead:2,cacheWrite:1};
const folder=new URL('../migrations/',import.meta.url);
const statements=(name:string)=>readFileSync(new URL(name,folder),'utf8').split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean);
async function fixture(through=Number.POSITIVE_INFINITY){
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("translation fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  try{
    const db=await mf.getD1Database('DB') as unknown as D1Database;
    const files=readdirSync(folder).filter(name=>name.endsWith('.sql')).sort();
    for(const file of files.filter(name=>Number(name.slice(0,4))<=through))await db.batch(statements(file).map(sql=>db.prepare(sql)));
    await db.batch([
      db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES ('org','Org','org',1),('other','Other','other',1)"),
      db.prepare("INSERT INTO user(id,name,email,email_verified) VALUES ('owner','Owner','owner@example.invalid',1),('staff','Staff','staff@example.invalid',1)"),
      db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('owner-member','org','owner','owner',1),('staff-member','org','staff','member',1),('foreign-member','other','staff','owner',1)"),
      db.prepare("INSERT INTO session(id,user_id,token,expires_at,updated_at) VALUES ('owner-session','owner','owner-token',?,1),('staff-session','staff','staff-token',?,1)").bind(Date.now()+120_000,Date.now()+120_000),
      db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES ('store','org','Store','1','paused',1,1),('store-2','org','Store 2','2','paused',1,1),('foreign','other','Foreign','3','paused',1,1)"),
      db.prepare("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES ('org','store','staff-member',1)"),
      db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES ('conv','org','store','chat','BUYER_SELLER','Opened',1,1),('conv-2','org','store-2','chat-2','BUYER_SELLER','Opened',1,1),('foreign-conv','other','foreign','chat-3','BUYER_SELLER','Opened',1,1)"),
    ]);
    return {db,sql:files.filter(name=>name.startsWith('0016_')).flatMap(statements),close:()=>mf.dispose()};
  }catch(error){await mf.dispose().catch(()=>{});throw error;}
}
async function fund(db:D1Database,limitMicros=100,id='budget',startsAt=Date.now()-1_000,endsAt=Date.now()+86_400_000){
  const made=await createTranslationBudget(db,manager,{id,startsAt,endsAt,limitMicros});assert.ok(made);assert.equal(made.enabled,false);
  const enabled=await setTranslationBudgetEnabled(db,manager,id,0,true);assert.ok(enabled);return enabled;
}
async function reserve(db:D1Database,changes:Partial<TranslationInput>={}){
  const value=await reserveTranslation(db,actor,{...input,...changes},config);assert.equal(value.outcome,'reserved');assert.ok('run' in value);return value.run;
}
const proof=(run:TranslationRun):UnstartedTranslationEvidence=>({kind:'execution_closed_without_provider_request',evidenceId:'proof-1',instanceId:`reply-preview:${run.id}`,verifiedAt:Date.now(),providerRequests:0,executionClosed:true});

test('a completed translation freezes exact output once without changing the financial run',{timeout:30_000},async()=>{
  const f=await fixture();try{
    assert.equal(typeof outputStorage.freezeTranslationOutput,'function');
    await fund(f.db);const run=await reserve(f.db);await bindTranslationReceipt(f.db,scope,run.id,receipt);
    const before=await readTranslationRun(f.db,actor,input),text='  Здравствуйте!\r\nПроверьте три товара.  ';
    const values=await Promise.all([1,2].map(()=>outputStorage.freezeTranslationOutput(f.db,scope,run.id,receipt,text)));
    assert.deepEqual(values[0],values[1]);assert.equal(values[0]!.body,text);assert.equal(values[0]!.runId,run.id);assert.deepEqual(values[0]!.receipt,receipt);
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    assert.equal(values[0]!.bodyHash,hash);assert.ok(values[0]!.recordedAt>=run.createdAt);
    assert.deepEqual(await outputStorage.readTranslationOutput(f.db,scope,run.id),values[0]);assert.deepEqual(await readTranslationRun(f.db,actor,input),before);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM reply_preview_output').first('n'),1);
    await assert.rejects(outputStorage.freezeTranslationOutput(f.db,scope,run.id,receipt,text.trim()),/TRANSLATION_OUTPUT_CONFLICT/);
    assert.deepEqual(await outputStorage.readTranslationOutput(f.db,scope,run.id),values[0]);
  }finally{await f.close();}
});
test('competing translations preserve exactly one output and reject the other content',{timeout:30_000},async()=>{
  const f=await fixture();try{
    assert.equal(typeof outputStorage.freezeTranslationOutput,'function');
    await fund(f.db);const run=await reserve(f.db);await bindTranslationReceipt(f.db,scope,run.id,receipt);
    const results=await Promise.allSettled(['Первый ответ.','Второй ответ.'].map(text=>outputStorage.freezeTranslationOutput(f.db,scope,run.id,receipt,text)));
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);const rejected=results.find(result=>result.status==='rejected');assert.ok(rejected?.status==='rejected');assert.match(String(rejected.reason),/TRANSLATION_OUTPUT_CONFLICT/);
    const winner=results.find(result=>result.status==='fulfilled');assert.ok(winner?.status==='fulfilled');assert.deepEqual(await outputStorage.readTranslationOutput(f.db,scope,run.id),winner.value);
  }finally{await f.close();}
});
test('output freezing requires the original receipt and exact scope and rejects released or unbound runs',{timeout:30_000},async()=>{
  const f=await fixture();try{
    assert.equal(typeof outputStorage.freezeTranslationOutput,'function');
    await fund(f.db);const run=await reserve(f.db);
    await assert.rejects(outputStorage.freezeTranslationOutput(f.db,scope,run.id,receipt,'Ответ.'),/TRANSLATION_OUTPUT_UNAVAILABLE/);
    await bindTranslationReceipt(f.db,scope,run.id,receipt);
    for(const changes of [{organizationId:'other'},{storeId:'store-2'},{conversationId:'conv-2'}]){
      await assert.rejects(outputStorage.freezeTranslationOutput(f.db,{...scope,...changes},run.id,receipt,'Ответ.'),/TRANSLATION_OUTPUT_UNAVAILABLE/);
      assert.equal(await outputStorage.readTranslationOutput(f.db,{...scope,...changes},run.id),null);
    }
    await assert.rejects(outputStorage.freezeTranslationOutput(f.db,scope,run.id,{...receipt,uid:'wrong-instance'},'Ответ.'),/TRANSLATION_OUTPUT_UNAVAILABLE/);
    await releaseUnstartedTranslation(f.db,scope,run.id,proof(run));
    await assert.rejects(outputStorage.freezeTranslationOutput(f.db,scope,run.id,receipt,'Ответ.'),/TRANSLATION_OUTPUT_UNAVAILABLE/);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM reply_preview_output').first('n'),0);
  }finally{await f.close();}
});
test('an output cannot be altered through SQL replacement or refunded as an unstarted execution',{timeout:30_000},async()=>{
  const f=await fixture();try{
    assert.equal(typeof outputStorage.freezeTranslationOutput,'function');
    await fund(f.db);const run=await reserve(f.db);await bindTranslationReceipt(f.db,scope,run.id,receipt);
    const output=await outputStorage.freezeTranslationOutput(f.db,scope,run.id,receipt,'Ответ.');
    for(const field of ['body','body_hash','receipt'])await assert.rejects(f.db.prepare(`UPDATE reply_preview_output SET ${field}='changed'`).run(),/TRANSLATION_OUTPUT_IMMUTABLE/);
    await assert.rejects(f.db.prepare('UPDATE reply_preview_output SET recorded_at=recorded_at+1').run(),/TRANSLATION_OUTPUT_IMMUTABLE/);
    await assert.rejects(f.db.prepare('INSERT OR REPLACE INTO reply_preview_output SELECT run_id,body,body_hash,receipt,recorded_at+1 FROM reply_preview_output').run(),/TRANSLATION_OUTPUT_EXISTS/);
    await assert.rejects(f.db.prepare('DELETE FROM reply_preview_run WHERE id=?').bind(run.id).run(),/FOREIGN KEY/);
    const budget=await readTranslationBudget(f.db,manager,'budget');
    await assert.rejects(releaseUnstartedTranslation(f.db,scope,run.id,proof(run)),/TRANSLATION_OUTPUT_ALREADY_RECORDED/);
    assert.deepEqual(await readTranslationBudget(f.db,manager,'budget'),budget);assert.deepEqual(await outputStorage.readTranslationOutput(f.db,scope,run.id),output);
    await settleTranslationUsage(f.db,scope,run.id,receipt,usage);assert.deepEqual(await outputStorage.readTranslationOutput(f.db,scope,run.id),output);
  }finally{await f.close();}
});
test('output guards reject malformed content, receipt, hash and fractional timestamps',{timeout:30_000},async()=>{
  const f=await fixture();try{
    assert.equal(typeof outputStorage.freezeTranslationOutput,'function');
    await fund(f.db);const run=await reserve(f.db);await bindTranslationReceipt(f.db,scope,run.id,receipt);
    for(const text of ['','  ','\u0000','\ud800','я'.repeat(1001)])await assert.rejects(outputStorage.freezeTranslationOutput(f.db,scope,run.id,receipt,text),/INVALID_TRANSLATION_OUTPUT/);
    const insert=(body:string,hash:string,encoded:string,at:number)=>f.db.prepare('INSERT INTO reply_preview_output(run_id,body,body_hash,receipt,recorded_at) VALUES (?,?,?,?,?)').bind(run.id,body,hash,encoded,at).run();
    for(const [body,hash,encoded,at] of [['','a'.repeat(64),JSON.stringify(receipt),Date.now()],['Ответ.','Z'.repeat(64),JSON.stringify(receipt),Date.now()],['Ответ.','a'.repeat(64),JSON.stringify(receipt),Date.now()+0.5]] as const)await assert.rejects(insert(body,hash,encoded,at),/CHECK constraint/);
    await assert.rejects(insert('Ответ.','a'.repeat(64),JSON.stringify({...receipt,uid:'wrong'}),Date.now()),/TRANSLATION_OUTPUT_NOT_READY/);
    await assert.rejects(insert('Ответ.','a'.repeat(64),JSON.stringify(receipt),run.createdAt-1),/TRANSLATION_OUTPUT_NOT_READY/);
    await insert('Ответ.','a'.repeat(64),JSON.stringify(receipt),Date.now());
    await assert.rejects(outputStorage.readTranslationOutput(f.db,scope,run.id),/INVALID_TRANSLATION_OUTPUT/);
  }finally{await f.close();}
});
test('0018 adds frozen outputs without rewriting old data and rolls back a failed upgrade',{timeout:30_000},async()=>{
  const f=await fixture(17);try{
    const files=readdirSync(folder).filter(name=>name.startsWith('0018_')&&name.endsWith('.sql'));assert.equal(files.length,1);
    await fund(f.db);const run=await reserve(f.db);await bindTranslationReceipt(f.db,scope,run.id,receipt);
    const old=(await f.db.prepare('SELECT * FROM reply_preview_run').all()).results,budget=(await f.db.prepare('SELECT * FROM translation_budget_bucket').all()).results;
    const schema=(await f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results;
    const sql=files.flatMap(statements);
    await assert.rejects(f.db.batch([...sql.map(query=>f.db.prepare(query)),f.db.prepare('SELECT * FROM synthetic_output_migration_failure')]),/synthetic_output_migration_failure/);
    assert.deepEqual((await f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results,schema);
    await f.db.batch(sql.map(query=>f.db.prepare(query)));
    assert.deepEqual((await f.db.prepare('SELECT * FROM reply_preview_run').all()).results,old);assert.deepEqual((await f.db.prepare('SELECT * FROM translation_budget_bucket').all()).results,budget);
    const after=(await f.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results;
    for(const entry of schema)assert.deepEqual(after.find(value=>value.name===entry.name&&value.type===entry.type),entry);
    assert.equal(await f.db.prepare('PRAGMA foreign_keys').first('foreign_keys'),1);assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
    await outputStorage.freezeTranslationOutput(f.db,scope,run.id,receipt,'Ответ.');
  }finally{await f.close();}
});

test('company windows are default closed, manager scoped, immutable and changed with CAS',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const values={id:'budget',startsAt:Date.now()-1000,endsAt:Date.now()+60_000,limitMicros:100};
    assert.equal(await createTranslationBudget(f.db,actor,values),null);
    const made=await createTranslationBudget(f.db,manager,values);assert.ok(made);assert.equal(made.enabled,false);assert.equal(made.reservedMicros,0);
    assert.equal((await reserveTranslation(f.db,actor,input,config)).outcome,'budget_unavailable');
    assert.equal(await setTranslationBudgetEnabled(f.db,actor,'budget',0,true),null);
    assert.equal(await setTranslationBudgetEnabled(f.db,manager,'budget',1,true),null);
    assert.ok(await setTranslationBudgetEnabled(f.db,manager,'budget',0,true));
    assert.equal(await readTranslationBudget(f.db,{...manager,orgId:'other'},'budget'),null);
    await assert.rejects(createTranslationBudget(f.db,manager,{...values,id:'overlap'}),/TRANSLATION_BUDGET_OVERLAP/);
    await assert.rejects(f.db.prepare("UPDATE translation_budget_bucket SET limit_micros=1000 WHERE id='budget'").run(),/TRANSLATION_BUDGET_IMMUTABLE/);
  }finally{await f.close();}
});
test('concurrent last-balance reservations admit one run and never oversubscribe',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db,35);
    const values=await Promise.all([reserveTranslation(f.db,actor,input,config),reserveTranslation(f.db,actor,{...input,requestId:'other-request'},config)]);
    assert.equal(values.filter(value=>value.outcome==='reserved').length,1);assert.equal(values.filter(value=>value.outcome==='budget_unavailable').length,1);
    assert.equal((await readTranslationBudget(f.db,manager,'budget'))?.reservedMicros,35);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM reply_preview_run').first('n'),1);
    assert.equal(await f.db.prepare('SELECT commit_token FROM translation_budget_bucket').first('commit_token'),null);
  }finally{await f.close();}
});
test('same request reserves once and reuses frozen configuration while exact payload conflicts remain visible',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db);
    const results=await Promise.all([reserveTranslation(f.db,actor,input,config),reserveTranslation(f.db,actor,input,config)]);
    assert.deepEqual(results.map(value=>value.outcome).sort(),['existing','reserved']);
    assert.ok('run' in results[0]!);const run=results[0].run;assert.equal(run.source,input.source);assert.match(run.sourceHash,/^[a-f0-9]{64}$/);
    const replay=await reserveTranslation(f.db,actor,input,null);assert.equal(replay.outcome,'existing');assert.ok('run' in replay);assert.deepEqual(replay.run.config,config);assert.equal(replay.run.id,run.id);
    for(const change of [{source:input.source.trim()},{sourceRevision:3},{budgetId:'another'}])assert.equal((await reserveTranslation(f.db,actor,{...input,...change},config)).outcome,'conflict');
    assert.equal((await readTranslationBudget(f.db,manager,'budget'))?.reservedMicros,35);
  }finally{await f.close();}
});
test('fresh scope, session, verified user and exact original membership authorize both reserve and replay',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db);await reserve(f.db);
    for(const change of [{storeId:'store-2'},{conversationId:'conv-2'},{storeId:'foreign',conversationId:'foreign-conv'},{expectedMemberId:'foreign-member'}])
      assert.equal((await reserveTranslation(f.db,actor,{...input,...change},config)).outcome,'not_found');
    await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();assert.equal(await readTranslationRun(f.db,actor,input),null);
    assert.equal((await reserveTranslation(f.db,actor,input,config)).outcome,'not_found');
    await f.db.prepare("INSERT INTO store_grant VALUES ('org','store','staff-member',1)").run();
    await f.db.prepare("UPDATE user SET email_verified=0 WHERE id='staff'").run();assert.equal((await reserveTranslation(f.db,actor,input,config)).outcome,'not_found');
    await f.db.prepare("UPDATE user SET email_verified=1 WHERE id='staff'").run();
    await f.db.prepare("UPDATE session SET expires_at=1 WHERE id='staff-session'").run();assert.equal((await reserveTranslation(f.db,actor,input,config)).outcome,'not_found');
    await f.db.prepare("UPDATE session SET expires_at=? WHERE id='staff-session'").bind(Date.now()+60_000).run();
    await f.db.prepare("DELETE FROM member WHERE id='staff-member'").run();
    await f.db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('new-member','org','staff','member',1)").run();
    await f.db.prepare("INSERT INTO store_grant VALUES ('org','store','new-member',1)").run();
    assert.equal((await reserveTranslation(f.db,actor,input,config)).outcome,'not_found');
    assert.equal((await reserveTranslation(f.db,actor,{...input,expectedMemberId:'new-member'},config)).outcome,'conflict');
    assert.equal((await readTranslationBudget(f.db,manager,'budget'))?.reservedMicros,35);
    assert.equal(await f.db.prepare('SELECT actor_member_id FROM reply_preview_run').first('actor_member_id'),'staff-member');
  }finally{await f.close();}
});
test('unknown or malformed prices fail closed and a failed run insert rolls the reservation back',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db);
    for(const bad of [null,{}, {...config,pricing:null},{...config,pricing:{...config.pricing,inputMicrosPerMillion:undefined}}])assert.equal((await reserveTranslation(f.db,actor,input,bad)).outcome,'pricing_unavailable');
    await f.db.prepare("CREATE TRIGGER synthetic_translation_failure BEFORE INSERT ON reply_preview_run BEGIN SELECT RAISE(ABORT,'synthetic_translation_failure'); END").run();
    await assert.rejects(reserveTranslation(f.db,actor,input,config),/synthetic_translation_failure/);
    assert.equal((await readTranslationBudget(f.db,manager,'budget'))?.reservedMicros,0);assert.equal(await readTranslationRun(f.db,actor,input),null);
    assert.equal(await f.db.prepare('SELECT commit_token FROM translation_budget_bucket').first('commit_token'),null);
    await f.db.prepare('DROP TRIGGER synthetic_translation_failure').run();await reserve(f.db);
  }finally{await f.close();}
});
test('native receipts bind once to exact scope and cannot be replaced or inferred from missing data',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db);const run=await reserve(f.db);
    await assert.rejects(bindTranslationReceipt(f.db,{...scope,storeId:'store-2'},run.id,receipt),/TRANSLATION_RUN_NOT_FOUND/);
    await bindTranslationReceipt(f.db,scope,run.id,receipt);await bindTranslationReceipt(f.db,scope,run.id,receipt);
    await assert.rejects(bindTranslationReceipt(f.db,scope,run.id,{...receipt,uid:'other-incarnation'}),/TRANSLATION_RECEIPT_CONFLICT/);
    await assert.rejects(bindTranslationReceipt(f.db,scope,run.id,{...receipt,acceptedAt:'not-a-date'}),/INVALID_TRANSLATION/);
    assert.deepEqual((await readTranslationRun(f.db,actor,input))?.receipt,receipt);assert.equal((await readTranslationRun(f.db,actor,input))?.settlement,'held');
  }finally{await f.close();}
});
test('usage settlement is atomic, idempotent and immutable, including actual estimates above reservation',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db,70);const run=await reserve(f.db);await bindTranslationReceipt(f.db,scope,run.id,receipt);
    await f.db.prepare("CREATE TRIGGER synthetic_settlement_failure BEFORE UPDATE OF settlement ON reply_preview_run WHEN NEW.settlement='settled' BEGIN SELECT RAISE(ABORT,'synthetic_settlement_failure'); END").run();
    await assert.rejects(settleTranslationUsage(f.db,scope,run.id,receipt,usage),/synthetic_settlement_failure/);
    assert.equal((await readTranslationBudget(f.db,manager,'budget'))?.reservedMicros,35);assert.equal((await readTranslationBudget(f.db,manager,'budget'))?.spentMicros,0);
    await f.db.prepare('DROP TRIGGER synthetic_settlement_failure').run();
    await Promise.all([settleTranslationUsage(f.db,scope,run.id,receipt,usage),settleTranslationUsage(f.db,scope,run.id,receipt,usage)]);
    assert.equal((await readTranslationBudget(f.db,manager,'budget'))?.spentMicros,14);assert.equal((await readTranslationBudget(f.db,manager,'budget'))?.reservedMicros,0);
    await assert.rejects(settleTranslationUsage(f.db,scope,run.id,receipt,{...usage,output:4}),/TRANSLATION_SETTLEMENT_CONFLICT/);
    const second=await reserve(f.db,{requestId:'expensive'});await bindTranslationReceipt(f.db,scope,second.id,{...receipt,submissionId:'submission-2'});
    await settleTranslationUsage(f.db,scope,second.id,{...receipt,submissionId:'submission-2'},{input:0,output:100,cacheRead:0,cacheWrite:0});
    assert.equal((await readTranslationBudget(f.db,manager,'budget'))?.spentMicros,214);assert.equal((await reserveTranslation(f.db,actor,{...input,requestId:'cannot-afford'},config)).outcome,'budget_unavailable');
  }finally{await f.close();}
});
test('late settlement remains in the original expired disabled window and survives actor deletion',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const end=Date.now()+1_000;await fund(f.db,100,'budget',Date.now()-1000,end);const run=await reserve(f.db);await bindTranslationReceipt(f.db,scope,run.id,receipt);
    await setTranslationBudgetEnabled(f.db,manager,'budget',1,false);await f.db.prepare("DELETE FROM member WHERE id='staff-member'").run();
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,end-Date.now()+20)));
    await fund(f.db,100,'next',end,end+60_000);await settleTranslationUsage(f.db,scope,run.id,receipt,usage);
    assert.equal((await readTranslationBudget(f.db,manager,'budget'))?.spentMicros,14);assert.equal((await readTranslationBudget(f.db,manager,'next'))?.spentMicros,0);
    assert.equal(await readTranslationRun(f.db,actor,input),null);
  }finally{await f.close();}
});
test('unknown outcomes stay held; only explicit closed-zero-request evidence releases exactly once',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db);const run=await reserve(f.db);
    for(const bad of [{},{kind:'timeout'}, {...proof(run),providerRequests:1},{...proof(run),executionClosed:false},{...proof(run),instanceId:'other'}])
      await assert.rejects(releaseUnstartedTranslation(f.db,scope,run.id,bad as UnstartedTranslationEvidence),/INVALID_TRANSLATION/);
    assert.equal((await readTranslationBudget(f.db,manager,'budget'))?.reservedMicros,35);
    const evidence=proof(run);await Promise.all([releaseUnstartedTranslation(f.db,scope,run.id,evidence),releaseUnstartedTranslation(f.db,scope,run.id,evidence)]);
    assert.equal((await readTranslationBudget(f.db,manager,'budget'))?.reservedMicros,0);assert.equal((await readTranslationRun(f.db,actor,input))?.settlement,'released');
    await assert.rejects(releaseUnstartedTranslation(f.db,scope,run.id,{...evidence,evidenceId:'changed'}),/TRANSLATION_SETTLEMENT_CONFLICT/);
    await assert.rejects(bindTranslationReceipt(f.db,scope,run.id,receipt),/TRANSLATION_SETTLEMENT_CONFLICT/);
  }finally{await f.close();}
});
test('financial runs preserve original inputs and member identity and restrict destructive conversation deletion',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db);await reserve(f.db);
    await assert.rejects(f.db.prepare("UPDATE reply_preview_run SET source='changed'").run(),/TRANSLATION_RUN_IMMUTABLE/);
    await assert.rejects(f.db.prepare("UPDATE reply_preview_run SET actor_member_id='new'").run(),/TRANSLATION_RUN_IMMUTABLE/);
    await assert.rejects(f.db.prepare("DELETE FROM conversation WHERE id='conv'").run(),/FOREIGN KEY constraint/);
    assert.equal(await f.db.prepare('PRAGMA foreign_keys').first('foreign_keys'),1);assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  }finally{await f.close();}
});
test('SQL CHECK rejects a released run with a missing charge rather than accepting UNKNOWN',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db);await reserve(f.db);
    await assert.rejects(f.db.prepare("UPDATE reply_preview_run SET settlement='released',charged_micros=NULL,settled_at=created_at,release_evidence='{}'").run(),/CHECK constraint/);
  }finally{await f.close();}
});
test('SQL integer amounts, counters and timestamps do not accept SQLite REAL affinity values',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db);await reserve(f.db);
    for(const field of ['reserved_micros','spent_micros','revision'])await assert.rejects(f.db.prepare(`UPDATE translation_budget_bucket SET ${field}=1.5`).run(),/CHECK constraint/);
    await assert.rejects(f.db.prepare("UPDATE reply_preview_run SET settlement='released',charged_micros=0,settled_at=created_at+0.5,release_evidence='{}'").run(),/CHECK constraint/);
  }finally{await f.close();}
});
test('competing terminal financial facts accept only one usage or zero-request release',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db);const first=await reserve(f.db);await bindTranslationReceipt(f.db,scope,first.id,receipt);
    const costs=await Promise.allSettled([settleTranslationUsage(f.db,scope,first.id,receipt,usage),settleTranslationUsage(f.db,scope,first.id,receipt,{...usage,output:4})]);
    assert.equal(costs.filter(value=>value.status==='fulfilled').length,1);assert.equal(costs.filter(value=>value.status==='rejected').length,1);
    const firstSaved=await readTranslationRun(f.db,actor,input);assert.ok(firstSaved);assert.ok([14,16].includes(firstSaved.chargedMicros!));
    const second=await reserve(f.db,{requestId:'race'}),secondReceipt={...receipt,submissionId:'second'};await bindTranslationReceipt(f.db,scope,second.id,secondReceipt);
    const race=await Promise.allSettled([settleTranslationUsage(f.db,scope,second.id,secondReceipt,usage),releaseUnstartedTranslation(f.db,scope,second.id,proof(second))]);
    assert.equal(race.filter(value=>value.status==='fulfilled').length,1);assert.equal(race.filter(value=>value.status==='rejected').length,1);
    const secondSaved=await readTranslationRun(f.db,actor,{...input,requestId:'race'});assert.ok(secondSaved);
    const balance=await readTranslationBudget(f.db,manager,'budget');assert.ok(balance);assert.equal(balance.reservedMicros,0);assert.equal(balance.spentMicros,firstSaved.chargedMicros!+secondSaved.chargedMicros!);
  }finally{await f.close();}
});
test('0016 adds only the budget ledger and rolls back a failed upgrade without changing existing data or guards',{timeout:30_000},async()=>{
  const f=await fixture(15);try{
    await f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES ('msg','org','store','conv','18446744073709551615','Customer','inbound','[\"Привет\"]',0,0,3,4,'backfill')").run();
    await f.db.prepare("INSERT INTO conversation_control(conversation_id,organization_id,store_id,controller_id,schema_version,version,control_epoch,sequence,lifecycle,reception,updated_at,work_status,repair_due_at) VALUES ('conv','org','store','controller',2,1,1,1,'open','human',1,'needs_reply',1)").run();
    await f.db.prepare("INSERT INTO conversation_control_event(controller_id,organization_id,store_id,conversation_id,sequence,command_id,actor_user_id,actor_member_id,action,receipt,projected_at) VALUES ('controller','org','store','conv',1,'old','staff','staff-member','claim',?,1)").bind('{\n  "legacy": "immutable bytes"\n}').run();
    const oldSchema=(await f.db.prepare("SELECT type,name,sql,rootpage FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results;
    const facts=(await f.db.prepare('SELECT * FROM message').all()).results,events=(await f.db.prepare('SELECT * FROM conversation_control_event').all()).results;
    await assert.rejects(f.db.batch([...f.sql.map(sql=>f.db.prepare(sql)),f.db.prepare('SELECT * FROM synthetic_migration_failure')]),/synthetic_migration_failure/);
    assert.deepEqual((await f.db.prepare("SELECT type,name,sql,rootpage FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results,oldSchema);
    if(f.sql.length)await f.db.batch(f.sql.map(sql=>f.db.prepare(sql)));
    assert.equal(await f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('translation_budget_bucket','reply_preview_run')").first('n'),2);
    for(const object of oldSchema)assert.deepEqual(await f.db.prepare('SELECT type,name,sql,rootpage FROM sqlite_master WHERE type=? AND name=?').bind(object.type,object.name).first(),object);
    assert.deepEqual((await f.db.prepare('SELECT * FROM message').all()).results,facts);assert.deepEqual((await f.db.prepare('SELECT * FROM conversation_control_event').all()).results,events);
    await assert.rejects(f.db.prepare("UPDATE conversation_control_event SET receipt='{}'").run(),/CONTROL_EVENT_IMMUTABLE/);
    await assert.rejects(f.db.prepare("UPDATE message SET content='[]'").run(),/MESSAGE_IMMUTABLE/);
    assert.equal(await f.db.prepare('PRAGMA foreign_keys').first('foreign_keys'),1);assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  }finally{await f.close();}
});

// Preserve actual D1 execution; intercept only the last UPDATE response/race.
function beforeClaim(db:D1Database,hook:()=>Promise<void>,loseResponse=false):D1Database{
  return new Proxy(db,{get(target,key){
    if(key!=='prepare'){const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}
    return (sql:string)=>{
      const statement=target.prepare(sql);
      if(!/UPDATE reply_preview_run[\s\S]*SET provider_request_claimed_at/.test(sql))return statement;
      const wrap=(value:D1PreparedStatement):D1PreparedStatement=>new Proxy(value,{get(prepared,method){
        if(method==='bind')return (...values:unknown[])=>wrap(prepared.bind(...values));
        if(method==='first')return async(...args:Parameters<D1PreparedStatement['first']>)=>{
          await hook();const result=await prepared.first(...args);if(loseResponse)throw new Error('synthetic_claim_response_lost');return result;
        };
        const found=Reflect.get(prepared,method);return typeof found==='function'?found.bind(prepared):found;
      }});
      return wrap(statement);
    };
  }});
}

test('provider permit grants exactly once across concurrent callers and later instance reconstruction',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db,35);const saved=await reserve(f.db);
    await f.db.prepare("DELETE FROM session WHERE id='staff-session'").run();
    const context=await readTranslationExecutionContext(f.db,scope,saved.id);assert.ok(context);assert.equal(context.providerRequestClaimedAt,null);
    assert.equal(context.actorMemberId,'staff-member');assert.deepEqual(context.config,config);
    const claims=await Promise.all([claimTranslationProviderRequest(f.db,scope,saved.id),claimTranslationProviderRequest(f.db,scope,saved.id)]);
    assert.deepEqual(claims.sort(),[false,true]);
    const recovered=await readTranslationExecutionContext(f.db,scope,saved.id);assert.ok(recovered);assert.ok(recovered.providerRequestClaimedAt!>=saved.createdAt);
    // A replacement native instance has only the durable run, never a reusable grant.
    assert.equal(await claimTranslationProviderRequest(f.db,scope,recovered.id),false);
    assert.equal((await readTranslationBudget(f.db,manager,'budget'))?.reservedMicros,35);
    await bindTranslationReceipt(f.db,scope,saved.id,receipt);await settleTranslationUsage(f.db,scope,saved.id,receipt,usage);
    await settleTranslationUsage(f.db,scope,saved.id,receipt,usage);
    assert.equal(await readTranslationExecutionContext(f.db,scope,saved.id),null);assert.equal(await claimTranslationProviderRequest(f.db,scope,saved.id),false);
  }finally{await f.close();}
});
test('provider permit response loss never recreates an HTTP grant from a later read',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db);const saved=await reserve(f.db);
    await assert.rejects(claimTranslationProviderRequest(beforeClaim(f.db,async()=>{},true),scope,saved.id),/synthetic_claim_response_lost/);
    const recovered=await readTranslationExecutionContext(f.db,scope,saved.id);assert.ok(recovered?.providerRequestClaimedAt);
    assert.equal(await claimTranslationProviderRequest(f.db,scope,saved.id),false);
    await assert.rejects(releaseUnstartedTranslation(f.db,scope,saved.id,proof(saved)),/TRANSLATION_SETTLEMENT_CONFLICT/);
    assert.equal(recovered.settlement,'held');assert.equal((await readTranslationBudget(f.db,manager,'budget'))?.reservedMicros,35);
  }finally{await f.close();}
});
test('provider permit final authorization preserves original member identity without a browser session',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db);const saved=await reserve(f.db);
    for(const other of [{...scope,organizationId:'other'},{...scope,storeId:'store-2'},{...scope,conversationId:'conv-2'}]){
      assert.equal(await readTranslationExecutionContext(f.db,other,saved.id),null);assert.equal(await claimTranslationProviderRequest(f.db,other,saved.id),false);
    }
    await f.db.prepare("UPDATE user SET email_verified=0 WHERE id='staff'").run();assert.equal(await readTranslationExecutionContext(f.db,scope,saved.id),null);
    assert.equal(await claimTranslationProviderRequest(f.db,scope,saved.id),false);await f.db.prepare("UPDATE user SET email_verified=1 WHERE id='staff'").run();
    assert.ok(await readTranslationExecutionContext(f.db,scope,saved.id));
    assert.equal(await claimTranslationProviderRequest(beforeClaim(f.db,async()=>{await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();}),scope,saved.id),false);
    assert.equal(await readTranslationExecutionContext(f.db,scope,saved.id),null);
    await f.db.prepare("UPDATE member SET role='admin' WHERE id='staff-member'").run();assert.ok(await readTranslationExecutionContext(f.db,scope,saved.id));
    await f.db.prepare("DELETE FROM member WHERE id='staff-member'").run();
    await f.db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('replacement-member','org','staff','admin',1)").run();
    assert.equal(await readTranslationExecutionContext(f.db,scope,saved.id),null);assert.equal(await claimTranslationProviderRequest(f.db,scope,saved.id),false);
    await assert.rejects(readTranslationExecutionContext(f.db,{...scope,storeId:''},saved.id),/INVALID_TRANSLATION_SCOPE/);
  }finally{await f.close();}
});
test('provider permit final budget gate blocks shutdown or an actual overrun without refunding held runs',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db,70);const first=await reserve(f.db),second=await reserve(f.db,{requestId:'second'});
    assert.equal(await claimTranslationProviderRequest(beforeClaim(f.db,async()=>{await setTranslationBudgetEnabled(f.db,manager,'budget',1,false);}),scope,second.id),false);
    assert.equal(await readTranslationExecutionContext(f.db,scope,second.id),null);
    await setTranslationBudgetEnabled(f.db,manager,'budget',2,true);
    assert.equal(await claimTranslationProviderRequest(f.db,scope,first.id),true);await bindTranslationReceipt(f.db,scope,first.id,receipt);
    assert.equal(await claimTranslationProviderRequest(beforeClaim(f.db,async()=>{await settleTranslationUsage(f.db,scope,first.id,receipt,{input:0,output:100,cacheRead:0,cacheWrite:0});}),scope,second.id),false);
    assert.equal(await readTranslationExecutionContext(f.db,scope,second.id),null);
    const balance=await readTranslationBudget(f.db,manager,'budget');assert.ok(balance);assert.equal(balance.reservedMicros,35);assert.equal(balance.spentMicros,200);
    assert.equal((await readTranslationRun(f.db,actor,{...input,requestId:'second'}))?.settlement,'held');
  }finally{await f.close();}
});
test('provider permit uses the held original bucket after its admission window closes without another reservation',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const end=Date.now()+1_000;await fund(f.db,35,'budget',Date.now()-1_000,end);const saved=await reserve(f.db);
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,end-Date.now()+20)));
    await fund(f.db,100,'next',end,end+60_000);
    assert.equal(await claimTranslationProviderRequest(f.db,scope,saved.id),true);
    assert.equal((await readTranslationBudget(f.db,manager,'budget'))?.reservedMicros,35);assert.equal((await readTranslationBudget(f.db,manager,'next'))?.reservedMicros,0);
  }finally{await f.close();}
});
test('provider permit validates frozen pricing and reservation rather than trusting syntactically valid JSON',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db,100);await reserve(f.db);
    for(const [runId,frozen,reserved] of [['wrong-estimate',JSON.stringify(config),34],['unknown-price',JSON.stringify({...config,pricing:null}),35]] as const){
      await f.db.prepare(`INSERT INTO reply_preview_run(id,organization_id,store_id,conversation_id,request_id,actor_user_id,actor_member_id,source,source_hash,source_revision,budget_id,config,reserved_micros,created_at)
        SELECT ?,organization_id,store_id,conversation_id,?,actor_user_id,actor_member_id,source,source_hash,source_revision,budget_id,?,?,created_at FROM reply_preview_run WHERE request_id='request'`).bind(runId,runId,frozen,reserved).run();
      assert.equal(await readTranslationExecutionContext(f.db,scope,runId),null);assert.equal(await claimTranslationProviderRequest(f.db,scope,runId),false);
    }
  }finally{await f.close();}
});
test('provider permit and proven zero-request release compete atomically for one terminal decision',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db);const saved=await reserve(f.db);
    const [claimed,released]=await Promise.allSettled([claimTranslationProviderRequest(f.db,scope,saved.id),releaseUnstartedTranslation(f.db,scope,saved.id,proof(saved))]);
    assert.equal(claimed.status,'fulfilled');assert.ok(claimed.status==='fulfilled');
    const current=await readTranslationRun(f.db,actor,input);assert.ok(current);
    if(claimed.value){assert.equal(released.status,'rejected');assert.equal(current.settlement,'held');assert.ok(current.providerRequestClaimedAt);}
    else {assert.equal(released.status,'fulfilled');assert.equal(current.settlement,'released');assert.equal(current.providerRequestClaimedAt,null);}
    assert.equal(await claimTranslationProviderRequest(f.db,scope,saved.id),false);
    assert.equal((await readTranslationBudget(f.db,manager,'budget'))?.reservedMicros,claimed.value?35:0);
  }finally{await f.close();}
});
test('provider permit timestamps are valid immutable markers and cannot coexist with a refunded run',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db);const saved=await reserve(f.db);
    for(const invalid of [1.5,saved.createdAt-1,8_640_000_000_000_001])await assert.rejects(f.db.prepare('UPDATE reply_preview_run SET provider_request_claimed_at=?').bind(invalid).run(),/CHECK constraint/);
    assert.equal(await claimTranslationProviderRequest(f.db,scope,saved.id),true);
    for(const expression of ['NULL','provider_request_claimed_at+1'])await assert.rejects(f.db.prepare(`UPDATE reply_preview_run SET provider_request_claimed_at=${expression}`).run(),/TRANSLATION_PROVIDER_PERMIT_IMMUTABLE/);
    await assert.rejects(f.db.prepare("UPDATE reply_preview_run SET settlement='released',charged_micros=0,settled_at=created_at,release_evidence='{}'").run(),/CHECK constraint/);
  }finally{await f.close();}
});
test('0017 provider permit upgrade preserves old financial facts, receipts, indexes and foreign-key guards',{timeout:30_000},async()=>{
  const f=await fixture(16);try{
    await fund(f.db);
    const receiptBytes='{\n "submissionId":"legacy", "uid":"old-native", "acceptedAt":"2026-10-10T00:00:00.000Z"\n}';
    await f.db.prepare(`INSERT INTO reply_preview_run(id,organization_id,store_id,conversation_id,request_id,actor_user_id,actor_member_id,source,source_hash,source_revision,budget_id,config,reserved_micros,created_at,receipt)
      VALUES ('old','org','store','conv','old-request','staff','staff-member',?,?,2,'budget',?,35,1,?)`).bind(input.source,'a'.repeat(64),JSON.stringify(config),receiptBytes).run();
    await f.db.prepare("UPDATE translation_budget_bucket SET reserved_micros=35 WHERE id='budget'").run();
    const before=await f.db.prepare('SELECT * FROM reply_preview_run').first();assert.ok(before);
    const objects=(await f.db.prepare("SELECT type,name,sql,rootpage FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name<>'reply_preview_run' ORDER BY type,name").all()).results;
    const sql=readdirSync(folder).filter(name=>name.startsWith('0017_')).flatMap(statements);assert.ok(sql.length>0,'0017 must add a durable permit');
    await assert.rejects(f.db.batch([...sql.map(value=>f.db.prepare(value)),f.db.prepare('SELECT * FROM synthetic_permit_migration_failure')]),/synthetic_permit_migration_failure/);
    assert.deepEqual(await f.db.prepare('SELECT * FROM reply_preview_run').first(),before);
    await f.db.batch(sql.map(value=>f.db.prepare(value)));
    const after=await f.db.prepare('SELECT * FROM reply_preview_run').first();assert.ok(after);assert.equal(after.provider_request_claimed_at,null);
    delete after.provider_request_claimed_at;assert.deepEqual(after,before);
    for(const object of objects)assert.deepEqual(await f.db.prepare('SELECT type,name,sql,rootpage FROM sqlite_master WHERE type=? AND name=?').bind(object.type,object.name).first(),object);
    assert.equal(await claimTranslationProviderRequest(f.db,scope,'old'),true);assert.equal(await claimTranslationProviderRequest(f.db,scope,'old'),false);
    assert.equal(await f.db.prepare("SELECT receipt FROM reply_preview_run WHERE id='old'").first('receipt'),receiptBytes);
    await assert.rejects(f.db.prepare("UPDATE reply_preview_run SET config='{}'").run(),/TRANSLATION_RUN_IMMUTABLE/);
    await assert.rejects(f.db.prepare("UPDATE reply_preview_run SET receipt='{}'").run(),/TRANSLATION_RECEIPT_CONFLICT/);
    await assert.rejects(f.db.prepare("DELETE FROM conversation WHERE id='conv'").run(),/FOREIGN KEY constraint/);
    assert.equal(await f.db.prepare('PRAGMA foreign_keys').first('foreign_keys'),1);assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  }finally{await f.close();}
});
