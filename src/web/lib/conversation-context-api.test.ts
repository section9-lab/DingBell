import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMessageContext } from './conversation-context-api.ts';

const source={id:'msg/1',platformMessageId:'18446744073709551614',orderNumber:'order-1',sku:null,eventAt:'2026-10-10T00:00:00.000Z',receivedAt:'2026-10-10T00:01:00.000Z'};
const scope={storeId:'store-a',viewerMemberId:'member-a'};
const data={companyId:'a/b',conversationId:'conv',...scope,source:{...source,messageId:source.id,kind:'ozon_message_context'},product:{state:'not_provided',item:null},order:{state:'not_imported',orderId:null,postings:[],nextPosting:null}};
const posting={postingNumber:'post-1',orderId:'other-order',status:'delivering',trackingNumber:null,productCount:1,source:'list',observedAt:source.receivedAt,listObservedAt:source.receivedAt,detailObservedAt:null};
test('message context client binds company, store, membership, conversation and exact source metadata',async t=>{
  let url='';t.mock.method(globalThis,'fetch',async(value:string)=>{url=value;return Response.json(data);});
  const result=await readMessageContext('a/b','conv',source,scope,undefined);
  assert.equal(result.source.messageId,source.id);assert.equal(url,'/api/companies/a%2Fb/conversations/conv/messages/msg%2F1/context');
});
test('message context client rejects changed scope, guessed reference, contradictory states and mixed orders',async t=>{
  for(const change of [{storeId:'other'}, {viewerMemberId:'new'}, {companyId:'other'}, {conversationId:'other'},
    {source:{...data.source,orderNumber:'other'}}, {source:{...data.source,receivedAt:'yesterday'}},
    {product:{state:'matched',item:null}}, {product:{state:'ambiguous',item:{id:'untrusted'}}},
    {order:{state:'matched',orderId:null,postings:[],nextPosting:null}}, {order:{state:'matched',orderId:'1',postings:[posting],nextPosting:null}}, {order:{state:'not_imported',orderId:'1',postings:[],nextPosting:'x'}}]) {
    const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({...data,...change}));
    await assert.rejects(readMessageContext('a/b','conv',source,scope),{code:'INVALID_RESPONSE'});mock.mock.restore();
  }
});
