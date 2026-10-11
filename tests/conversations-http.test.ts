import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationsFixture } from './fixtures/conversations.ts';

test('conversation reads expose only authorized imported facts with exact IDs and explicit scope', {timeout:30_000}, async()=>{
  const f=await conversationsFixture();
  try {
    const response=await f.request();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const result=await response.json() as any;assert.equal(result.companyId,'company');
    assert.equal(result.viewerMemberId,'owner-member');assert.deepEqual(result.counts,{all:3,mine:0,unassigned:3});
    assert.deepEqual(result.conversations.map((item:any)=>item.id),['conv-a','conv-b','conv-empty']);
    const item=result.conversations[0];assert.equal(item.store.name,'可见店铺');assert.equal(item.store.status,'paused');assert.equal(item.platformThreadId,'18446744073709551615');
    assert.equal(item.platformCreatedAt,new Date(100).toISOString());assert.equal(item.latestMessage.platformMessageId,'18446744073709551615');
    assert.equal('customerName'in item,false);assert.equal('credentialCiphertext'in item.store,false);
    assert.deepEqual(item.workflow,{version:0,lifecycle:'open',workStatus:'needs_reply',assignedMemberId:null,assigneeName:null});
    const detail=await (await f.request('/conv-a')).json() as any;assert.equal(detail.companyId,'company');assert.equal(detail.conversation.id,'conv-a');assert.equal(detail.conversation.sync.enabled,false);
    assert.equal('workflow'in detail.conversation,false);assert.equal('viewerMemberId'in detail,false);assert.equal('counts'in detail,false);
    const messages=await (await f.request('/conv-a/messages')).json() as any;assert.equal(messages.companyId,'company');assert.equal(messages.conversationId,'conv-a');
    assert.deepEqual(messages.messages.map((item:any)=>item.id),['msg-a1','msg-a2']);assert.equal(messages.messages[0].platformMessageId,'18446744073709551614');
    assert.equal(messages.messages[0].senderId,'9007199254740993');assert.deepEqual(messages.messages[0].content,['Здравствуйте','<script>not HTML</script>']);
    assert.equal(messages.messages[0].orderNumber,'order-1');assert.equal(messages.messages[0].eventAt,new Date(200).toISOString());assert.equal('isRead'in messages.messages[0],false);
    assert.deepEqual((await (await f.request('/conv-empty/messages')).json() as any).messages,[]);
    assert.equal((await f.request('/conv-a','owner','company','POST')).status,404);
  }finally{await f.close();}
});

async function seedWorkflow(f:Awaited<ReturnType<typeof conversationsFixture>>) {
  await f.DB.prepare(`INSERT INTO conversation_control (conversation_id,organization_id,store_id,controller_id,schema_version,version,control_epoch,sequence,lifecycle,reception,work_status,assigned_member_id,updated_at,repair_due_at)
    VALUES ('conv-a','company','store-a','controller-a',2,4,4,4,'open','human','waiting_customer','staff-member',400,500),
      ('conv-b','company','store-b','controller-b',2,2,2,2,'resolved','human',NULL,'owner-member',300,500)`).run();
}

test('conversation queues return list workflow and scoped counts independent of queue and pagination', {timeout:30_000},async()=>{
  const f=await conversationsFixture();
  try {
    await seedWorkflow(f);
    for(const [query,ids,counts] of [
      ['?queue=all&state=all&limit=1',['conv-a'],{all:3,mine:1,unassigned:1}],
      ['?queue=mine&state=all',['conv-b'],{all:3,mine:1,unassigned:1}],
      ['?queue=unassigned&state=all',['conv-empty'],{all:3,mine:1,unassigned:1}],
      ['?queue=all&state=needs_reply',['conv-empty'],{all:1,mine:0,unassigned:1}],
      ['?queue=all&state=waiting_customer',['conv-a'],{all:1,mine:0,unassigned:0}],
      ['?queue=all&state=waiting_internal',[],{all:0,mine:0,unassigned:0}],
      ['?queue=mine&state=resolved',['conv-b'],{all:1,mine:1,unassigned:0}],
      ['?storeId=store-a&queue=all',['conv-a','conv-empty'],{all:2,mine:0,unassigned:1}],
      ['?searchField=thread&search=18446744073709551615&queue=mine',[],{all:1,mine:0,unassigned:0}],
    ] as const) {
      const response=await f.request(query);assert.equal(response.status,200,query);const result=await response.json() as any;
      assert.equal(result.viewerMemberId,'owner-member');assert.deepEqual(result.counts,counts,query);assert.deepEqual(result.conversations.map((item:any)=>item.id),ids,query);
    }
    const staff=await (await f.request('?queue=mine','staff')).json() as any;
    assert.equal(staff.viewerMemberId,'staff-member');assert.deepEqual(staff.counts,{all:2,mine:1,unassigned:1});assert.deepEqual(staff.conversations.map((item:any)=>item.id),['conv-a']);
    assert.deepEqual(staff.conversations[0].workflow,{version:4,lifecycle:'open',workStatus:'waiting_customer',assignedMemberId:'staff-member',assigneeName:'staff'});
    const detail=await (await f.request('/conv-a')).json() as any;assert.equal('workflow'in detail.conversation,false);assert.equal('counts'in detail,false);
    await f.DB.prepare("UPDATE user SET name='客服新名字' WHERE id='staff'").run();
    const renamed=await (await f.request('?state=waiting_customer')).json() as any;assert.equal(renamed.conversations[0].workflow.assigneeName,'客服新名字');assert.equal(renamed.conversations[0].workflow.version,4);
    await f.DB.prepare("DELETE FROM member WHERE id='staff-member'").run();
    const removed=await (await f.request()).json() as any;assert.equal(removed.conversations[0].workflow.assignedMemberId,'staff-member');assert.equal(removed.conversations[0].workflow.assigneeName,null);assert.deepEqual(removed.counts,{all:3,mine:1,unassigned:1});
    assert.equal(await f.DB.prepare('SELECT count(*) AS n FROM conversation_control').first('n'),2,'reading must not initialize conv-empty');
  } finally {await f.close();}
});

test('conversation queue queries reject invalid values and bind pagination to state, queue and current membership', {timeout:30_000},async()=>{
  const f=await conversationsFixture();
  try {
    for(const suffix of ['?queue=','?queue=ALL','?queue=owner-member','?queue=all&queue=mine','?state=','?state=waiting','?state=open','?state=all&state=resolved','/conv-a?queue=all','/conv-a/messages?state=all']) {
      const response=await f.request(suffix);assert.equal(response.status,400,suffix);assert.equal((await response.json() as any).error.code,'INVALID_REQUEST');
    }
    const response=await f.request('?queue=all&state=all&limit=1');assert.equal(response.status,200);const first=await response.json() as any;
    assert.deepEqual(first.counts,{all:3,mine:0,unassigned:3});
    const second=await (await f.request(`?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json() as any;
    assert.deepEqual(second.counts,first.counts);assert.equal(second.conversations[0].id,'conv-b');
    for(const filter of ['queue=mine','queue=unassigned','state=needs_reply'])assert.equal((await f.request(`?${filter}&cursor=${encodeURIComponent(first.nextCursor)}`)).status,400);
    const decoded=JSON.parse(Buffer.from(first.nextCursor,'base64url').toString('utf8'));
    assert.equal(decoded.v,2);assert.equal(decoded.viewerMemberId,'owner-member');
    const legacy={v:1,kind:decoded.kind,orgId:decoded.orgId,storeId:decoded.storeId,search:decoded.search,at:decoded.at,id:decoded.id};
    assert.equal((await f.request(`?cursor=${Buffer.from(JSON.stringify(legacy)).toString('base64url')}`)).status,400);
    const staff=await (await f.request('?limit=1','staff')).json() as any;
    await f.DB.batch([
      f.DB.prepare("DELETE FROM member WHERE id='staff-member'"),
      f.DB.prepare("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('replacement-member','company','staff','member',2)"),
      f.DB.prepare("INSERT INTO store_grant (organization_id,store_id,member_id,created_at) VALUES ('company','store-a','replacement-member',2)"),
    ]);
    assert.equal((await f.request(`?cursor=${encodeURIComponent(staff.nextCursor)}`,'staff')).status,400);
    assert.equal((await (await f.request('','staff')).json() as any).viewerMemberId,'replacement-member');
  } finally {await f.close();}
});

function beforeListRead(db:D1Database,hook:()=>Promise<void>):D1Database {
  function statement(target:D1PreparedStatement):D1PreparedStatement {
    return new Proxy(target,{get(value,property){
      if(property==='bind')return (...args:unknown[])=>statement(value.bind(...args));
      if(['all','first','raw'].includes(String(property)))return async (...args:unknown[])=>{
        await hook();return (Reflect.get(value,property) as Function).apply(value,args);
      };
      const member=Reflect.get(value,property);return typeof member==='function'?member.bind(value):member;
    }});
  }
  return new Proxy(db,{get(target,property){
    if(property==='prepare')return (sql:string)=>{
      const prepared=target.prepare(sql);return sql.includes('conversation')&&sql.includes('last_message_at')&&sql.includes('LIMIT')?statement(prepared):prepared;
    };
    const member=Reflect.get(target,property);return typeof member==='function'?member.bind(target):member;
  }});
}

test('conversation list rejects membership revoked after HTTP precheck rather than returning empty counts', {timeout:30_000},async()=>{
  const f=await conversationsFixture();
  try {
    let reads=0;
    const DB=beforeListRead(f.DB,async()=>{reads++;await f.DB.prepare("DELETE FROM member WHERE id='staff-member'").run();});
    const response=await f.app.request(`${f.env.APP_BASE_URL}/api/companies/company/conversations`,{headers:{cookie:f.cookies.staff}},{...f.env,DB} as never);
    assert.equal(reads,1);assert.equal(response.status,404);assert.equal((await response.json() as any).error.code,'NOT_FOUND');
    assert.equal(response.headers.get('cache-control'),'no-store');assert.ok(response.headers.get('x-request-id'));
  } finally {await f.close();}
});

test('conversation list database errors remain unavailable and never become zero queue counts', {timeout:30_000},async()=>{
  const f=await conversationsFixture();
  try {
    let reads=0;const DB=beforeListRead(f.DB,async()=>{reads++;throw new Error('synthetic final list read failure');});
    const response=await f.app.request(`${f.env.APP_BASE_URL}/api/companies/company/conversations`,{headers:{cookie:f.cookies.staff}},{...f.env,DB} as never);
    assert.equal(reads,1);assert.equal(response.status,503);assert.equal((await response.json() as any).error.code,'IDENTITY_UNAVAILABLE');
    assert.equal(response.headers.get('cache-control'),'no-store');assert.ok(response.headers.get('x-request-id'));
  } finally {await f.close();}
});

test('conversations enforce current company membership, store grants and session at reads', {timeout:30_000},async()=>{
  const f=await conversationsFixture();
  try {
    assert.equal((await f.request('','anonymous')).status,401);
    for(const suffix of ['', '/conv-a','/conv-a/messages'])assert.equal((await f.request(suffix,'other')).status,404);
    const visible=await (await f.request('','staff')).json() as any;assert.deepEqual(visible.conversations.map((item:any)=>item.id),['conv-a','conv-empty']);
    for(const suffix of ['/conv-b','/conv-b/messages','?storeId=store-b','/conv-c'])assert.equal((await f.request(suffix,'staff')).status,404);
    await f.DB.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
    for(const suffix of ['/conv-a','/conv-a/messages','?storeId=store-a'])assert.equal((await f.request(suffix,'staff')).status,404);
    await f.DB.prepare("DELETE FROM member WHERE id='staff-member'").run();assert.equal((await f.request('','staff')).status,404);
    await f.DB.prepare("UPDATE user SET email_verified=0 WHERE id='owner'").run();assert.equal((await f.request()).status,401);
  }finally{await f.close();}
});

test('strict conversation queries reject unknown, duplicate, malformed and scoped pagination inputs', {timeout:30_000},async()=>{
  const f=await conversationsFixture();
  try {
    for(const suffix of ['?unknown=1','?limit=1&limit=2','?limit=0','?limit=101','?limit=1.2','?limit=01','?limit=','?search=x','?searchField=thread','?searchField=unknown&search=x','?searchField=thread&search=','?storeId=','?cursor=not-a-cursor','/conv-a?limit=1','/conv-a/messages?storeId=store-a','/conv-a/messages?cursor=','/conv-a/messages?limit=1&limit=2']) {
      const response=await f.request(suffix);assert.equal(response.status,400,suffix);assert.equal((await response.json() as any).error.code,'INVALID_REQUEST');
    }
    const first=await (await f.request('?limit=1')).json() as any;assert.equal(first.conversations.length,1);assert.ok(first.nextCursor);
    const next=await (await f.request(`?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json() as any;assert.equal(next.conversations[0].id,'conv-b');
    assert.equal((await f.request(`?storeId=store-a&cursor=${encodeURIComponent(first.nextCursor)}`)).status,400);
    const message=await (await f.request('/conv-a/messages?limit=1')).json() as any;assert.equal(message.messages[0].id,'msg-a2');assert.ok(message.nextCursor);
    const older=await (await f.request(`/conv-a/messages?limit=1&cursor=${encodeURIComponent(message.nextCursor)}`)).json() as any;assert.equal(older.messages[0].id,'msg-a1');assert.equal(older.nextCursor,null);
    assert.equal((await f.request(`/conv-b/messages?cursor=${encodeURIComponent(message.nextCursor)}`)).status,400);
    const exact=await (await f.request('?searchField=thread&search=18446744073709551615')).json() as any;assert.deepEqual(exact.conversations.map((item:any)=>item.id),['conv-a']);
    const order=await (await f.request('?searchField=order&search=order-1')).json() as any;assert.deepEqual(order.conversations.map((item:any)=>item.id),['conv-a']);
    assert.deepEqual((await (await f.request('?searchField=order&search=order')).json() as any).conversations,[]);
  }finally{await f.close();}
});
