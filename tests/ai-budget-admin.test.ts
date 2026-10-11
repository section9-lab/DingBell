import assert from 'node:assert/strict';
import {test} from 'node:test';
import {knowledgeFixture} from './fixtures/knowledge.ts';
async function fixture(){const f=await knowledgeFixture();return {...f,actor:{orgId:'company',actorUserId:'owner',sessionId:f.sqlite.prepare("SELECT id FROM session WHERE user_id='owner'").get()!.id as string,expectedMemberId:'owner'}};}
async function api(){const m=await import('../src/modules/ai-runs/budget.ts');assert.equal(typeof m.readAiBudgets,'function','production budgets need a scoped paginated management view');return m;}
test('production budget history is bounded and the current window is independent of pagination',async t=>{
 const m=await api(),f=await fixture();t.after(f.close);const day=Math.floor(Date.now()/86400000)*86400000;
 for(let n=0;n<22;n++)assert.equal((await m.changeAiBudget(f.db,f.actor,{id:crypto.randomUUID(),action:'create',startsAt:day+n*86400000,endsAt:day+(n+1)*86400000,limitMicros:n,maxRuns:10})).outcome,'applied');
 const first=await m.readAiBudgets(f.db,f.actor);assert.equal(first!.budgets.length,20);assert.equal(first!.events.length,10);assert.ok(first!.nextBefore);assert.equal(first!.currentBudget!.startsAt,day);
 const next=await m.readAiBudgets(f.db,f.actor,first!.nextBefore!);assert.equal(next!.budgets.length,2);assert.equal(next!.nextBefore,null);assert.equal(next!.currentBudget!.id,first!.currentBudget!.id);
 assert.equal(new Set([...first!.budgets,...next!.budgets].map(b=>b.id)).size,22);assert.equal(next!.currentBudget!.remainingMicros,0);
 await assert.rejects(()=>m.readAiBudgets(f.db,f.actor,'[1,"x"] '));assert.equal(await m.readAiBudgets(f.db,{...f.actor,expectedMemberId:'rejoined'}),null);
});
test('a production budget read rechecks membership after the batch and never exposes another company',async t=>{
 const m=await api(),f=await fixture();t.after(f.close);assert.equal(await m.readAiBudgets(f.db,{...f.actor,orgId:'other-company'}),null);
 const batch=f.db.batch.bind(f.db);t.mock.method(f.db,'batch',async(...args:Parameters<typeof batch>)=>{const result=await batch(...args);f.sqlite.exec("UPDATE member SET role='owner' WHERE id='admin'; UPDATE member SET role='member' WHERE id='owner'");return result;});
 assert.equal(await m.readAiBudgets(f.db,f.actor),null);
});
