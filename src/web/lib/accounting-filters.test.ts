import assert from 'node:assert/strict';
import {test} from 'node:test';
import {accountingSearch,resolveAccountingFilter} from './accounting-filters.ts';
test('workspace defaults to labelled current-cost preview instead of hiding newly imported cost inputs',()=>{
 const filter=resolveAccountingFilter('store','2026-11-02',new URLSearchParams());assert.equal(filter.costMode,'current_estimate');assert.equal(filter.fromDate,'2026-10-04');
});
test('dates, lane and explicit cost basis survive refresh and retain the store selection',()=>{
 const selected={storeId:'store',fromDate:'2026-10-01',toDate:'2026-10-07',fulfillment:'fbp',costMode:'historical'} as const;
 const params=accountingSearch(selected,new URLSearchParams('tab=overview'));assert.equal(params.get('store'),'store');assert.equal(params.get('tab'),'overview');assert.deepEqual(resolveAccountingFilter('store','2026-11-02',params),selected);
});
test('invalid periods or modes fall back to a bounded date range',()=>{
 for(const input of ['fromDate=2026-02-30','fromDate=1900-01-01&toDate=2026-11-02','costMode=not-a-mode'])assert.equal(resolveAccountingFilter('store','2026-11-02',new URLSearchParams(input)).fromDate,'2026-10-04');
 const wide=resolveAccountingFilter('store','2026-11-02',new URLSearchParams('fromDate=2025-01-01&toDate=2026-11-02'));assert.equal(wide.fromDate,'2025-01-01','ranges longer than one year are supported');
});
