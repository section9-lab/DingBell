import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knowledgeFixture } from './fixtures/knowledge.ts';
import { seedReplyTest } from './fixtures/reply-test.ts';
import { prepareReplyTest,type ReplyTestControlReader } from '../src/modules/reply-tests/service.ts';
import { createReplyTestBudget,setReplyTestBudgetEnabled } from '../src/modules/reply-tests/storage.ts';
import { readControlAccess } from '../src/modules/conversations/control-storage.ts';
import { normalizeControlState } from '../src/modules/conversations/control-state.ts';
import { knowledgeProfile } from '../src/modules/knowledge/vectorize.ts';
import { readReplyTestBudgets } from '../src/modules/reply-tests/budget-admin.ts';

const answerConfig={provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'nvidia-reply-test-v1',promptVersion:'grounded-reply-v1',maxInputTokens:262144,maxOutputTokens:2048,
  pricing:{version:'test',currency:'USD',inputMicrosPerMillion:100,outputMicrosPerMillion:200,cacheReadMicrosPerMillion:50,cacheWriteMicrosPerMillion:100}};
const queryConfig={profile:knowledgeProfile.id,priceVersion:'test-bge-v1',maxInputTokens:60000,inputMicrosPerMillion:11800,dailyLimitMicros:1416,maxQueries:2};
async function api(){
  const m=await import('../src/modules/reply-tests/query.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return null;throw error;});
  assert.equal(typeof m?.admitReplyTestQuery,'function','query embedding must have persistent admission and one-call permission');return m!;
}
async function fixture(){
  const f=await knowledgeFixture(),actor={orgId:'company',actorUserId:'owner',sessionId:f.sqlite.prepare("SELECT id FROM session WHERE user_id='owner'").get()!.id as string};
  const seed=await seedReplyTest(f.db,actor,'store-a');await seed.source();
  const control:ReplyTestControlReader=async(scope,caller)=>{const access=await readControlAccess(f.db,caller,scope.conversationId);return access?.directory?{outcome:'found',view:{viewerMemberId:access.memberId,state:normalizeControlState(access.directory.state),projectionPending:false}}:{outcome:'not_found'};};
  const context=await prepareReplyTest(f.db,control,actor,seed.input);
  await createReplyTestBudget(f.db,actor,{id:'budget',startsAt:Date.now()-1000,endsAt:Date.now()+3600_000,limitMicros:1_000_000,maxRuns:10});await setReplyTestBudgetEnabled(f.db,actor,'budget',0,true);
  let calls=0;const ai={run:async()=>{calls++;return {data:[seed.embedding.values],shape:[1,1024]};}} as unknown as Ai;
  return {...f,...seed,actor,control,context,ai,calls:()=>calls,input:{requestId:crypto.randomUUID(),budgetId:'budget',context,answerConfig,queryConfig}};
}
async function admit(m:Awaited<ReturnType<typeof api>>,f:Awaited<ReturnType<typeof fixture>>){const r=await m.admitReplyTestQuery(f.db,f.control,f.actor,f.input);assert.equal(r.outcome,'admitted');return r.query;}

test('query admission freezes original context and prices and holds a monetary ceiling exactly once',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);const q=await admit(m,f);
  assert.equal(q.reservedMicros,708);assert.equal(q.attemptedAt,null);assert.equal(q.vectors,null);assert.deepEqual(q.payload.context,f.context);
  const again=await m.admitReplyTestQuery(f.db,f.control,f.actor,{...f.input,answerConfig:{...answerConfig,maxOutputTokens:1},queryConfig:{...queryConfig,inputMicrosPerMillion:1}});
  assert.equal(again.outcome,'existing');assert.deepEqual(again.query,q);
  assert.equal(await f.db.prepare('SELECT queries FROM reply_test_query_usage').first('queries'),1);
  assert.equal(await f.db.prepare('SELECT reserved_micros FROM reply_test_query_usage').first('reserved_micros'),708);
  assert.deepEqual((await readReplyTestBudgets(f.db,f.actor))!.queryToday,{queries:1,reservedMicros:708});
  const other={orgId:'other',actorUserId:'other',sessionId:f.sqlite.prepare("SELECT id FROM session WHERE user_id='other'").get()!.id as string};
  assert.deepEqual((await readReplyTestBudgets(f.db,other))!.queryToday,{queries:0,reservedMicros:0});
  assert.equal((await m.admitReplyTestQuery(f.db,f.control,f.actor,{...f.input,budgetId:'other'})).outcome,'conflict');
});
test('explicit free query pricing is still count limited and insertion failure rolls back allowance',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);
  f.sqlite.exec("CREATE TRIGGER query_insert_failure BEFORE INSERT ON reply_test_query BEGIN SELECT RAISE(ABORT,'synthetic query failure'); END");
  await assert.rejects(()=>admit(m,f),/synthetic query failure/);assert.equal(await f.db.prepare('SELECT count(*) AS n FROM reply_test_query_usage').first('n'),0);f.sqlite.exec('DROP TRIGGER query_insert_failure');
  const free={...f.input,queryConfig:{...queryConfig,inputMicrosPerMillion:0,dailyLimitMicros:0,maxQueries:1}};
  assert.equal((await m.admitReplyTestQuery(f.db,f.control,f.actor,free)).outcome,'admitted');
  const context=await prepareReplyTest(f.db,f.control,f.actor,f.input.context.input);
  assert.equal((await m.admitReplyTestQuery(f.db,f.control,f.actor,{...free,requestId:crypto.randomUUID(),context})).outcome,'query_limit');
});
test('missing prices, insufficient answer budget and revoked access prevent query admission',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);
  for(const bad of [{...queryConfig,inputMicrosPerMillion:-1},{...queryConfig,maxInputTokens:1000},{...queryConfig,profile:'other'},null])
    assert.equal((await m.admitReplyTestQuery(f.db,f.control,f.actor,{...f.input,queryConfig:bad})).outcome,'pricing_unavailable');
  f.sqlite.exec("UPDATE reply_test_budget SET enabled=0");assert.equal((await m.admitReplyTestQuery(f.db,f.control,f.actor,f.input)).outcome,'budget_unavailable');
  f.sqlite.exec("UPDATE reply_test_budget SET enabled=1");f.sqlite.prepare('DELETE FROM session WHERE id=?').run(f.actor.sessionId);
  await assert.rejects(()=>admit(m,f),/REPLY_TEST/);assert.equal(f.calls(),0);
});
test('retrieval reuses saved vectors and immutable evidence without a second embedding call',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);await admit(m,f);
  const first=await m.retrieveReplyTestQuery({DB:f.db,KNOWLEDGE_AI:f.ai,KNOWLEDGE_INDEX:f.index,REPLY_TEST_ENABLED:'true'},f.actor,f.input.requestId,f.context.actor.memberId,f.control);
  assert.equal(first.outcome,'retrieved');assert.equal(first.query.evidence!.chunks.length,1);assert.equal(f.calls(),1);
  const read=await m.readReplyTestQuery(f.db,f.actor,f.input.requestId,f.context.actor.memberId);assert.ok(read?.vectors);assert.ok(read?.attemptedAt);
  const again=await m.retrieveReplyTestQuery({DB:f.db,KNOWLEDGE_AI:f.ai,KNOWLEDGE_INDEX:f.index,REPLY_TEST_ENABLED:'false'},f.actor,f.input.requestId,f.context.actor.memberId,f.control);
  assert.equal(again.outcome,'retrieved');assert.deepEqual(again.query.evidence,first.query.evidence);assert.equal(f.calls(),1);
});
test('a failed Vectorize read can resume from its stored embedding without another model call',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);await admit(m,f);let fail=true;f.onQuery(()=>{if(fail)throw new Error('synthetic index failure');});
  const env={DB:f.db,KNOWLEDGE_AI:f.ai,KNOWLEDGE_INDEX:f.index,REPLY_TEST_ENABLED:'true'};
  assert.equal((await m.retrieveReplyTestQuery(env,f.actor,f.input.requestId,f.context.actor.memberId,f.control)).outcome,'index_unavailable');assert.equal(f.calls(),1);fail=false;
  assert.equal((await m.retrieveReplyTestQuery(env,f.actor,f.input.requestId,f.context.actor.memberId,f.control)).outcome,'retrieved');assert.equal(f.calls(),1);
});
test('a provider failure stays unconfirmed and never refunds allowance or retries the embedding',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);await admit(m,f);let calls=0;
  const env={DB:f.db,KNOWLEDGE_AI:{run:async()=>{calls++;throw new Error('synthetic response lost');}} as unknown as Ai,KNOWLEDGE_INDEX:f.index,REPLY_TEST_ENABLED:'true'};
  assert.equal((await m.retrieveReplyTestQuery(env,f.actor,f.input.requestId,f.context.actor.memberId,f.control)).outcome,'unconfirmed');
  assert.equal((await m.retrieveReplyTestQuery(env,f.actor,f.input.requestId,f.context.actor.memberId,f.control)).outcome,'unconfirmed');assert.equal(calls,1);
  assert.equal(await f.db.prepare('SELECT reserved_micros FROM reply_test_query_usage').first('reserved_micros'),708);
});
test('new messages and changed membership invalidate saved retrieval before any answer admission',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);await admit(m,f);const env={DB:f.db,KNOWLEDGE_AI:f.ai,KNOWLEDGE_INDEX:f.index,REPLY_TEST_ENABLED:'true'};
  assert.equal((await m.retrieveReplyTestQuery(env,f.actor,f.input.requestId,f.context.actor.memberId,f.control)).outcome,'retrieved');await f.message('new-input','Другой вопрос',20);
  assert.equal((await m.retrieveReplyTestQuery(env,f.actor,f.input.requestId,f.context.actor.memberId,f.control)).outcome,'changed');assert.equal(f.calls(),1);
  assert.equal(await m.readReplyTestQuery(f.db,f.actor,f.input.requestId,'replacement-member'),null);
  assert.equal(await m.readReplyTestQuery(f.db,{...f.actor,orgId:'another-company'},f.input.requestId,f.context.actor.memberId),null);
});
