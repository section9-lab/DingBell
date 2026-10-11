import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationControlFixture } from '../fixtures/conversation-control.ts';
import { createReplyTestBudget,setReplyTestBudgetEnabled,readReplyTestBudget } from '../../src/modules/reply-tests/storage.ts';
import { changeReplyTestBudget,readReplyTestBudgets } from '../../src/modules/reply-tests/budget-admin.ts';
function input(){const day=Math.floor(Date.now()/86400000)*86400000;return {id:crypto.randomUUID(),action:'create' as const,startsAt:day+2*86400000,endsAt:day+3*86400000,limitMicros:100000,maxRuns:10};}
test('0031 preserves old budget balances, and native concurrent creation and toggling each commit exactly one audited transition',{timeout:30000},async t=>{
  const f=await conversationControlFixture('0030');t.after(()=>f.close());const actor={...f.actor(),expectedMemberId:'owner-member'};
  await createReplyTestBudget(f.db,actor,{id:'legacy',startsAt:Date.now()-1000,endsAt:Date.now()+3600000,limitMicros:100000,maxRuns:10});await setReplyTestBudgetEnabled(f.db,actor,'legacy',0,true);
  await f.db.prepare("UPDATE reply_test_budget SET reserved_micros=20,spent_micros=30,admitted_runs=2 WHERE id='legacy'").run();const before=await readReplyTestBudget(f.db,actor,'legacy');
  await f.migrateAfter('0030');assert.deepEqual(await readReplyTestBudget(f.db,actor,'legacy'),before);
  const inputs=Array.from({length:6},input),created=await Promise.all(inputs.map(c=>changeReplyTestBudget(f.db,actor,c)));assert.equal(created.filter(r=>r.outcome==='applied').length,1);assert.equal(created.filter(r=>r.outcome==='overlap').length,5);
  const budgetId=inputs[created.findIndex(r=>r.outcome==='applied')].id;
  const commands=Array.from({length:6},()=>({id:crypto.randomUUID(),action:'set_enabled' as const,budgetId,expectedRevision:0,enabled:true}));
  const enabled=await Promise.all(commands.map(c=>changeReplyTestBudget(f.db,actor,c)));assert.equal(enabled.filter(r=>r.outcome==='applied').length,1);assert.equal(enabled.filter(r=>r.outcome==='changed').length,5);
  assert.equal(await f.db.prepare('SELECT count(*) n FROM reply_test_budget_audit').first('n'),2);assert.equal(await f.db.prepare('SELECT count(*) n FROM reply_test_budget WHERE commit_token IS NOT NULL').first('n'),0);
  assert.equal((await readReplyTestBudgets(f.db,actor))!.currentBudget!.remainingMicros,99950);assert.equal(f.providerRequests.length,0);
});
test('a lost native acknowledgement is recovered after restart without reapplying the old enable command',{timeout:30000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const actor={...f.actor(),expectedMemberId:'owner-member'},create=input();await changeReplyTestBudget(f.db,actor,create);
  const enable={id:crypto.randomUUID(),action:'set_enabled' as const,budgetId:create.id,expectedRevision:0,enabled:true};let lost=false;
  const faulty=new Proxy(f.db,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await target.batch(statements);if(!lost){lost=true;throw new Error('synthetic lost budget acknowledgement');}return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(()=>changeReplyTestBudget(faulty,actor,enable),/synthetic lost budget acknowledgement/);await f.restart();
  const pause={id:crypto.randomUUID(),action:'set_enabled' as const,budgetId:create.id,expectedRevision:1,enabled:false};assert.equal((await changeReplyTestBudget(f.db,actor,pause)).outcome,'applied');
  const replay=await changeReplyTestBudget(f.db,actor,enable);assert.equal(replay.outcome,'existing');assert.equal(replay.budget.enabled,false);assert.equal(replay.budget.revision,2);
  assert.equal(await f.db.prepare('SELECT count(*) n FROM reply_test_budget_audit').first('n'),3);assert.equal(f.providerRequests.length,0);
});
test('native audit failure rolls back the mutation and immutable audit rows reject rewriting',{timeout:30000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const actor={...f.actor(),expectedMemberId:'owner-member'},create=input();
  await f.db.prepare("CREATE TRIGGER fail_native_budget_audit BEFORE INSERT ON reply_test_budget_audit BEGIN SELECT RAISE(ABORT,'synthetic budget audit failure'); END").run();
  await assert.rejects(()=>changeReplyTestBudget(f.db,actor,create),/synthetic budget audit failure/);assert.equal(await f.db.prepare('SELECT count(*) n FROM reply_test_budget').first('n'),0);
  await f.db.prepare('DROP TRIGGER fail_native_budget_audit').run();await changeReplyTestBudget(f.db,actor,create);
  await assert.rejects(()=>f.db.prepare("UPDATE reply_test_budget_audit SET actor_name='forged'").run(),/REPLY_TEST_BUDGET_AUDIT_IMMUTABLE/);assert.equal(f.providerRequests.length,0);
});
