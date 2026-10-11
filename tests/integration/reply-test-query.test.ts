import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationControlFixture } from '../fixtures/conversation-control.ts';
import { seedReplyTest } from '../fixtures/reply-test.ts';
import { answerConfig,queryConfig } from '../fixtures/web-identity/reply-test-runtime.ts';
import { prepareReplyTest,retrieveReplyTestKnowledge,type ReplyTestControlReader } from '../../src/modules/reply-tests/service.ts';
import { createReplyTestBudget,setReplyTestBudgetEnabled,reserveReplyTest,readReplyTestRun,readReplyTestBudget } from '../../src/modules/reply-tests/storage.ts';
import { admitReplyTestQuery,readReplyTestQuery,claimReplyTestEmbedding,retrieveReplyTestQuery } from '../../src/modules/reply-tests/query.ts';
async function setup(f:Awaited<ReturnType<typeof conversationControlFixture>>){
  const seed=await seedReplyTest(f.db,f.actor(),'store','conv');await seed.source();
  const control:ReplyTestControlReader=async(scope,actor)=>(await f.call('read',{actor},scope)).body;
  await createReplyTestBudget(f.db,f.actor(),{id:'budget',startsAt:Date.now()-1000,endsAt:Date.now()+3600_000,limitMicros:1_000_000,maxRuns:10});await setReplyTestBudgetEnabled(f.db,f.actor(),'budget',0,true);
  const input=async()=>({requestId:crypto.randomUUID(),budgetId:'budget',context:await prepareReplyTest(f.db,control,f.actor(),seed.input),answerConfig,queryConfig:{...queryConfig,maxQueries:1,dailyLimitMicros:708}});
  return {...seed,control,input};
}
test('0030 preserves an existing held answer run; concurrent query admissions reserve the final daily allowance once',{timeout:30_000},async t=>{
  const f=await conversationControlFixture('0029');t.after(()=>f.close());const s=await setup(f),oldInput=await s.input();
  const evidence=await retrieveReplyTestKnowledge(f.db,s.index,s.control,f.actor(),oldInput.context,s.embedding);
  const old=await reserveReplyTest(f.db,s.control,f.actor(),{...oldInput,evidence},answerConfig);assert.equal(old.outcome,'reserved');
  const before=await readReplyTestBudget(f.db,f.actor(),'budget');await f.migrateAfter('0029');
  const inputs=await Promise.all(Array.from({length:6},()=>s.input()));
  const results=await Promise.all(inputs.map(input=>admitReplyTestQuery(f.db,s.control,f.actor(),input)));
  assert.equal(results.filter(r=>r.outcome==='admitted').length,1);assert.equal(results.filter(r=>r.outcome==='query_limit').length,5);
  const winner=results.findIndex(r=>r.outcome==='admitted');
  const repeated=await Promise.all(Array.from({length:6},()=>admitReplyTestQuery(f.db,s.control,f.actor(),inputs[winner])));assert.ok(repeated.every(r=>r.outcome==='existing'));
  assert.deepEqual(await f.db.prepare('SELECT reserved_micros,queries FROM reply_test_query_usage').first(),{reserved_micros:708,queries:1});
  assert.deepEqual(await readReplyTestRun(f.db,f.actor(),oldInput.requestId,'owner-member'),old.run);assert.deepEqual(await readReplyTestBudget(f.db,f.actor(),'budget'),before);
  assert.equal(f.providerRequests.length,0);
});
test('simultaneous native retrievals embed once, and persisted vectors survive a runtime restart',{timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const s=await setup(f),input=await s.input();assert.equal((await admitReplyTestQuery(f.db,s.control,f.actor(),input)).outcome,'admitted');
  let calls=0,release!:()=>void;const held=new Promise<void>(r=>{release=r;});
  const ai={run:async()=>{calls++;await held;return {data:[s.embedding.values],shape:[1,1024]};}} as unknown as Ai;
  const env=()=>({DB:f.db,KNOWLEDGE_AI:ai,KNOWLEDGE_INDEX:s.index,REPLY_TEST_ENABLED:'true'});
  const first=retrieveReplyTestQuery(env(),f.actor(),input.requestId,'owner-member',s.control);
  while(calls===0)await new Promise(r=>setTimeout(r,10));
  try{const others=await Promise.all(Array.from({length:5},()=>retrieveReplyTestQuery(env(),f.actor(),input.requestId,'owner-member',s.control)));assert.ok(others.every(r=>r.outcome==='unconfirmed'));assert.equal(calls,1);}finally{release();}
  assert.equal((await first).outcome,'retrieved');const saved=await readReplyTestQuery(f.db,f.actor(),input.requestId,'owner-member');
  await f.restart();const recovered=await retrieveReplyTestQuery(env(),f.actor(),input.requestId,'owner-member',s.control);assert.equal(recovered.outcome,'retrieved');assert.deepEqual(recovered.query.evidence,saved!.evidence);assert.equal(calls,1);
  assert.equal(f.providerRequests.length,0);
});
test('a lost native embedding permit response remains charged to allowance and cannot issue a second call',{timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const s=await setup(f),input=await s.input();await admitReplyTestQuery(f.db,s.control,f.actor(),input);
  let lost=false;const faulty={prepare(sql:string){const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(target,key){
    if(key==='bind')return (...params:unknown[])=>wrap(target.bind(...params));
    if(key==='first')return async(...args:Parameters<D1PreparedStatement['first']>)=>{const result=await target.first(...args);if(sql.startsWith('UPDATE reply_test_query AS q SET attempted_at')&&!lost){lost=true;throw new Error('synthetic lost query permit');}return result;};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});return wrap(f.db.prepare(sql));}} as D1Database;
  await assert.rejects(()=>claimReplyTestEmbedding(faulty,s.control,f.actor(),input.requestId,'owner-member'),/synthetic lost query permit/);assert.equal(lost,true);
  await f.restart();assert.equal(await claimReplyTestEmbedding(f.db,s.control,f.actor(),input.requestId,'owner-member'),false);
  assert.equal(await f.db.prepare('SELECT reserved_micros FROM reply_test_query_usage').first('reserved_micros'),708);assert.equal(f.providerRequests.length,0);
});
