/// <reference types="node" />
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readOrderPostings,readOrderPosting} from './commerce-api.ts';
const posting={fulfillmentType:'fbo',postingNumber:'parcel',store:{id:'store',name:'Store'},orderId:'1',orderNumber:'order',status:'delivered',productCount:0,previewProduct:null,trackingNumber:null,inProcessAt:null,shipmentDate:null,deliveringDate:null,state:'complete',error:null,source:'details',observedAt:null};
const page={companyId:'company',storeId:'store',postings:[posting],totalOrders:1,totalPostings:1,totalPages:1,nextCursor:null};
test('order-center reads reject unknown modes and cross-store or cross-filter receipts',async t=>{
 for(const row of [{...posting,fulfillmentType:'fbp'},{...posting,fulfillmentType:'fbs'},{...posting,store:{id:'other',name:'Other'}}]){
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({...page,postings:[row]}));
  await assert.rejects(readOrderPostings('company',{storeId:'store',fulfillment:'fbo'}),{code:'INVALID_RESPONSE'});mock.mock.restore();
 }
 const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(page));
 assert.equal((await readOrderPostings('company',{storeId:'store',fulfillment:'all'})).postings[0].fulfillmentType,'fbo');mock.mock.restore();
});
test('business time sources and undated counts survive parsing and reject invented sources',async t=>{
 const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({...page,undatedPostings:4,postings:[{...posting,orderDate:null,orderTime:'2026-06-01T09:00:00Z',orderTimeSource:'in_process_at'}]}));
 const result=await readOrderPostings('company',{storeId:'store',fulfillment:'all',fromDate:'2026-06-01',toDate:'2026-11-02'});
 assert.equal(result.undatedPostings,4);assert.equal(result.postings[0].orderDate,null);assert.equal(result.postings[0].orderTime,'2026-06-01T09:00:00Z');assert.equal(result.postings[0].orderTimeSource,'in_process_at');mock.mock.restore();
 for(const payload of [{...page,undatedPostings:-1},{...page,postings:[{...posting,orderTimeSource:'observed_at'}]}]){
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(payload));
  await assert.rejects(readOrderPostings('company',{storeId:'store',fulfillment:'all'}),{code:'INVALID_RESPONSE'});mock.mock.restore();
 }
});

test('parcel detail reads bind store, mode and complete posting identifier',async t=>{
 for(const row of [{...posting,fulfillmentType:'fbs'},{...posting,postingNumber:'other'},{...posting,store:{id:'other',name:'Other'}}]){
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({companyId:'company',posting:{...row,products:[]}}));
  await assert.rejects(readOrderPosting('company','store','fbo','parcel'),{code:'INVALID_RESPONSE'});mock.mock.restore();
 }
 const calls:string[]=[];t.mock.method(globalThis,'fetch',async(path:string)=>{calls.push(path);return Response.json({companyId:'company',posting:{...posting,products:[]}});});
 await readOrderPosting('company','store','fbo','parcel');assert.deepEqual(calls,['/api/companies/company/commerce/postings/fbo/parcel?storeId=store']);
});
