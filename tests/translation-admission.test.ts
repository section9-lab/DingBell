import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { nvidiaProvider } from '@earendil-works/pi-ai/providers/nvidia';
import { readTranslationDeploymentConfig } from '../src/modules/translations/deployment-config.ts';
import { estimateTranslationReservation } from '../src/modules/translations/config.ts';
import { PREVIEW_MODEL,PREVIEW_MODEL_VERSION,PREVIEW_PROMPT_VERSION } from '../src/modules/translations/policy.ts';
import { admitTranslationPreview,createTranslationBudget,readTranslationBudget,setTranslationBudgetEnabled } from '../src/modules/translations/storage.ts';
import type { TranslationActor,TranslationConfig,TranslationInput } from '../src/modules/translations/types.ts';

const contextWindow=nvidiaProvider().getModels().find(model=>model.id===PREVIEW_MODEL)!.contextWindow;
const config:TranslationConfig={provider:'nvidia',model:PREVIEW_MODEL,modelConfigVersion:PREVIEW_MODEL_VERSION,promptVersion:PREVIEW_PROMPT_VERSION,maxInputTokens:contextWindow,maxOutputTokens:512,
  pricing:{version:'reviewed-price',currency:'USD',inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:2_000_000,cacheReadMicrosPerMillion:500_000,cacheWriteMicrosPerMillion:1_500_000}};
const env={TRANSLATION_ENABLED:'true',TRANSLATION_CONFIG_JSON:JSON.stringify(config)};
const actor:TranslationActor={orgId:'org',actorUserId:'staff',sessionId:'staff-session'},manager:TranslationActor={orgId:'org',actorUserId:'owner',sessionId:'owner-session'};
const input:Omit<TranslationInput,'budgetId'>={requestId:'request',storeId:'store',conversationId:'conv',expectedMemberId:'staff-member',source:'  请确认尺寸。\r\n谢谢。 ',sourceRevision:3};

test('deployment translation configuration is default closed and requires every explicitly reviewed price',()=>{
  for(const value of [{},{...env,TRANSLATION_ENABLED:'false'},{...env,TRANSLATION_ENABLED:'TRUE'},{...env,TRANSLATION_CONFIG_JSON:undefined},{...env,TRANSLATION_CONFIG_JSON:'{'}])assert.equal(readTranslationDeploymentConfig(value),null);
  for(const field of ['inputMicrosPerMillion','outputMicrosPerMillion','cacheReadMicrosPerMillion','cacheWriteMicrosPerMillion'] as const){
    const pricing={...config.pricing,[field]:undefined};assert.equal(readTranslationDeploymentConfig({...env,TRANSLATION_CONFIG_JSON:JSON.stringify({...config,pricing})}),null);
  }
  const accepted=readTranslationDeploymentConfig(env);assert.deepEqual(accepted,config);assert.ok(Object.isFrozen(accepted));assert.ok(Object.isFrozen(accepted?.pricing));
  const explicitlyZero={...config,pricing:{...config.pricing,inputMicrosPerMillion:0,outputMicrosPerMillion:0,cacheReadMicrosPerMillion:0,cacheWriteMicrosPerMillion:0}};
  assert.deepEqual(readTranslationDeploymentConfig({...env,TRANSLATION_CONFIG_JSON:JSON.stringify(explicitlyZero)}),explicitlyZero);
});
test('deployment translation configuration rejects unsupported versions and a partial input context envelope before admission',()=>{
  for(const change of [{model:'unreviewed'},{modelConfigVersion:'other'},{promptVersion:'other'},{provider:'other'},{maxInputTokens:contextWindow-1},{maxOutputTokens:0},{maxOutputTokens:513},{unexpected:true}])
    assert.equal(readTranslationDeploymentConfig({...env,TRANSLATION_CONFIG_JSON:JSON.stringify({...config,...change})}),null);
  assert.ok(readTranslationDeploymentConfig({...env,TRANSLATION_CONFIG_JSON:JSON.stringify({...config,maxOutputTokens:1})}));
});

async function fixture(){
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("translation admission fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  try{
    const db=await mf.getD1Database('DB') as unknown as D1Database,folder=new URL('../migrations/',import.meta.url);
    for(const file of readdirSync(folder).filter(name=>name.endsWith('.sql')).sort())for(const sql of readFileSync(new URL(file,folder),'utf8').split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean))await db.prepare(sql).run();
    await db.batch([
      db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES ('org','Org','org',1),('other','Other','other',1)"),
      db.prepare("INSERT INTO user(id,name,email,email_verified) VALUES ('owner','Owner','owner@example.invalid',1),('staff','Staff','staff@example.invalid',1)"),
      db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('owner-member','org','owner','owner',1),('staff-member','org','staff','member',1)"),
      db.prepare("INSERT INTO session(id,user_id,token,expires_at,updated_at) VALUES ('owner-session','owner','owner-token',?,1),('staff-session','staff','staff-token',?,1)").bind(Date.now()+120_000,Date.now()+120_000),
      db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES ('store','org','Store','1','paused',1,1),('store-2','org','Second','2','paused',1,1)"),
      db.prepare("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES ('org','store','staff-member',1),('org','store-2','staff-member',1)"),
      db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES ('conv','org','store','chat','BUYER_SELLER','Opened',1,1),('conv-2','org','store-2','chat-2','BUYER_SELLER','Opened',1,1)"),
    ]);
    return {db,close:()=>mf.dispose()};
  }catch(error){await mf.dispose().catch(()=>{});throw error;}
}
async function fund(db:D1Database,id='budget',startsAt=Date.now()-1_000,endsAt=Date.now()+60_000){
  assert.ok(await createTranslationBudget(db,manager,{id,startsAt,endsAt,limitMicros:100_000_000}));assert.ok(await setTranslationBudgetEnabled(db,manager,id,0,true));
}
test('admission chooses the current server-owned budget and reserves one exact request only once',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const now=Date.now();await fund(f.db,'expired',now-3_000,now-2_000);await fund(f.db,'budget',now-1_000,now+60_000);await fund(f.db,'future',now+60_000,now+120_000);
    const results=await Promise.all([admitTranslationPreview(f.db,actor,input,env),admitTranslationPreview(f.db,actor,input,env)]);
    assert.deepEqual(results.map(value=>value.outcome).sort(),['existing','reserved']);
    for(const result of results){assert.ok('run' in result);assert.equal(result.run.budgetId,'budget');assert.equal(result.run.source,input.source);}
    assert.equal((await readTranslationBudget(f.db,manager,'budget'))?.reservedMicros,estimateTranslationReservation(config));
    assert.equal((await readTranslationBudget(f.db,manager,'expired'))?.reservedMicros,0);assert.equal((await readTranslationBudget(f.db,manager,'future'))?.reservedMicros,0);
    assert.equal((await admitTranslationPreview(f.db,actor,{...input,source:input.source.trim()},env)).outcome,'conflict');
  }finally{await f.close();}
});
test('admission replays frozen requests before reading changed deployment settings or disabled budgets',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db);const created=await admitTranslationPreview(f.db,actor,input,env);assert.ok('run' in created);
    await setTranslationBudgetEnabled(f.db,manager,'budget',1,false);
    for(const changed of [{},{TRANSLATION_ENABLED:'false'},{TRANSLATION_ENABLED:'true',TRANSLATION_CONFIG_JSON:'{'},{...env,TRANSLATION_CONFIG_JSON:JSON.stringify({...config,pricing:{...config.pricing,version:'new-price',outputMicrosPerMillion:9}})}]){
      const replay=await admitTranslationPreview(f.db,actor,input,changed);assert.equal(replay.outcome,'existing');assert.ok('run' in replay);assert.deepEqual(replay.run,created.run);
    }
    assert.equal((await admitTranslationPreview(f.db,actor,{...input,sourceRevision:4},{})).outcome,'conflict');
    assert.equal((await admitTranslationPreview(f.db,actor,{...input,storeId:'store-2',conversationId:'conv-2'},{})).outcome,'conflict');
    await f.db.prepare("DELETE FROM member WHERE id='staff-member'").run();
    await f.db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('new-member','org','staff','admin',1)").run();
    assert.equal((await admitTranslationPreview(f.db,actor,input,env)).outcome,'not_found');
    assert.equal((await admitTranslationPreview(f.db,actor,{...input,expectedMemberId:'new-member'},env)).outcome,'conflict');
  }finally{await f.close();}
});
test('admission fails closed before reservation for disabled deployment, invalid config or no single current bucket',{timeout:30_000},async()=>{
  const f=await fixture();try{
    assert.equal((await admitTranslationPreview(f.db,actor,input,{})).outcome,'disabled');
    for(const bad of [{TRANSLATION_ENABLED:'true'},{...env,TRANSLATION_CONFIG_JSON:'{'},{...env,TRANSLATION_CONFIG_JSON:JSON.stringify({...config,maxInputTokens:contextWindow-1})}])
      assert.equal((await admitTranslationPreview(f.db,actor,input,bad)).outcome,'not_configured');
    assert.equal((await admitTranslationPreview(f.db,actor,input,env)).outcome,'budget_unavailable');
    await fund(f.db);
    await f.db.prepare('DROP TRIGGER translation_budget_overlap').run();
    await f.db.prepare("INSERT INTO translation_budget_bucket(id,organization_id,starts_at,ends_at,enabled,limit_micros) SELECT 'ambiguous',organization_id,starts_at,ends_at,1,limit_micros FROM translation_budget_bucket WHERE id='budget'").run();
    assert.equal((await admitTranslationPreview(f.db,actor,input,env)).outcome,'budget_unavailable');
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM reply_preview_run').first('n'),0);
    assert.equal(await f.db.prepare('SELECT SUM(reserved_micros) AS n FROM translation_budget_bucket').first('n'),0);
    await assert.rejects(admitTranslationPreview(f.db,actor,{...input,source:''},env),/INVALID_TRANSLATION_INPUT/);
    await assert.rejects(admitTranslationPreview(f.db,actor,{...input,budgetId:'budget'} as typeof input,env),/INVALID_TRANSLATION_INPUT/);
  }finally{await f.close();}
});
test('admission retains final transactional authorization after server-side budget selection',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await fund(f.db);
    const raced=new Proxy(f.db,{get(target,key){
      if(key==='batch')return async(statements:D1PreparedStatement[])=>{await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();return target.batch(statements);};
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    assert.equal((await admitTranslationPreview(raced,actor,input,env)).outcome,'not_found');
    assert.equal((await readTranslationBudget(f.db,manager,'budget'))?.reservedMicros,0);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM reply_preview_run').first('n'),0);
    assert.equal((await admitTranslationPreview(f.db,{...actor,orgId:'other'},input,env)).outcome,'not_found');
  }finally{await f.close();}
});
