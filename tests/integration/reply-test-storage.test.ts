import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationControlFixture } from '../fixtures/conversation-control.ts';
import { seedReplyTest } from '../fixtures/reply-test.ts';
import { prepareReplyTest,retrieveReplyTestKnowledge,type ReplyTestControlReader } from '../../src/modules/reply-tests/service.ts';
import * as runs from '../../src/modules/reply-tests/storage.ts';
import { createTranslationBudget,setTranslationBudgetEnabled,reserveTranslation,readTranslationRun,readTranslationBudget } from '../../src/modules/translations/storage.ts';
import type { TranslationConfig } from '../../src/modules/translations/types.ts';

const config:TranslationConfig={provider:'nvidia',model:'synthetic-answer-model',modelConfigVersion:'test-model-v1',promptVersion:'test-answer-v1',maxInputTokens:10,maxOutputTokens:10,
  pricing:{version:'test-prices-v1',currency:'USD',inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:2_000_000,cacheReadMicrosPerMillion:500_000,cacheWriteMicrosPerMillion:1_500_000}};
async function setup(f:Awaited<ReturnType<typeof conversationControlFixture>>,limit=35){
  const seed=await seedReplyTest(f.db,f.actor(),'store','conv');await seed.source();
  const control:ReplyTestControlReader=async(scope,actor)=>(await f.call('read',{actor},scope)).body;
  assert.ok(await runs.createReplyTestBudget(f.db,f.actor(),{id:'answer-budget',startsAt:Date.now()-1000,endsAt:Date.now()+3600_000,limitMicros:limit,maxRuns:10}));
  assert.ok(await runs.setReplyTestBudgetEnabled(f.db,f.actor(),'answer-budget',0,true));
  const input=async()=>{
    const context=await prepareReplyTest(f.db,control,f.actor(),seed.input),evidence=await retrieveReplyTestKnowledge(f.db,seed.index,control,f.actor(),context,seed.embedding);
    return {requestId:crypto.randomUUID(),budgetId:'answer-budget',context,evidence};
  };
  return {...seed,control,input};
}

test('0029 preserves held translation costs while concurrent answer admissions reserve the last balance once',{timeout:30_000},async t=>{
  const f=await conversationControlFixture('0028');t.after(()=>f.close());
  assert.ok(await createTranslationBudget(f.db,f.actor(),{id:'old-budget',startsAt:Date.now()-1000,endsAt:Date.now()+3600_000,limitMicros:100}));
  assert.ok(await setTranslationBudgetEnabled(f.db,f.actor(),'old-budget',0,true));
  const oldInput={requestId:'old-request',storeId:'store',conversationId:'conv',expectedMemberId:'owner-member',source:'Old translation draft',sourceRevision:1,budgetId:'old-budget'};
  const old=await reserveTranslation(f.db,f.actor(),oldInput,config);assert.equal(old.outcome,'reserved');
  const previous=await readTranslationRun(f.db,f.actor(),oldInput),beforeBudget=await readTranslationBudget(f.db,f.actor(),'old-budget');
  await f.migrateAfter('0028');
  const setupResult=await setup(f),inputs=await Promise.all(Array.from({length:6},()=>setupResult.input()));
  const results=await Promise.all(inputs.map(input=>runs.reserveReplyTest(f.db,setupResult.control,f.actor(),input,config)));
  assert.equal(results.filter(result=>result.outcome==='reserved').length,1);assert.equal(results.filter(result=>result.outcome==='budget_unavailable').length,5);
  const ordinal=results.findIndex(result=>result.outcome==='reserved'),winner=results[ordinal];assert.equal(winner.outcome,'reserved');
  const replay=await Promise.all(Array.from({length:6},()=>runs.reserveReplyTest(f.db,setupResult.control,f.actor(),inputs[ordinal],{...config,maxOutputTokens:100})));
  assert.ok(replay.every(result=>result.outcome==='existing'));assert.equal(await f.db.prepare('SELECT count(*) AS n FROM reply_test_run').first('n'),1);
  const budget=await runs.readReplyTestBudget(f.db,f.actor(),'answer-budget');assert.equal(budget!.reservedMicros,35);assert.equal(budget!.admittedRuns,1);
  assert.deepEqual(await readTranslationRun(f.db,f.actor(),oldInput),previous);assert.deepEqual(await readTranslationBudget(f.db,f.actor(),'old-budget'),beforeBudget);
  await f.restart();assert.deepEqual(await runs.readReplyTestRun(f.db,f.actor(),inputs[ordinal].requestId,'owner-member'),winner.run);
  assert.equal(f.providerRequests.length,0);
});

test('native concurrent provider claims issue one permission and zero-request release cannot undo that attempt',{timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const s=await setup(f),input=await s.input();
  const admitted=await runs.reserveReplyTest(f.db,s.control,f.actor(),input,config);assert.equal(admitted.outcome,'reserved');
  const results=await Promise.all(Array.from({length:8},()=>runs.claimReplyTestProviderRequest(f.db,s.control,f.scope,admitted.run.id)));
  assert.equal(results.filter(Boolean).length,1);
  const proof={kind:'execution_closed_without_provider_request' as const,evidenceId:crypto.randomUUID(),instanceId:`reply-test:${admitted.run.id}`,verifiedAt:Date.now(),providerRequests:0 as const,executionClosed:true as const};
  await assert.rejects(()=>runs.releaseUnstartedReplyTest(f.db,f.scope,admitted.run.id,proof),/REPLY_TEST_SETTLEMENT_CONFLICT/);
  assert.equal((await runs.readReplyTestBudget(f.db,f.actor(),'answer-budget'))!.reservedMicros,35);
  assert.equal(f.providerRequests.length,0);
});

test('a lost native permit response is not permission to issue another provider call after restart',{timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const s=await setup(f),input=await s.input();
  const admitted=await runs.reserveReplyTest(f.db,s.control,f.actor(),input,config);assert.equal(admitted.outcome,'reserved');
  let lost=false;
  const faulty={prepare(sql:string){
    const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(target,key){
      if(key==='bind')return (...params:unknown[])=>wrap(target.bind(...params));
      if(key==='first')return async(...args:Parameters<D1PreparedStatement['first']>)=>{
        const result=await target.first(...args);if(sql.startsWith('UPDATE reply_test_run AS run SET provider_request_claimed_at')&&!lost){lost=true;throw new Error('synthetic lost permit response');}return result;
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});return wrap(f.db.prepare(sql));
  }} as D1Database;
  await assert.rejects(()=>runs.claimReplyTestProviderRequest(faulty,s.control,f.scope,admitted.run.id),/synthetic lost permit response/);assert.equal(lost,true);
  await f.restart();assert.equal(await runs.claimReplyTestProviderRequest(f.db,s.control,f.scope,admitted.run.id),false);
  assert.equal((await runs.readReplyTestBudget(f.db,f.actor(),'answer-budget'))!.reservedMicros,35);assert.equal(f.providerRequests.length,0);
});
