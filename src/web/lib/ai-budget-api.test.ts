import assert from 'node:assert/strict';
import {test} from 'node:test';
async function api(){const m=await import('./ai-budget-api.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.changeAiBudget,'function','production budgets need their own validated client endpoint');return m!;}
const day=Math.floor(Date.now()/86400000)*86400000,id=crypto.randomUUID();
const input={id,action:'create' as const,startsAt:day,endsAt:day+86400000,limitMicros:100000,maxRuns:10};
const budget={id,startsAt:day,endsAt:day+86400000,enabled:false,revision:0,limitMicros:100000,maxRuns:10,reservedMicros:0,spentMicros:0,admittedRuns:0,remainingMicros:100000,remainingRuns:10};
const changed={purpose:'production',companyId:'company',viewerMemberId:'member',budget,command:{id,action:'create',budgetId:id,revision:0,enabled:false}};
const configuration={enabled:false,modelConfigured:false,pricesConfigured:false,model:null,maxGenerations:null,perGenerationMicros:null,runReservationMicros:null};
const workspace={purpose:'production',companyId:'company',viewerMemberId:'member',at:day,currentBudget:budget,budgets:[budget],nextBefore:null,events:[],configuration};
test('the production budget client binds company, membership, domain and the original receipt',async t=>{
 const m=await api();let payload:unknown=changed;const calls:{url:string;init:RequestInit}[]=[];t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json(payload);});
 assert.deepEqual(await m.changeAiBudget('company','member',input),changed);payload=workspace;assert.deepEqual(await m.readAiBudgets('company'),workspace);
 assert.ok(calls.every(c=>c.url==='/api/companies/company/ai-budgets'));assert.equal(new Headers(calls[0].init.headers).get('X-DingBell-Member-Id'),'member');assert.deepEqual(JSON.parse(String(calls[0].init.body)),input);assert.equal(calls[1].init.cache,'no-store');
});
test('production budget responses reject another domain, identity, limits or mismatched receipts',async t=>{
 const m=await api();let payload:unknown=changed;t.mock.method(globalThis,'fetch',async()=>Response.json(payload));
 for(payload of [{...changed,purpose:'test'},{...changed,purpose:undefined},{...changed,viewerMemberId:'rejoined'},{...changed,companyId:'other'},{...changed,budget:{...budget,limitMicros:2}},{...changed,command:{...changed.command,id:crypto.randomUUID()}}])await assert.rejects(m.changeAiBudget('company','member',input),{code:'OPERATION_UNCONFIRMED'});
 for(payload of [{...workspace,purpose:'test'},{...workspace,currentBudget:{...budget,startsAt:day+1}},{...workspace,nextBefore:'bad'},{...workspace,budgets:[budget,budget]},
  {...workspace,configuration:{...configuration,pricesConfigured:true}},{...workspace,configuration:{...configuration,runReservationMicros:0}},
  {...workspace,configuration:{...configuration,pricesConfigured:true,model:'supported',maxGenerations:3,perGenerationMicros:1,runReservationMicros:2}},
 ])await assert.rejects(m.readAiBudgets('company'),{code:'INVALID_RESPONSE'});
});
test('production budget validation prevents forged input and uncertain writes are never automatically repeated',async t=>{
 const m=await api(),fetch=t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'INTERNAL_ERROR'}},{status:503}));
 for(const patch of [{enabled:true},{reservedMicros:0},{limitMicros:0.5},{id:'bad'}])await assert.rejects(m.changeAiBudget('company','member',{...input,...patch} as typeof input),{code:'INVALID_REQUEST'});
 assert.equal(fetch.mock.callCount(),0);await assert.rejects(m.changeAiBudget('company','member',input),{code:'OPERATION_UNCONFIRMED'});assert.equal(fetch.mock.callCount(),1);
});
