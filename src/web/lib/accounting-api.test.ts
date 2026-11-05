import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readAccounting,readAccountingConfig,saveAccountingExpense} from './accounting-api.ts';
import type {AccountingOverview} from '../../shared/accounting.ts';
const filter={storeId:'store',fromDate:'2026-11-01',toDate:'2026-11-02',fulfillment:'all'} as const;
const response:AccountingOverview={companyId:'company',storeId:'store',timeZone:'UTC',fromDate:filter.fromDate,toDate:filter.toDate,postings:[],expenses:[],counts:{eligible:0,complete:0,frozen:0,excluded:0,undated:0,revenueKnown:0,purchaseKnown:0,currentEstimate:0},totals:{revenue:0,knownPurchase:0,knownContribution:0,cost:0,profit:0,margin:null,purchase:0,label:0,commission:0,freight:0,withdrawal:0,advertising:0,other:0},trend:[]};
test('accounting client includes exact scope and rejects wrong-company or malformed responses',async t=>{
  let body:unknown=response,url='';
  t.mock.method(globalThis,'fetch',async(value:string)=>{url=value;return Response.json(body);});
  assert.deepEqual(await readAccounting('company',filter),response);assert.equal(url,'/api/companies/company/accounting?storeId=store&fromDate=2026-11-01&toDate=2026-11-02&fulfillment=all');
  body={...response,companyId:'other'};await assert.rejects(readAccounting('company',filter),{code:'INVALID_RESPONSE'});
  body={...response,totals:{...response.totals,revenue:'0'}};await assert.rejects(readAccounting('company',filter),{code:'INVALID_RESPONSE'});
  body={rules:[],products:[],nextProductId:null};await readAccountingConfig('company','store','100');assert.ok(url.includes('after=100'));
});
test('expense writes carry a stable id and unconfirmed failures are not retried',async t=>{
  const input={id:crypto.randomUUID(),storeId:'store',date:'2026-11-01',category:'advertising',amount:'1.25',note:'report'} as const;
  const call=t.mock.method(globalThis,'fetch',async(_url:string,init:RequestInit)=>{assert.equal(init.method,'POST');assert.equal(JSON.parse(String(init.body)).id,input.id);throw new Error('network');});
  await assert.rejects(saveAccountingExpense('company',input),{code:'OPERATION_UNCONFIRMED'});assert.equal(call.mock.callCount(),1);
});
