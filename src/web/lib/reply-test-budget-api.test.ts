/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usdToMicros,formatBudgetUsd,utcBudgetDay,readReplyTestBudgets,changeReplyTestBudget } from './reply-test-budget-api.ts';
const day=1791590400000,input={id:'00000000-0000-4000-8000-000000000001',action:'create' as const,startsAt:day,endsAt:day+86400000,limitMicros:100000,maxRuns:10};
const budget={id:input.id,startsAt:day,endsAt:day+86400000,enabled:false,revision:0,limitMicros:100000,reservedMicros:20,spentMicros:30,maxRuns:10,admittedRuns:2,remainingMicros:99950,remainingRuns:8};
const receipt={id:input.id,action:'create',budgetId:input.id,revision:0,enabled:false};
const changed={companyId:'company',viewerMemberId:'member',budget,command:receipt};
const workspace={companyId:'company',viewerMemberId:'member',at:day+10,currentBudget:budget,budgets:[budget],nextBefore:null,events:[],queryToday:{queries:0,reservedMicros:0},
  configuration:{enabled:false,modelConfigured:false,knowledgeConfigured:false,pricesConfigured:false,answerReservationMicros:null,queryReservationMicros:null}};
test('budget amounts use exact integer microdollars and reject rounding, exponent syntax and unsafe values',()=>{
  for(const [value,micros]of [['0',0],['1.23',1230000],['0.000001',1],['9007199254.740991',Number.MAX_SAFE_INTEGER]] as const)assert.equal(usdToMicros(value),micros);
  for(const value of ['','-1','1e3','1.0000001','9007199254.740992','Infinity',' 1','1.'])assert.equal(usdToMicros(value),null);
  assert.equal(formatBudgetUsd(1),'$0.000001');assert.equal(formatBudgetUsd(1000000),'$1.00');assert.equal(formatBudgetUsd(Number.MAX_SAFE_INTEGER),'$9,007,199,254.740991');
  assert.equal(utcBudgetDay('2028-02-29'),Date.parse('2028-02-29T00:00:00Z'));for(const value of ['2026-02-29','2026-02-30','2026-1-1','1969-12-31','bad'])assert.equal(utcBudgetDay(value),null);
});
test('budget client binds scope, canonical membership and the original mutation',async t=>{
  let payload:unknown=changed;const calls:{url:string;init:RequestInit}[]=[];t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json(payload);});
  assert.deepEqual(await changeReplyTestBudget('company','member',input),changed);payload=workspace;assert.deepEqual(await readReplyTestBudgets('company'),workspace);
  assert.equal(new Headers(calls[0].init.headers).get('X-DingBell-Member-Id'),'member');assert.deepEqual(JSON.parse(String(calls[0].init.body)),input);assert.equal(calls[0].init.cache,'no-store');assert.equal(calls[1].init.body,undefined);
});
test('budget responses cannot drift in membership, immutable limits, receipts or reported balances',async t=>{
  let payload:unknown=changed;t.mock.method(globalThis,'fetch',async()=>Response.json(payload));
  for(payload of [{...changed,companyId:'other'},{...changed,viewerMemberId:'rejoined'},...[
    {limitMicros:2},{remainingMicros:99999},{remainingRuns:10},{id:'other'}].map(change=>({...changed,budget:{...budget,...change}})),
    {...changed,command:{...receipt,id:crypto.randomUUID()}},{...changed,command:{...receipt,enabled:true}}])await assert.rejects(changeReplyTestBudget('company','member',input),{code:'OPERATION_UNCONFIRMED'});
  for(payload of [{...workspace,companyId:'other'},{...workspace,currentBudget:{...budget,startsAt:day+100}},{...workspace,nextBefore:'not-a-cursor'},
    {...workspace,configuration:{...workspace.configuration,pricesConfigured:true}}])await assert.rejects(readReplyTestBudgets('company'),{code:'INVALID_RESPONSE'});
});
test('invalid budget inputs never fetch; unknown writes are not automatically retried',async t=>{
  const fetch=t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'INTERNAL_ERROR'}},{status:503}));
  for(const patch of [{enabled:true},{reservedMicros:0},{limitMicros:0.5},{id:'bad'}])await assert.rejects(changeReplyTestBudget('company','member',{...input,...patch} as typeof input),{code:'INVALID_REQUEST'});
  assert.equal(fetch.mock.callCount(),0);await assert.rejects(changeReplyTestBudget('company','member',input),{code:'OPERATION_UNCONFIRMED'});assert.equal(fetch.mock.callCount(),1);
});
