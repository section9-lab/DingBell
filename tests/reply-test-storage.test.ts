import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knowledgeFixture } from './fixtures/knowledge.ts';
import { seedReplyTest } from './fixtures/reply-test.ts';
import { prepareReplyTest,retrieveReplyTestKnowledge,type ReplyTestControlReader } from '../src/modules/reply-tests/service.ts';
import { readControlAccess } from '../src/modules/conversations/control-storage.ts';
import { normalizeControlState } from '../src/modules/conversations/control-state.ts';
import type { TranslationConfig } from '../src/modules/translations/types.ts';

export const config:TranslationConfig={provider:'nvidia',model:'synthetic-answer-model',modelConfigVersion:'test-model-v1',promptVersion:'test-answer-v1',maxInputTokens:10,maxOutputTokens:10,
  pricing:{version:'test-prices-v1',currency:'USD',inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:2_000_000,cacheReadMicrosPerMillion:500_000,cacheWriteMicrosPerMillion:1_500_000}};
const receipt={submissionId:'test-submission',uid:'test-incarnation',acceptedAt:'2026-10-10T12:00:00.000Z'};
const usage={input:5,output:3,cacheRead:2,cacheWrite:1};
async function api(){
  const m=await import('../src/modules/reply-tests/storage.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return null;throw error;});
  assert.equal(typeof m?.reserveReplyTest,'function','reply-test financial persistence must exist');return m!;
}
async function fixture(){
  const f=await knowledgeFixture(),actor={orgId:'company',actorUserId:'owner',sessionId:f.sqlite.prepare("SELECT id FROM session WHERE user_id='owner'").get()!.id as string};
  const seed=await seedReplyTest(f.db,actor,'store-a');await seed.source();
  const control:ReplyTestControlReader=async(scope,caller)=>{
    const access=await readControlAccess(f.db,caller,scope.conversationId);
    return access?.directory?{outcome:'found',view:{viewerMemberId:access.memberId,state:normalizeControlState(access.directory.state),projectionPending:false}}:{outcome:'not_found'};
  };
  const context=await prepareReplyTest(f.db,control,actor,seed.input),evidence=await retrieveReplyTestKnowledge(f.db,seed.index,control,actor,context,seed.embedding);
  return {...f,...seed,actor,control,context,evidence,input:{requestId:crypto.randomUUID(),budgetId:'test-budget',context,evidence}};
}
async function fund(m:Awaited<ReturnType<typeof api>>,f:Awaited<ReturnType<typeof fixture>>,limitMicros=100,maxRuns=10){
  const made=await m.createReplyTestBudget(f.db,f.actor,{id:'test-budget',startsAt:Date.now()-1000,endsAt:Date.now()+3600_000,limitMicros,maxRuns});
  assert.ok(made);assert.equal(made.enabled,false);assert.ok(await m.setReplyTestBudgetEnabled(f.db,f.actor,made.id,0,true));return made;
}
async function reserve(m:Awaited<ReturnType<typeof api>>,f:Awaited<ReturnType<typeof fixture>>){
  const result=await m.reserveReplyTest(f.db,f.control,f.actor,f.input,config);assert.equal(result.outcome,'reserved');return result.run;
}

test('reply-test reservation persists exact context, evidence, model payload and cost once, preserving the original configuration on replay',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);await fund(m,f);
  const run=await reserve(m,f);assert.equal(run.id,f.context.runId);assert.equal(run.reservedMicros,35);assert.equal(run.settlement,'held');
  assert.deepEqual(run.payload.context,f.context);assert.deepEqual(run.payload.evidence,f.evidence);assert.equal(run.payload.modelInput.question,f.context.question);
  const replay=await m.reserveReplyTest(f.db,f.control,f.actor,f.input,{...config,maxOutputTokens:99});
  assert.equal(replay.outcome,'existing');assert.deepEqual(replay.run,run);
  const budget=await m.readReplyTestBudget(f.db,f.actor,'test-budget');assert.equal(budget!.reservedMicros,35);assert.equal(budget!.admittedRuns,1);
  assert.deepEqual(await m.readReplyTestRun(f.db,f.actor,f.input.requestId,'owner'),run);
  assert.equal((await m.reserveReplyTest(f.db,f.control,f.actor,{...f.input,budgetId:'other-budget'},config)).outcome,'conflict');
  assert.equal(await f.db.prepare('SELECT count(*) AS n FROM reply_preview_run').first('n'),0);
});

test('reply-test budgets are manager scoped, initially disabled and immutable except for versioned enablement',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);
  const staff={...f.actor,actorUserId:'staff',sessionId:f.sqlite.prepare("SELECT id FROM session WHERE user_id='staff'").get()!.id as string};
  const input={id:'test-budget',startsAt:Date.now()-1000,endsAt:Date.now()+10000,limitMicros:100,maxRuns:2};
  assert.equal(await m.createReplyTestBudget(f.db,staff,input),null);
  assert.ok(await m.createReplyTestBudget(f.db,f.actor,input));
  assert.equal((await m.reserveReplyTest(f.db,f.control,f.actor,f.input,config)).outcome,'budget_unavailable');
  assert.ok(await m.setReplyTestBudgetEnabled(f.db,f.actor,input.id,0,true));
  assert.equal(await m.setReplyTestBudgetEnabled(f.db,f.actor,input.id,0,false),null);
  await assert.rejects(()=>m.createReplyTestBudget(f.db,f.actor,{...input,id:'overlap'}),/REPLY_TEST_BUDGET_OVERLAP/);
  assert.throws(()=>f.sqlite.exec("UPDATE reply_test_budget SET limit_micros=200"),/REPLY_TEST_BUDGET_IMMUTABLE/);
});

test('zero-price trial configurations still consume the bounded admitted-run quota',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);await fund(m,f,0,1);
  const free={...config,pricing:{...config.pricing,inputMicrosPerMillion:0,outputMicrosPerMillion:0,cacheReadMicrosPerMillion:0,cacheWriteMicrosPerMillion:0}};
  const first=await m.reserveReplyTest(f.db,f.control,f.actor,f.input,free);assert.equal(first.outcome,'reserved');assert.equal(first.run.reservedMicros,0);
  const context=await prepareReplyTest(f.db,f.control,f.actor,f.input.context.input),evidence=await retrieveReplyTestKnowledge(f.db,f.index,f.control,f.actor,context,f.embedding);
  assert.equal((await m.reserveReplyTest(f.db,f.control,f.actor,{...f.input,requestId:crypto.randomUUID(),context,evidence},free)).outcome,'budget_unavailable');
  assert.equal((await m.readReplyTestBudget(f.db,f.actor,'test-budget'))!.admittedRuns,1);
});

test('run insertion failure rolls back both monetary and count reservations; invalid pricing never admits a run',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);await fund(m,f);
  assert.equal((await m.reserveReplyTest(f.db,f.control,f.actor,f.input,{...config,pricing:null})).outcome,'pricing_unavailable');
  f.sqlite.exec("CREATE TRIGGER fail_reply_test BEFORE INSERT ON reply_test_run BEGIN SELECT RAISE(ABORT,'synthetic insert failure'); END");
  await assert.rejects(()=>reserve(m,f),/synthetic insert failure/);
  const budget=await m.readReplyTestBudget(f.db,f.actor,'test-budget');assert.equal(budget!.reservedMicros,0);assert.equal(budget!.admittedRuns,0);
});

test('a stored native receipt and provider permit cannot be rebound, replayed as permission or claimed after revocation',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);await fund(m,f);const run=await reserve(m,f);
  await m.bindReplyTestReceipt(f.db,f.scope,run.id,receipt);await m.bindReplyTestReceipt(f.db,f.scope,run.id,receipt);
  await assert.rejects(()=>m.bindReplyTestReceipt(f.db,f.scope,run.id,{...receipt,uid:'replacement'}),/REPLY_TEST_RECEIPT_CONFLICT/);
  assert.equal(await m.claimReplyTestProviderRequest(f.db,f.control,f.scope,run.id),true);
  assert.equal(await m.claimReplyTestProviderRequest(f.db,f.control,f.scope,run.id),false);
  assert.throws(()=>f.sqlite.exec('UPDATE reply_test_run SET provider_request_claimed_at=NULL'),/REPLY_TEST_PERMIT_IMMUTABLE/);
  f.sqlite.exec("DELETE FROM session WHERE user_id='owner'");
  assert.equal(await m.readReplyTestRun(f.db,f.actor,f.input.requestId,'owner'),null);
  assert.equal(await m.claimReplyTestProviderRequest(f.db,f.control,f.scope,run.id),false);
});

test('provider admission rechecks stopped budgets, paused policy and withdrawn knowledge',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);await fund(m,f);const run=await reserve(m,f);
  assert.ok(await m.setReplyTestBudgetEnabled(f.db,f.actor,'test-budget',1,false));
  assert.equal(await m.claimReplyTestProviderRequest(f.db,f.control,f.scope,run.id),false);
  assert.ok(await m.setReplyTestBudgetEnabled(f.db,f.actor,'test-budget',2,true));
  f.sqlite.exec('UPDATE reply_policy SET enabled=0');assert.equal(await m.claimReplyTestProviderRequest(f.db,f.control,f.scope,run.id),false);
  f.sqlite.exec('UPDATE reply_policy SET enabled=1');f.sqlite.exec('UPDATE knowledge_document SET active_revision=NULL');
  assert.equal(await m.claimReplyTestProviderRequest(f.db,f.control,f.scope,run.id),false);
  assert.equal((await m.readReplyTestBudget(f.db,f.actor,'test-budget'))!.reservedMicros,35);
});

test('new customer input blocks the original held run without refunding or rebinding it',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);await fund(m,f);const run=await reserve(m,f);
  await f.message('new-question','New request',2);
  assert.equal(await m.claimReplyTestProviderRequest(f.db,f.control,f.scope,run.id),false);
  assert.equal((await m.readReplyTestRun(f.db,f.actor,f.input.requestId,'owner'))!.payload.context.inputRevision,1);
  assert.equal((await m.readReplyTestBudget(f.db,f.actor,'test-budget'))!.reservedMicros,35);
});

test('only closed zero-request proof releases held funds; unknown attempted calls retain the reservation',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);await fund(m,f);const run=await reserve(m,f);
  const proof={kind:'execution_closed_without_provider_request' as const,evidenceId:crypto.randomUUID(),instanceId:`reply-test:${run.id}`,verifiedAt:Date.now(),providerRequests:0 as const,executionClosed:true as const};
  await assert.rejects(()=>m.releaseUnstartedReplyTest(f.db,f.scope,run.id,{...proof,instanceId:'wrong'}));
  await m.releaseUnstartedReplyTest(f.db,f.scope,run.id,proof);await m.releaseUnstartedReplyTest(f.db,f.scope,run.id,proof);
  assert.equal(await m.claimReplyTestProviderRequest(f.db,f.control,f.scope,run.id),false);
  const budget=await m.readReplyTestBudget(f.db,f.actor,'test-budget');assert.equal(budget!.reservedMicros,0);assert.equal(budget!.spentMicros,0);assert.equal(budget!.admittedRuns,1);
  await assert.rejects(()=>m.bindReplyTestReceipt(f.db,f.scope,run.id,receipt),/REPLY_TEST_SETTLEMENT_CONFLICT/);
});

test('actual usage settles once under the original receipt, even if permission is later lost or costs exceed the reservation',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);await fund(m,f,35);const run=await reserve(m,f);
  await m.bindReplyTestReceipt(f.db,f.scope,run.id,receipt);
  await assert.rejects(()=>m.settleReplyTestUsage(f.db,f.scope,run.id,receipt,usage),/REPLY_TEST_SETTLEMENT_CONFLICT/);
  assert.equal(await m.claimReplyTestProviderRequest(f.db,f.control,f.scope,run.id),true);
  const proof={kind:'execution_closed_without_provider_request' as const,evidenceId:crypto.randomUUID(),instanceId:`reply-test:${run.id}`,verifiedAt:Date.now(),providerRequests:0 as const,executionClosed:true as const};
  await assert.rejects(()=>m.releaseUnstartedReplyTest(f.db,f.scope,run.id,proof),/REPLY_TEST_SETTLEMENT_CONFLICT/);
  f.sqlite.exec("DELETE FROM session WHERE user_id='owner'");
  const actual={...usage,output:30};await m.settleReplyTestUsage(f.db,f.scope,run.id,receipt,actual);await m.settleReplyTestUsage(f.db,f.scope,run.id,receipt,actual);
  await assert.rejects(()=>m.settleReplyTestUsage(f.db,f.scope,run.id,receipt,usage),/REPLY_TEST_SETTLEMENT_CONFLICT/);
  assert.deepEqual({...f.sqlite.prepare('SELECT reserved_micros,spent_micros FROM reply_test_budget').get()},{reserved_micros:0,spent_micros:68});
  assert.throws(()=>f.sqlite.exec("UPDATE reply_test_run SET payload='{}'"),/REPLY_TEST_RUN_IMMUTABLE/);
});

test('released financial rows require an explicit zero charge, not a NULL SQL truth value',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);await fund(m,f);await reserve(m,f);
  assert.throws(()=>f.sqlite.exec("UPDATE reply_test_run SET settlement='released',settled_at=created_at,release_evidence='{}'"),/reply_test_settlement_valid/);
});

test('admission snapshots caller-owned input before asynchronous context checks',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);await fund(m,f);
  const input=structuredClone(f.input);let reads=0;
  const control:ReplyTestControlReader=async(...args)=>{const value=await f.control(...args);if(++reads===2)input.context.question='Changed by the caller during I/O';return value;};
  const result=await m.reserveReplyTest(f.db,control,f.actor,input,config);assert.equal(result.outcome,'reserved');
  assert.equal(result.run.payload.context.question,f.context.question);assert.equal(result.run.payload.modelInput.question,f.context.question);
  assert.equal(input.context.question,'Changed by the caller during I/O');
});
