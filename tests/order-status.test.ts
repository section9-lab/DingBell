import assert from 'node:assert/strict';import {test} from 'node:test';import {orderStatusLabel,orderStatusRaw,orderSubstatusLabel} from '../src/shared/order-status.ts';
test('order status labels translate the documented Ozon statuses and keep unknown values visible',()=>{
 for(const [status,label] of [['awaiting_packaging','等待打包'],['awaiting_deliver','等待装运'],['delivering','配送中'],['delivered','已送达'],['cancelled','已取消'],['not_accepted','分拣中心未接收'],['CANCELLED','已取消']]) assert.equal(orderStatusLabel({status}),label);
 assert.equal(orderStatusLabel({status:null}),'等待详情');
 assert.equal(orderStatusLabel({status:''},'平台未提供'),'平台未提供');
 assert.equal(orderStatusLabel({status:'provider_specific_status'}),'provider_specific_status');
 assert.equal(orderStatusRaw({status:'delivered'}),'delivered');
 assert.equal(orderStatusRaw({status:null}),undefined);
});
test('FBP numeric statuses resolve through the synced code table even without the statusIsCode flag',()=>{
 for(const [code,label] of [['300','等待打包'],['380','已送达'],['390','已取消'],['3050','配送中'],['3090','配送中'],['3308','等待装运']]){
  assert.equal(orderStatusLabel({status:code,statusIsCode:true}),label);
  assert.equal(orderStatusLabel({status:code}),label);
 }
 assert.equal(orderStatusRaw({status:'3050',statusIsCode:true,substatus:'delivering'}),'平台状态码 3050 · 子状态 delivering');
 assert.equal(orderStatusRaw({status:'380',statusIsCode:true}),'平台状态码 380');
});
test('an unseen FBP code falls back to the substatus name and only then to the bare code',()=>{
 assert.equal(orderStatusLabel({status:'4001',statusIsCode:true,substatus:'delivering'}),'配送中');
 assert.equal(orderStatusLabel({status:'4001',statusIsCode:true,substatus:'posting_in_pickup_point'}),'已在取货点');
 assert.equal(orderStatusLabel({status:'4001',statusIsCode:true,substatus:'provider_specific_status'}),'未识别状态（平台码 4001）');
 assert.equal(orderStatusLabel({status:'4001',statusIsCode:true}),'未识别状态（平台码 4001）');
 assert.equal(orderStatusLabel({status:'12',statusIsCode:true,substatus:'provider_specific_status'}),'未识别状态（平台码 12）');
});
test('order substatus labels translate documented codes and fall back to the raw value',()=>{
 assert.equal(orderSubstatusLabel('posting_transferring_to_delivery'),'转交配送');
 assert.equal(orderSubstatusLabel('posting_in_pickup_point'),'已在取货点');
 assert.equal(orderSubstatusLabel('delivered'),'已送达');
 assert.equal(orderSubstatusLabel('provider_specific_status'),'provider_specific_status');
 assert.equal(orderSubstatusLabel(null),null);
});
