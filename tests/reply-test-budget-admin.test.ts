import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knowledgeFixture } from './fixtures/knowledge.ts';
async function api(){const m=await import('../src/modules/reply-tests/budget-admin.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.changeReplyTestBudget,'function','budget administration must atomically persist an original-member command and its audit');return m!;}
async function fixture(){const f=await knowledgeFixture();const actor={orgId:'company',actorUserId:'owner',sessionId:f.sqlite.prepare("SELECT id FROM session WHERE user_id='owner'").get()!.id as string,expectedMemberId:'owner'};
  const today=Math.floor(Date.now()/86400000)*86400000;return {...f,actor,input:{id:crypto.randomUUID(),action:'create' as const,startsAt:today,endsAt:today+86400000,limitMicros:100000,maxRuns:10}};}
test('new budgets are paused, audited once, and replayed creation never resets existing usage or enabled state',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);const result=await m.changeReplyTestBudget(f.db,f.actor,f.input);assert.equal(result.outcome,'applied');assert.equal(result.budget.enabled,false);assert.equal(result.command.revision,0);
  const enable={id:crypto.randomUUID(),action:'set_enabled' as const,budgetId:f.input.id,expectedRevision:0,enabled:true};assert.equal((await m.changeReplyTestBudget(f.db,f.actor,enable)).outcome,'applied');
  f.sqlite.prepare('UPDATE reply_test_budget SET reserved_micros=20,spent_micros=30,admitted_runs=2 WHERE id=?').run(f.input.id);
  const again=await m.changeReplyTestBudget(f.db,f.actor,f.input);assert.equal(again.outcome,'existing');assert.equal(again.budget.enabled,true);assert.equal(again.budget.reservedMicros,20);assert.equal(again.budget.spentMicros,30);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM reply_test_budget_audit').get()!.n,2);const page=await m.readReplyTestBudgets(f.db,f.actor);assert.equal(page!.currentBudget!.remainingMicros,99950);assert.equal(page!.currentBudget!.remainingRuns,8);assert.equal(page!.events.length,2);
});
test('old enable commands never re-enable a later pause; payload changes and stale CAS remain conflicts',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);await m.changeReplyTestBudget(f.db,f.actor,f.input);
  const enable={id:crypto.randomUUID(),action:'set_enabled' as const,budgetId:f.input.id,expectedRevision:0,enabled:true};await m.changeReplyTestBudget(f.db,f.actor,enable);
  const pause={id:crypto.randomUUID(),action:'set_enabled' as const,budgetId:f.input.id,expectedRevision:1,enabled:false};await m.changeReplyTestBudget(f.db,f.actor,pause);
  const replay=await m.changeReplyTestBudget(f.db,f.actor,enable);assert.equal(replay.outcome,'existing');assert.equal(replay.budget.enabled,false);assert.equal(replay.budget.revision,2);assert.equal(replay.command.enabled,true);
  assert.equal((await m.changeReplyTestBudget(f.db,f.actor,{...enable,enabled:false})).outcome,'conflict');
  assert.equal((await m.changeReplyTestBudget(f.db,f.actor,{...enable,id:crypto.randomUUID()})).outcome,'changed');
  assert.equal((await m.changeReplyTestBudget(f.db,f.actor,{...f.input,limitMicros:1})).outcome,'conflict');
});
test('audit write failure rolls back both creation and enablement',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);
  f.sqlite.exec("CREATE TRIGGER fail_budget_audit BEFORE INSERT ON reply_test_budget_audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  await assert.rejects(()=>m.changeReplyTestBudget(f.db,f.actor,f.input),/synthetic audit failure/);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM reply_test_budget').get()!.n,0);
  f.sqlite.exec('DROP TRIGGER fail_budget_audit');await m.changeReplyTestBudget(f.db,f.actor,f.input);
  f.sqlite.exec("CREATE TRIGGER fail_budget_audit BEFORE INSERT ON reply_test_budget_audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  await assert.rejects(()=>m.changeReplyTestBudget(f.db,f.actor,{id:crypto.randomUUID(),action:'set_enabled',budgetId:f.input.id,expectedRevision:0,enabled:true}),/synthetic audit failure/);
  assert.deepEqual(f.sqlite.prepare('SELECT enabled,revision,commit_token FROM reply_test_budget').get(),Object.assign(Object.create(null),{enabled:0,revision:0,commit_token:null}));
});
test('current management access, original membership and verified session are required for every mutation and read',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);await m.changeReplyTestBudget(f.db,f.actor,f.input);
  for(const actor of [{...f.actor,orgId:'other-company'},{...f.actor,expectedMemberId:'rejoined'},{...f.actor,sessionId:'missing'}]){
    assert.equal((await m.changeReplyTestBudget(f.db,actor,f.input)).outcome,'not_found');assert.equal(await m.readReplyTestBudgets(f.db,actor),null);
  }
  f.sqlite.exec("UPDATE member SET role='owner' WHERE id='admin'; UPDATE member SET role='member' WHERE id='owner'");assert.equal((await m.changeReplyTestBudget(f.db,f.actor,f.input)).outcome,'not_found');
  f.sqlite.exec("UPDATE member SET role='owner' WHERE id='owner'; UPDATE user SET email_verified=0 WHERE id='owner'");assert.equal(await m.readReplyTestBudgets(f.db,f.actor),null);
});
test('window overlap is rejected even for paused budgets; invalid input and expired creation cannot mutate data',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);await m.changeReplyTestBudget(f.db,f.actor,f.input);
  assert.equal((await m.changeReplyTestBudget(f.db,f.actor,{...f.input,id:crypto.randomUUID()})).outcome,'overlap');
  for(const patch of [{limitMicros:-1},{limitMicros:0.1},{maxRuns:0},{maxRuns:1000001},{endsAt:f.input.startsAt},{startsAt:f.input.startsAt+1},{enabled:true}])
    await assert.rejects(()=>m.changeReplyTestBudget(f.db,f.actor,{...f.input,...patch}));
  assert.equal((await m.changeReplyTestBudget(f.db,f.actor,{...f.input,id:crypto.randomUUID(),startsAt:f.input.startsAt-86400000,endsAt:f.input.startsAt})).outcome,'expired');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM reply_test_budget').get()!.n,1);
});
test('bounded history pins the current window and counts query reservations only for this company',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);await m.changeReplyTestBudget(f.db,f.actor,f.input);
  for(let i=1;i<=22;i++)await m.changeReplyTestBudget(f.db,f.actor,{...f.input,id:crypto.randomUUID(),startsAt:f.input.startsAt+i*86400000,endsAt:f.input.endsAt+i*86400000});
  const first=await m.readReplyTestBudgets(f.db,f.actor);assert.equal(first!.budgets.length,20);assert.equal(first!.currentBudget!.id,f.input.id);assert.ok(first!.nextBefore);
  const second=await m.readReplyTestBudgets(f.db,f.actor,first!.nextBefore!);assert.equal(second!.budgets.length,3);assert.equal(second!.nextBefore,null);assert.equal(new Set([...first!.budgets,...second!.budgets].map(b=>b.id)).size,23);
  assert.deepEqual(first!.queryToday,{queries:0,reservedMicros:0});assert.equal(first!.events.length,10);
  f.sqlite.prepare('UPDATE reply_test_budget SET spent_micros=100001 WHERE id=?').run(f.input.id);assert.equal((await m.readReplyTestBudgets(f.db,f.actor))!.currentBudget!.remainingMicros,0);
});
test('removal and rejoining after the preflight cannot authorize an old member command',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);f.sqlite.exec("UPDATE member SET role='owner' WHERE id='admin'");let changed=false;
  f.before(sql=>{if(!changed&&sql.startsWith('INSERT INTO reply_test_budget(')){changed=true;f.sqlite.exec("DELETE FROM member WHERE id='owner'; INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('owner-rejoined','company','owner','owner',1)");}});
  assert.equal((await m.changeReplyTestBudget(f.db,f.actor,f.input)).outcome,'not_found');assert.equal(changed,true);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM reply_test_budget').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM reply_test_budget_audit').get()!.n,0);
});
