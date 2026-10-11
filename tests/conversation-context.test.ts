import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationsFixture } from './fixtures/conversations.ts';
import { conversationContextSQL } from './fixtures/conversation-context.ts';
import { readMessageContext } from '../src/modules/conversations/context.ts';

test('message context reads require a stored reference and current store authorization', {timeout:60_000}, async()=>{
  const f=await conversationsFixture();
  try {
    const path='/conv-a/messages/msg-a1/context';
    const response=await f.request(path,'staff');assert.equal(response.status,200);
    const empty=await response.json() as any;
    assert.equal(empty.viewerMemberId,'staff-member');assert.equal(empty.storeId,'store-a');
    assert.deepEqual(empty.source,{kind:'ozon_message_context',messageId:'msg-a1',platformMessageId:'18446744073709551614',orderNumber:'order-1',sku:'9007199254740993',eventAt:new Date(200).toISOString(),receivedAt:new Date(400).toISOString()});
    assert.deepEqual(empty.product,{state:'not_imported',item:null});
    assert.deepEqual(empty.order,{state:'not_imported',orderId:null,postings:[],nextPosting:null});
    const noReference=await (await f.request('/conv-a/messages/msg-a2/context')).json() as any;
    assert.equal(noReference.product.state,'not_provided');assert.equal(noReference.order.state,'not_provided');
    for(const suffix of ['/conv-b/messages/msg-a1/context','/conv-a/messages/msg-b/context','/conv-empty/messages/msg-a1/context','/missing/messages/msg-a1/context'])assert.equal((await f.request(suffix)).status,404,suffix);
    assert.equal((await f.request('/conv-b/messages/msg-b/context','staff')).status,404);
    assert.equal((await f.request(path,'other')).status,404);
    assert.equal((await f.request(path,'anonymous')).status,401);
    for(const query of ['?orderNumber=private-order','?sku=1','?afterPosting=','?afterPosting=a&afterPosting=b'])assert.equal((await f.request(path+query)).status,400);
    await f.DB.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
    assert.equal((await f.request(path,'staff')).status,404);
    assert.equal((await f.request(path)).status,200);
  }finally{await f.close();}
});

function beforeFinalSource(db:D1Database,hook:()=>Promise<void>) {
  let reads=0;
  function statement(target:D1PreparedStatement):D1PreparedStatement {
    return new Proxy(target,{get(value,property){
      if(property==='bind')return (...args:unknown[])=>statement(value.bind(...args));
      if(property==='first')return async()=>{if(++reads===2)await hook();return value.first();};
      const member=Reflect.get(value,property);return typeof member==='function'?member.bind(value):member;
    }});
  }
  return new Proxy(db,{get(target,property){
    if(property==='prepare')return (sql:string)=>sql.includes('message.id AS messageId')?statement(target.prepare(sql)):target.prepare(sql);
    const member=Reflect.get(target,property);return typeof member==='function'?member.bind(target):member;
  }});
}

test('context discards already loaded facts on final grant, membership, session or source loss', {timeout:60_000},async()=>{
  const f=await conversationsFixture();
  try {
    for(const sql of conversationContextSQL('company','store-a'))await f.DB.prepare(sql).run();
    const sessionId=await f.DB.prepare("SELECT id FROM session WHERE user_id='staff'").first<string>('id');assert.ok(sessionId);
    const actor={orgId:'company',actorUserId:'staff',sessionId};
    assert.equal((await readMessageContext(f.DB,actor,'conv-a','msg-a1'))?.product.state,'matched');
    const afterChange=(sql:string)=>readMessageContext(beforeFinalSource(f.DB,async()=>{await f.DB.prepare(sql).run();}),actor,'conv-a','msg-a1');
    assert.equal(await afterChange("DELETE FROM store_grant WHERE member_id='staff-member'"),null);
    await f.DB.prepare("INSERT INTO store_grant (organization_id,store_id,member_id,created_at) VALUES ('company','store-a','staff-member',1)").run();
    assert.equal(await afterChange("UPDATE session SET expires_at=1 WHERE user_id='staff'"),null);
    await f.DB.prepare("UPDATE session SET expires_at=unixepoch()*1000+3600000 WHERE user_id='staff'").run();
    assert.equal(await afterChange("UPDATE user SET email_verified=0 WHERE id='staff'"),null);
    await f.DB.prepare("UPDATE user SET email_verified=1 WHERE id='staff'").run();
    const replaced=beforeFinalSource(f.DB,async()=>{await f.DB.batch([
      f.DB.prepare("DELETE FROM member WHERE id='staff-member'"),
      f.DB.prepare("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('replacement','company','staff','admin',1)"),
    ]);});
    assert.equal(await readMessageContext(replaced,actor,'conv-a','msg-a1'),null);
    assert.equal((await readMessageContext(f.DB,actor,'conv-a','msg-a1'))?.viewerMemberId,'replacement');
    assert.equal(await afterChange("DELETE FROM message WHERE id='msg-a1'"),null);
  } finally {await f.close();}
});

test('structured references resolve exact store snapshots, SKU aliases and all split postings without guessing', {timeout:60_000}, async()=>{
  const f=await conversationsFixture();
  try {
    for(const store of ['store-a','store-b'])for(const sql of conversationContextSQL('company',store))await f.DB.prepare(sql).run();
    for(const sql of conversationContextSQL('other-company','store-c'))await f.DB.prepare(sql).run();
    const path='/conv-a/messages/msg-a1/context';
    const response=await f.request(path,'staff');assert.equal(response.status,200);
    const first=await response.json() as any;
    assert.equal(first.product.state,'matched');assert.equal(first.product.item.id,'901');assert.equal(first.product.item.name,'桌面收纳盒');assert.equal(first.product.item.skuSource,'details');
    assert.equal(first.product.item.price,'1099.00');assert.equal(first.product.item.factsObservedAt,new Date(600).toISOString());
    assert.equal(first.order.state,'matched');assert.equal(first.order.orderId,'801');assert.equal(first.order.postings.length,10);assert.equal(first.order.nextPosting,'order-1-10');
    const posting=first.order.postings[0];assert.equal(posting.status,'delivering');assert.equal(posting.source,'list');assert.equal(posting.observedAt,new Date(800).toISOString());assert.equal(posting.productCount,1);
    assert.equal(JSON.stringify(first).includes('DO_NOT_EXPOSE'),false);
    const second=await (await f.request(path+'?afterPosting='+first.order.nextPosting)).json() as any;
    assert.deepEqual(second.order.postings.map((p:any)=>p.postingNumber),['order-1-11','order-1-12']);assert.equal(second.order.nextPosting,null);
    // Newer detail observations replace the list as a whole, rather than mixing times and fields.
    await f.DB.prepare("UPDATE fbs_posting SET detail_observed_at=900 WHERE store_id='store-a' AND posting_number='order-1-01'").run();
    const newer=await (await f.request(path)).json() as any;assert.equal(newer.order.postings[0].status,'awaiting_deliver');assert.equal(newer.order.postings[0].source,'details');
    // A reference is not a prefix search for postings or a search of the message text.
    const noRef=await (await f.request('/conv-a/messages/msg-a2/context')).json() as any;assert.equal(noRef.order.state,'not_provided');
    await f.DB.prepare(`INSERT INTO message (id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode)
      VALUES ('body-only','company','store-a','conv-a','9999','Customer','inbound','["order-1 9007199254740993"]',0,0,500,600,'incremental')`).run();
    const bodyOnly=await (await f.request('/conv-a/messages/body-only/context')).json() as any;assert.equal(bodyOnly.order.state,'not_provided');assert.equal(bodyOnly.product.state,'not_provided');
    await f.DB.prepare("UPDATE fbs_posting SET order_id='802' WHERE store_id='store-a' AND posting_number='order-1-12'").run();
    const ambiguous=await (await f.request(path)).json() as any;assert.deepEqual(ambiguous.order,{state:'ambiguous',orderId:null,postings:[],nextPosting:null});
    await f.DB.prepare("INSERT INTO product (id,organization_id,store_id,listing,list_observed_at,detail_epoch,detail_generation,detail_due_at) VALUES ('902','company','store-a','{\"sku\":\"9007199254740993\",\"offerId\":\"OTHER\"}',500,1,1,1)").run();
    assert.equal((await (await f.request(path)).json() as any).product.state,'ambiguous');
    await f.DB.prepare("UPDATE product SET listing='{\"sku\":\"222\",\"offerId\":\"OTHER\"}' WHERE store_id='store-a' AND id='902'").run();
    assert.equal((await (await f.request(path)).json() as any).product.state,'matched');
    await f.DB.prepare("DELETE FROM product WHERE store_id='store-a' AND id='901'").run();
    assert.equal((await (await f.request(path)).json() as any).product.state,'not_imported','other stores must not fill the missing product');
  }finally{await f.close();}
});
