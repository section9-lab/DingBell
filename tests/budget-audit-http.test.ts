import assert from 'node:assert/strict';
import {test} from 'node:test';
import {conversationsFixture} from './fixtures/conversations.ts';

async function fixture(){
  const f=await conversationsFixture();
  await f.DB.prepare("INSERT INTO ai_budget(id,organization_id,starts_at,ends_at,limit_micros,max_runs) VALUES('budget','company',1,2,1000,10)").run();
  const request=(options:{user?:string;member?:string;company?:string;kind?:string;budget?:string;query?:string;method?:string;summary?:boolean}={})=>
    f.app.request(`${f.env.APP_BASE_URL}/api/companies/${options.company??'company'}/budget-audits${options.summary?'':`/${options.kind??'ai'}/${options.budget??'budget'}`}${options.query??''}`,
      {method:options.method??'GET',headers:{cookie:f.cookies[options.user??'owner']??'','X-DingBell-Member-Id':options.member??'owner-member'}},f.env);
  return {...f,request};
}
test('budget audit route returns only scoped totals and never exposes the deployment-wide query allowance',{timeout:30000},async t=>{
  const f=await fixture();t.after(f.close);
  await f.DB.prepare("INSERT INTO reply_test_query_usage(day,reserved_micros,queries) VALUES('2026-10-11',987654,77)").run();
  const response=await f.request();assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('cache-control'),'no-store');
  const data=await response.json() as any;assert.equal(data.status,'balanced');assert.equal(data.viewerMemberId,'owner-member');assert.equal(data.companyId,'company');
  assert.equal(data.canRelease,false);assert.equal(data.supplierCostsVerified,false);assert.equal(JSON.stringify(data).includes('987654'),false);
  assert.equal((await f.request({kind:'reply-test-query'})).status,400);assert.equal((await f.request({method:'POST'})).status,404);
});
test('company reconciliation summary is manager-only, bounded and includes translation alerts without content',{timeout:30000},async t=>{
  const f=await fixture();t.after(f.close);await f.DB.prepare("INSERT INTO translation_budget_bucket(id,organization_id,starts_at,ends_at,limit_micros) VALUES('translation-budget','company',1,2,100)").run();
  await f.DB.prepare("UPDATE budget_reconciliation_state SET status='mismatch',payload='{}',observed_at=1,mismatch_since=1,consecutive_mismatches=2,next_due_at=2 WHERE kind='translation' AND budget_id='translation-budget'").run();
  const response=await f.request({summary:true});assert.equal(response.status,200,await response.clone().text());const data=await response.json() as any;
  assert.deepEqual(data.totals,{tracked:2,pending:1,balanced:0,mismatch:1,unavailable:0,alerting:1});assert.equal(data.items.length,2);assert.equal(data.items[0].kind,'translation');
  assert.equal(JSON.stringify(data).includes('payload'),false);assert.equal(data.truncated,false);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await f.request({summary:true,user:'staff',member:'staff-member'})).status,404);assert.equal((await f.request({summary:true,company:'other-company'})).status,404);
  assert.equal((await f.request({summary:true,query:'?all=true'})).status,400);assert.equal((await f.request({summary:true,method:'POST'})).status,404);
});
test('budget audit route requires authenticated managers and a canonical current member binding',{timeout:30000},async t=>{
  const f=await fixture();t.after(f.close);
  assert.equal((await f.request({user:'none'})).status,401);
  for(const options of [{user:'staff',member:'staff-member'},{user:'other',member:'other-member'},{company:'other-company'},{member:'rejoined'},{budget:'unknown'}])
    assert.equal((await f.request(options)).status,404);
  for(const options of [{member:''},{member:'%'},{member:'%6fwner-member'},{query:'?all=true'},{kind:'anything'}])assert.equal((await f.request(options)).status,400);
  await f.DB.prepare("UPDATE user SET email_verified=0 WHERE id='owner'").run();assert.notEqual((await f.request()).status,200);
});
test('missing financial schema fails with an explicit unavailable result without changing existing balances',{timeout:30000},async t=>{
  const f=await fixture();t.after(f.close);
  await f.DB.prepare('ALTER TABLE ai_generation RENAME TO synthetic_missing_generation').run();
  const response=await f.request();assert.equal(response.status,503);assert.equal((await response.json() as any).error.code,'BUDGET_AUDIT_UNAVAILABLE');
  assert.equal(await f.DB.prepare("SELECT reserved_micros FROM ai_budget WHERE id='budget'").first('reserved_micros'),0);
});
