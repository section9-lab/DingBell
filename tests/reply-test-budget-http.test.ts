import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import { conversationsFixture } from './fixtures/conversations.ts';
import { replyTestBudgetWorkspaceSchema } from '../src/shared/reply-test-budget.ts';
async function fixture(){const f=await conversationsFixture();const day=Math.floor(Date.now()/86400000)*86400000;
  const input={id:crypto.randomUUID(),action:'create',startsAt:day,endsAt:day+86400000,limitMicros:100000,maxRuns:10};
  const request=(options:{body?:unknown;user?:string;member?:string|null;origin?:string;query?:string;company?:string}={})=>{
    const headers=new Headers({cookie:f.cookies[options.user??'owner']??'',origin:options.origin??f.env.APP_BASE_URL,'content-type':'application/json'});
    const member=options.member===undefined?(options.body?'owner-member':null):options.member;if(member!==null)headers.set('X-DingBell-Member-Id',member);
    return f.app.request(`${f.env.APP_BASE_URL}/api/companies/${options.company??'company'}/reply-test-budgets${options.query??''}`,{method:options.body?'POST':'GET',headers,...(options.body?{body:JSON.stringify(options.body)}:{})},f.env);
  };return {...f,request,input};}
async function error(r:Response,status:number,code:string){assert.equal(r.status,status,await r.clone().text());assert.equal((await r.json() as any).error.code,code);}
test('manager budget routes expose bounded usage, create a paused window and replay audited toggles',{timeout:30000},async t=>{
  const f=await fixture();t.after(f.close);const empty=await f.request();assert.equal(empty.status,200);const initial=v.parse(replyTestBudgetWorkspaceSchema,await empty.json());
  assert.equal(initial.viewerMemberId,'owner-member');assert.equal(initial.currentBudget,null);assert.equal(initial.configuration.enabled,false);assert.equal(initial.configuration.pricesConfigured,false);
  const create=await f.request({body:f.input});assert.equal(create.status,200,await create.clone().text());const created=await create.json() as any;assert.equal(created.budget.enabled,false);assert.equal(created.command.id,f.input.id);
  const enable={id:crypto.randomUUID(),action:'set_enabled',budgetId:f.input.id,expectedRevision:0,enabled:true};assert.equal((await f.request({body:enable})).status,200);assert.equal((await f.request({body:enable})).status,200);
  const current=await f.request({member:'owner-member'});assert.equal(current.headers.get('cache-control'),'no-store');const data=v.parse(replyTestBudgetWorkspaceSchema,await current.json());assert.equal(data.currentBudget!.enabled,true);assert.equal(data.events.length,2);
  await error(await f.request({body:{...enable,id:crypto.randomUUID()}}),409,'BUDGET_CHANGED');
  await error(await f.request({body:{...f.input,id:crypto.randomUUID()}}),409,'BUDGET_WINDOW_OVERLAP');
});
test('budget writes require canonical original membership and reject role, origin and payload escalation',{timeout:30000},async t=>{
  const f=await fixture();t.after(f.close);
  await error(await f.request({user:'none'}),401,'UNAUTHENTICATED');await error(await f.request({user:'staff'}),403,'FORBIDDEN');await error(await f.request({user:'other'}),404,'NOT_FOUND');
  await error(await f.request({body:f.input,origin:'https://elsewhere.invalid'}),403,'ORIGIN_REJECTED');
  for(const member of [null,'','%','%6fwner-member'])await error(await f.request({body:f.input,member}),400,'INVALID_REQUEST');
  await error(await f.request({body:f.input,member:'rejoined'}),404,'NOT_FOUND');
  for(const patch of [{enabled:true},{reservedMicros:0},{pricing:{}},{actorUserId:'forged'},{limitMicros:-1},{maxRuns:0}])await error(await f.request({body:{...f.input,...patch}}),400,'INVALID_REQUEST');
  for(const query of ['?all=true','?before=[]','?before=a&before=b'])await error(await f.request({query}),400,'INVALID_REQUEST');
  assert.equal(await f.DB.prepare('SELECT count(*) AS n FROM reply_test_budget').first('n'),0);
});
test('an audit failure reports uncertainty and leaves no unaudited budget',{timeout:30000},async t=>{
  const f=await fixture();t.after(f.close);await f.DB.prepare("CREATE TRIGGER fail_budget_admin BEFORE INSERT ON reply_test_budget_audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END").run();
  await error(await f.request({body:f.input}),503,'OPERATION_UNCONFIRMED');assert.equal(await f.DB.prepare('SELECT count(*) AS n FROM reply_test_budget').first('n'),0);
});
