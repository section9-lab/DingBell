import assert from 'node:assert/strict';
import {test} from 'node:test';
import {formatAuditMicros,readBudgetAudit,readBudgetReconciliationSummary} from './budget-audit-api.ts';

const audit={companyId:'company',viewerMemberId:'member',kind:'ai' as const,budgetId:'budget',at:1,status:'mismatch' as const,
 recorded:{reservedMicros:'1000000',spentMicros:'0',admittedRuns:'1'},expected:{reservedMicros:'2000000',spentMicros:'1',admittedRuns:'1'},
 difference:{reservedMicros:'-1000000',spentMicros:'-1',admittedRuns:'0'},embeddingReservedMicros:'1000000',embeddingCorrelatedMicros:'0',embeddingUncorrelatedMicros:'1000000',invalidExecutions:0,
 monitoring:{status:'mismatch' as const,observedAt:1,nextDueAt:2,mismatchSince:1,consecutiveMismatches:2,lastErrorAt:null,lastErrorCode:null,consecutiveFailures:0},canRelease:false as const,supplierCostsVerified:false as const};
test('budget audit client binds the manager, company, kind and budget',async t=>{
 const calls:{url:string;init:RequestInit}[]=[];t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json(audit);});
 assert.deepEqual(await readBudgetAudit('company','member','ai','budget'),audit);assert.equal(calls[0].url,'/api/companies/company/budget-audits/ai/budget');
 assert.equal(new Headers(calls[0].init.headers).get('X-DingBell-Member-Id'),'member');assert.equal(calls[0].init.cache,'no-store');
});
test('budget audit client rejects forged scope, unsafe totals and authority flags',async t=>{
 let payload:unknown=audit;const fetch=t.mock.method(globalThis,'fetch',async()=>Response.json(payload));
 for(const [company,member,kind,budget] of [['','member','ai','budget'],['company','member','ai',' bad']] as const)await assert.rejects(readBudgetAudit(company,member,kind,budget),{code:'INVALID_REQUEST'});
 assert.equal(fetch.mock.callCount(),0);
 for(payload of [{...audit,companyId:'other'},{...audit,viewerMemberId:'other'},{...audit,canRelease:true},{...audit,recorded:{...audit.recorded,reservedMicros:'1.0'}},{...audit,monitoring:{...audit.monitoring,lastErrorCode:'DETAIL'}}])
  await assert.rejects(readBudgetAudit('company','member','ai','budget'),{code:'INVALID_RESPONSE'});
});
test('reconciliation summary validates manager scope, totals and alert-only rows',async t=>{
 const summary={companyId:'company',viewerMemberId:'member',at:2,totals:{tracked:2,pending:1,balanced:0,mismatch:1,unavailable:0,alerting:1},items:[
  {kind:'translation',budgetId:'translation-budget',status:'mismatch',observedAt:1,nextDueAt:2,mismatchSince:1,consecutiveMismatches:2,lastErrorAt:null,lastErrorCode:null,consecutiveFailures:0},
  {kind:'ai',budgetId:'budget',status:null,observedAt:null,nextDueAt:0,mismatchSince:null,consecutiveMismatches:0,lastErrorAt:null,lastErrorCode:null,consecutiveFailures:0}],truncated:false};
 let payload:unknown=summary;const calls:{url:string;init:RequestInit}[]=[];t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json(payload);});
 assert.deepEqual(await readBudgetReconciliationSummary('company','member'),summary);assert.equal(calls[0].url,'/api/companies/company/budget-audits');assert.equal(new Headers(calls[0].init.headers).get('X-DingBell-Member-Id'),'member');
 for(payload of [{...summary,companyId:'other'},{...summary,totals:{...summary.totals,tracked:3}},{...summary,items:[{...summary.items[0],status:'balanced'}]},{...summary,items:[{...summary.items[0],lastErrorCode:'DETAIL'}]}])
  await assert.rejects(readBudgetReconciliationSummary('company','member'),{code:'INVALID_RESPONSE'});
});
test('exact signed audit amounts format without Number precision loss',()=>{
 assert.equal(formatAuditMicros('-9007199254740991000001'),'-$9,007,199,254,740,991.000001');assert.equal(formatAuditMicros('1'),'$0.000001');assert.throws(()=>formatAuditMicros('1.1'));
});
