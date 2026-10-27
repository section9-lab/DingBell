import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { submitReplyPreview,readReplyPreview } from '../src/modules/translations/service.ts';
import { claimTranslationProviderRequest,createTranslationBudget,readTranslationRun,releaseUnstartedTranslation,reserveTranslation,setTranslationBudgetEnabled } from '../src/modules/translations/storage.ts';
import type { TranslationBindings } from '../src/modules/translations/bindings.ts';
import type { PreviewInspection,TranslationRuntime } from '../src/modules/translations/api-types.ts';
import type { TranslationActor,TranslationConfig,TranslationRun,TranslationReceipt } from '../src/modules/translations/types.ts';
import {repairFinancialUsage} from '../src/modules/usage-repair.ts';
const actor:TranslationActor={orgId:'org',actorUserId:'staff',sessionId:'staff-session'};
const manager:TranslationActor={orgId:'org',actorUserId:'owner',sessionId:'owner-session'};
const scope={conversationId:'conv',expectedMemberId:'staff-member'};
const config:TranslationConfig={provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'nvidia-nemotron-super-v1',promptVersion:'ru-translation-v1',maxInputTokens:262144,maxOutputTokens:512,pricing:{version:'synthetic',currency:'USD',inputMicrosPerMillion:100,outputMicrosPerMillion:200,cacheReadMicrosPerMillion:50,cacheWriteMicrosPerMillion:100}};
const usage={input:9,output:3,cacheRead:2,cacheWrite:1};
const input=()=>({requestId:crypto.randomUUID(),source:'  请确认订单。  ',sourceRevision:2});
const folder=new URL('../migrations/',import.meta.url);
const statements=(name:string)=>readFileSync(new URL(name,folder),'utf8').split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean);
async function fixture(through=Number.POSITIVE_INFINITY){
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("translation fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  try{
    const db=await mf.getD1Database('DB') as unknown as D1Database;
    const files=readdirSync(folder).filter(name=>name.endsWith('.sql')).sort();
    for(const file of files.filter(name=>Number(name.slice(0,4))<=through))for(const sql of statements(file))await db.prepare(sql).run();
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
function runtime(db:D1Database){
  const ledgers=new Map<string,PreviewInspection>(),receipts=new Map<string,TranslationReceipt>();
  let mode='success',dispatches=0,prepares=0,reads=0,providers=0,closed=0,afterRead:(()=>Promise<void>)|null=null;
  const api:TranslationRuntime={
    async lookup(id){return receipts.has(id)?{uid:receipts.get(id)!.uid}:null;},
    async inspect(id){return ledgers.get(id)??null;},
    async prepare(_scope,id){prepares++;const run=await db.prepare('SELECT request_id FROM reply_preview_run WHERE id=?').bind(id).first<string>('request_id');assert.ok(run);const value=await readTranslationRun(db,actor,{...scope,storeId:'store',requestId:run});assert.ok(value);ledgers.set(id,{run:value,generation:0,http:0,closed:false,evidence:null});},
    async dispatch(run){
      dispatches++;const previous=receipts.get(run.id);if(previous)return previous;
      const receipt={submissionId:run.id,uid:`uid-${run.id}`,acceptedAt:new Date().toISOString()};receipts.set(run.id,receipt);
      const ledger=ledgers.get(run.id)!;ledger.generation=1;
      if(!['zero','read-error-zero','pending-zero'].includes(mode)){ledger.http=1;if(await claimTranslationProviderRequest(db,{organizationId:run.organizationId,storeId:run.storeId,conversationId:run.conversationId},run.id))providers++;}
      if(mode==='lost'){mode='success';throw new Error('synthetic lost receipt');}return receipt;
    },
    async read(){reads++;await afterRead?.();if(mode==='read-error-zero')throw new Error('temporary RPC failure');if(['pending','pending-zero'].includes(mode))return {outcome:'pending'};if(['failed','zero'].includes(mode))return {outcome:'failed'};
      return {outcome:'completed',text:mode==='changed'?'Новый другой ответ.':'Подтвердите заказ.',metadata:{preview:{usageReported:mode!=='no-usage',usage:mode==='no-usage'?null:usage,outputValid:mode!=='invalid'}}};
    },
    async close(scope,id){closed++;const ledger=ledgers.get(id)!;assert.equal(ledger.http,0);ledger.closed=true;await releaseUnstartedTranslation(db,scope,id,{kind:'execution_closed_without_provider_request',evidenceId:crypto.randomUUID(),instanceId:`reply-preview:${id}`,verifiedAt:Date.now(),providerRequests:0,executionClosed:true});},
  };
  return {api,setMode:(value:string)=>{mode=value;},afterRead:(fn:(()=>Promise<void>)|null)=>{afterRead=fn;},drop:(id:string)=>{ledgers.delete(id);receipts.delete(id);},counts:()=>({dispatches,prepares,reads,providers,closed})};
}
test('reply preview service preserves authorization, immutable recovery and read-only retrieval',{timeout:90_000},async t=>{
  const f=await fixture();t.after(()=>f.close());
  await createTranslationBudget(f.db,manager,{id:'budget',startsAt:Date.now()-1000,endsAt:Date.now()+3600_000,limitMicros:1_000_000});await setTranslationBudgetEnabled(f.db,manager,'budget',0,true);
  const env:TranslationBindings={DB:f.db,FLUE_REPLY_PREVIEW_AGENT:{} as TranslationBindings['FLUE_REPLY_PREVIEW_AGENT'],NVAPI_KEY:'synthetic',TRANSLATION_ENABLED:'true',TRANSLATION_CONFIG_JSON:JSON.stringify(config)};
  const r=runtime(f.db),deps={translationRuntime:r.api};
  const readRun=(requestId:string)=>readTranslationRun(f.db,actor,{...scope,storeId:'store',requestId});
  await t.test('new submission returns only reviewed result fields and exact retry spends once',async()=>{
    const body=input(),before=r.counts();const first=await submitReplyPreview(env,actor,scope,body,deps);assert.equal(first.outcome,'found');assert.ok('preview'in first);assert.equal(first.preview.status,'ready');assert.equal(first.preview.usageStatus,'settled');
    assert.deepEqual(Object.keys(first.preview).sort(),['requestId','source','sourceRevision','targetLanguage','status','translation','reason','usageStatus'].sort());
    const replay=await submitReplyPreview({...env,TRANSLATION_CONFIG_JSON:undefined,NVAPI_KEY:undefined,TRANSLATION_ENABLED:'false'},actor,scope,body,deps);assert.deepEqual(replay,first);assert.equal(r.counts().providers-before.providers,1);assert.equal(r.counts().dispatches-before.dispatches,1);
    assert.equal((await submitReplyPreview(env,actor,scope,{...body,source:body.source.trim()},deps)).outcome,'conflict');
  });
  await t.test('ready previews cannot change after their first persisted output',async()=>{
    const body=input(),first=await submitReplyPreview(env,actor,scope,body,deps);assert.ok('preview'in first);assert.equal(first.preview.status,'ready');
    r.setMode('changed');
    try{const changed=await readReplyPreview(env,actor,scope,body.requestId,deps);assert.ok('preview'in changed);assert.equal(changed.preview.status,'unconfirmed');assert.equal(changed.preview.reason,'OUTPUT_UNCONFIRMED');assert.equal(changed.preview.translation,null);}
    finally{r.setMode('success');}
    assert.deepEqual(await readReplyPreview(env,actor,scope,body.requestId,deps),first);
  });
  await t.test('an output persistence failure cannot publish a ready preview or refund actual usage',async()=>{
    const db=new Proxy(f.db,{get(target,key){
      if(key==='prepare')return (sql:string)=>{if(/INSERT INTO reply_preview_output/.test(sql))throw new Error('synthetic output write failure');return target.prepare(sql);};
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    const body=input(),value=await submitReplyPreview({...env,DB:db},actor,scope,body,deps);assert.ok('preview'in value);
    assert.equal(value.preview.status,'unconfirmed');assert.equal(value.preview.reason,'OUTPUT_UNCONFIRMED');assert.equal(value.preview.translation,null);assert.equal(value.preview.usageStatus,'settled');
    const before=r.counts().providers,recovered=await readReplyPreview(env,actor,scope,body.requestId,deps);assert.ok('preview'in recovered);assert.equal(recovered.preview.status,'ready');assert.equal(r.counts().providers,before);
  });
  await t.test('GET never dispatches an unbound run and absent reads do not reserve',async()=>{
    const before=r.counts(),missing=await readReplyPreview(env,actor,scope,crypto.randomUUID(),deps);assert.equal(missing.outcome,'not_found');assert.deepEqual(r.counts(),before);
    r.setMode('lost');const body=input();const lost=await submitReplyPreview(env,actor,scope,body,deps);assert.ok('preview'in lost);assert.equal(lost.preview.status,'unconfirmed');
    const count=r.counts().dispatches,read=await readReplyPreview(env,actor,scope,body.requestId,deps);assert.ok('preview'in read);assert.equal(read.preview.status,'unconfirmed');assert.equal(r.counts().dispatches,count);
  });
  await t.test('original POST recovers lost receipt without reprepare even when budget and global switch are closed',async()=>{
    r.setMode('lost');const body=input();await submitReplyPreview(env,actor,scope,body,deps);const before=r.counts();
    await f.db.prepare("UPDATE translation_budget_bucket SET enabled=0 WHERE id='budget'").run();
    try{const replay=await submitReplyPreview({...env,TRANSLATION_ENABLED:'false',NVAPI_KEY:undefined,TRANSLATION_CONFIG_JSON:undefined},actor,scope,body,deps);assert.ok('preview'in replay);assert.equal(replay.preview.status,'ready');assert.equal(replay.preview.usageStatus,'settled');assert.equal(r.counts().prepares,before.prepares);assert.equal(r.counts().providers,before.providers);}
    finally{await f.db.prepare("UPDATE translation_budget_bucket SET enabled=1 WHERE id='budget'").run();}
  });
  await t.test('missing native incarnation after a claimed request remains unconfirmed and does not dispatch',async()=>{
    r.setMode('lost');const body=input();await submitReplyPreview(env,actor,scope,body,deps);const run=await readRun(body.requestId);assert.ok(run);r.drop(run.id);const before=r.counts();
    const value=await submitReplyPreview(env,actor,scope,body,deps);assert.ok('preview'in value);assert.equal(value.preview.status,'unconfirmed');assert.deepEqual(r.counts(),before);
  });
  await t.test('receipt incarnation mismatch is detected before reading any result',async()=>{
    const body=input();await submitReplyPreview(env,actor,scope,body,deps);const run=await readRun(body.requestId);assert.ok(run);r.drop(run.id);const before=r.counts().reads;
    const value=await readReplyPreview(env,actor,scope,body.requestId,deps);assert.ok('preview'in value);assert.equal(value.preview.status,'unconfirmed');assert.equal(r.counts().reads,before);
  });
  await t.test('pending retrieval stays bounded and never re-dispatches',async()=>{
    r.setMode('pending');const body=input(),value=await submitReplyPreview(env,actor,scope,body,deps);assert.ok('preview'in value);assert.equal(value.preview.status,'pending');const before=r.counts().dispatches;
    const read=await readReplyPreview(env,actor,scope,body.requestId,deps);assert.ok('preview'in read);assert.equal(read.preview.status,'pending');assert.equal(r.counts().dispatches,before);r.setMode('success');
  });
  await t.test('final SQL recheck suppresses source and translation when access disappears during native read',async()=>{
    const body=input();await submitReplyPreview(env,actor,scope,body,deps);r.afterRead(async()=>{await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();});
    try{assert.deepEqual(await readReplyPreview(env,actor,scope,body.requestId,deps),{outcome:'not_found'});}finally{r.afterRead(null);await f.db.prepare("INSERT INTO store_grant VALUES ('org','store','staff-member',1)").run();}
    assert.equal((await readReplyPreview(env,actor,{...scope,expectedMemberId:'other'},body.requestId,deps)).outcome,'not_found');
  });
  await t.test('valid output with missing usage stays held while invalid output with trusted usage is charged',async()=>{
    r.setMode('no-usage');const body=input(),value=await submitReplyPreview(env,actor,scope,body,deps);assert.ok('preview'in value);assert.equal(value.preview.status,'ready');assert.equal(value.preview.usageStatus,'held');assert.equal(value.preview.reason,'USAGE_UNCONFIRMED');
    r.setMode('invalid');const invalid=await submitReplyPreview(env,actor,scope,input(),deps);assert.ok('preview'in invalid);assert.equal(invalid.preview.status,'unavailable');assert.equal(invalid.preview.translation,null);assert.equal(invalid.preview.usageStatus,'settled');r.setMode('success');
  });
  await t.test('only a closed zero-request ledger releases; failed model requests remain held',async()=>{
    r.setMode('zero');const zero=await submitReplyPreview(env,actor,scope,input(),deps);assert.ok('preview'in zero);assert.equal(zero.preview.status,'unavailable');assert.equal(zero.preview.usageStatus,'released');
    r.setMode('failed');const failed=await submitReplyPreview(env,actor,scope,input(),deps);assert.ok('preview'in failed);assert.equal(failed.preview.usageStatus,'held');r.setMode('success');
  });
  await t.test('a temporary result-read failure never closes a zero-request execution',async()=>{
    r.setMode('read-error-zero');const before=r.counts().closed,value=await submitReplyPreview(env,actor,scope,input(),deps);assert.ok('preview'in value);assert.equal(value.preview.status,'unconfirmed');assert.equal(value.preview.usageStatus,'held');assert.equal(r.counts().closed,before);r.setMode('success');
  });
  await t.test('new requests with missing runtime or secret reserve nothing',async()=>{
    const before=await f.db.prepare('SELECT COUNT(*) AS n FROM reply_preview_run').first('n');
    for(const fields of [{NVAPI_KEY:undefined},{FLUE_REPLY_PREVIEW_AGENT:undefined}])assert.deepEqual(await submitReplyPreview({...env,...fields},actor,scope,input(),deps),{outcome:'rejected',code:'RUNTIME_UNAVAILABLE'});
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM reply_preview_run').first('n'),before);
  });
  await t.test('default-closed deployments reject new work before checking unused model secrets',async()=>{
    const before=await f.db.prepare('SELECT COUNT(*) AS n FROM reply_preview_run').first('n');
    assert.deepEqual(await submitReplyPreview({...env,TRANSLATION_ENABLED:undefined,NVAPI_KEY:undefined},actor,scope,input(),deps),{outcome:'rejected',code:'TRANSLATION_DISABLED'});
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM reply_preview_run').first('n'),before);
  });
  await t.test('background repair releases only a receipt-bound failed ledger that proves zero requests',async()=>{
    r.setMode('pending-zero');const body=input(),submitted=await submitReplyPreview(env,actor,scope,body,deps);assert.ok('preview'in submitted);assert.equal(submitted.preview.usageStatus,'held');
    const run=await readRun(body.requestId);assert.ok(run);assert.equal(run.providerRequestClaimedAt,null);r.setMode('zero');
    await f.db.prepare("UPDATE reply_preview_run SET repair_due_at=999999999999999 WHERE settlement='held'").run();await f.db.prepare('UPDATE reply_preview_run SET repair_due_at=0 WHERE id=?').bind(run.id).run();
    await repairFinancialUsage(env,{translationRuntime:r.api});assert.equal((await readRun(body.requestId))!.settlement,'released');
  });
  await t.test('background repair settles reported usage without a reader and keeps unknown evidence scheduled',async()=>{
    r.setMode('pending');const body=input(),submitted=await submitReplyPreview(env,actor,scope,body,deps);assert.ok('preview'in submitted);assert.equal(submitted.preview.usageStatus,'held');
    const run=await readRun(body.requestId);assert.ok(run);await f.db.prepare("UPDATE reply_preview_run SET repair_due_at=999999999999999 WHERE settlement='held'").run();
    await f.db.prepare('UPDATE reply_preview_run SET repair_due_at=0 WHERE id=?').bind(run.id).run();await repairFinancialUsage(env,{translationRuntime:r.api});
    let saved=await f.db.prepare('SELECT settlement,repair_due_at AS due,repair_token AS token FROM reply_preview_run WHERE id=?').bind(run.id).first<any>();
    assert.equal(saved.settlement,'held');assert.ok(saved.due>Date.now()+240000);assert.equal(saved.token,null);
    await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();r.setMode('success');await f.db.prepare('UPDATE reply_preview_run SET repair_due_at=0 WHERE id=?').bind(run.id).run();
    await Promise.all([repairFinancialUsage(env,{translationRuntime:r.api}),repairFinancialUsage(env,{translationRuntime:r.api})]);
    saved=await f.db.prepare('SELECT settlement,charged_micros AS charged,repair_due_at AS due,repair_token AS token FROM reply_preview_run WHERE id=?').bind(run.id).first<any>();
    assert.deepEqual(saved,{settlement:'settled',charged:1,due:null,token:null});r.setMode('success');
  });
});

test('0046 schedules old held usage without replacing financial rows or immutable guards',{timeout:30000},async t=>{
  const f=await fixture(45);t.after(()=>f.close());await createTranslationBudget(f.db,manager,{id:'budget',startsAt:Date.now()-1000,endsAt:Date.now()+3600000,limitMicros:1000000});
  await setTranslationBudgetEnabled(f.db,manager,'budget',0,true);const requestId=crypto.randomUUID();
  const reserved=await reserveTranslation(f.db,actor,{requestId,storeId:'store',conversationId:'conv',expectedMemberId:'staff-member',source:'Тест',sourceRevision:0,budgetId:'budget'},config);assert.equal(reserved.outcome,'reserved');
  const before=await f.db.prepare('SELECT * FROM reply_preview_run WHERE request_id=?').bind(requestId).first<any>();
  const migration=statements('0046_usage_repair.sql');await assert.rejects(()=>f.db.batch([...migration,'SELECT * FROM missing_usage_repair_table'].map(sql=>f.db.prepare(sql))));
  assert.equal((await f.db.prepare("PRAGMA table_info('reply_preview_run')").all<{name:string}>()).results.some(row=>row.name==='repair_due_at'),false);
  await f.db.batch(migration.map(sql=>f.db.prepare(sql)));const after=await f.db.prepare('SELECT * FROM reply_preview_run WHERE request_id=?').bind(requestId).first<any>();
  assert.equal(after.repair_due_at,0);assert.equal(after.repair_token,null);delete after.repair_due_at;delete after.repair_token;assert.deepEqual(after,before);
  const guards=(await f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'reply_preview_%' ORDER BY name").all<{name:string}>()).results.map(row=>row.name);
  assert.ok(guards.includes('reply_preview_run_immutable'));assert.ok(guards.includes('reply_preview_settlement_immutable'));assert.ok(guards.includes('reply_preview_output_immutable'));
  assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
});
