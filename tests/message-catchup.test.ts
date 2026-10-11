import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationsFixture } from './fixtures/conversations.ts';
type Fixture=Awaited<ReturnType<typeof conversationsFixture>>;
async function append(f:Fixture,id:string,at:number,body=['new '+id]) {
  await f.DB.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES (?,'company','store-a','conv-a',?,'Customer','inbound',?,0,0,?,400,'backfill')").bind(id,id,JSON.stringify(body),at).run();
}
const encoded=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
const decoded=(value:string)=>JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
const page=(cursor:string,limit=1)=>`/conv-a/messages?limit=${limit}&cursor=${encodeURIComponent(cursor)}`;
const updates=(cursor:string,limit=1)=>`/conv-a/message-updates?limit=${limit}&cursor=${encodeURIComponent(cursor)}`;
async function read(f:Fixture,path:string,actor='owner') {const response=await f.request(path,actor);assert.equal(response.status,200,path);return await response.json() as any;}

test('stable message pages exclude late imports while the append feed includes every committed record',{timeout:30_000},async t=>{
  const f=await conversationsFixture();t.after(f.close);
  const first=await read(f,'/conv-a/messages?limit=1');assert.equal(typeof first.pageCursor,'string');assert.equal(typeof first.updatesCursor,'string');assert.equal(first.viewerMemberId,'owner-member');
  assert.deepEqual(first.messages.map((m:any)=>m.id),['msg-a2']);
  await append(f,'zzz-same-time',300);await append(f,'late-history',1);
  const repeat=await read(f,page(first.pageCursor)),older=await read(f,page(first.nextCursor));
  assert.deepEqual(repeat.messages,first.messages);assert.equal(repeat.updatesCursor,first.updatesCursor);assert.deepEqual(older.messages.map((m:any)=>m.id),['msg-a1']);assert.equal(older.nextCursor,null);
  const next=await read(f,updates(first.updatesCursor,10));assert.deepEqual(next.messages.map((m:any)=>m.id),['zzz-same-time','late-history']);assert.deepEqual(next.messages.map((m:any)=>m.sequence),[3,4]);assert.equal(next.hasMore,false);
  const idle=await read(f,updates(next.nextCursor,10));assert.deepEqual(idle.messages,[]);assert.equal(idle.nextCursor,next.nextCursor);
  const fresh=await read(f,'/conv-a/messages?limit=10');assert.deepEqual(fresh.messages.map((m:any)=>m.id),['late-history','msg-a1','msg-a2','zzz-same-time']);
  const empty=await read(f,'/conv-empty/messages');assert.deepEqual(empty.messages,[]);assert.equal(typeof empty.pageCursor,'string');assert.equal(typeof empty.updatesCursor,'string');
});

test('append pagination freezes a finite batch, tolerates deleted sequence gaps, and rejects unsafe cursor bounds',{timeout:30_000},async t=>{
  const f=await conversationsFixture();t.after(f.close);const first=await read(f,'/conv-a/messages');assert.equal(typeof first.updatesCursor,'string');
  await append(f,'next-3',400);await append(f,'next-4',0);const next=await read(f,updates(first.updatesCursor));assert.equal(next.hasMore,true);assert.deepEqual(next.messages.map((m:any)=>m.id),['next-3']);
  await append(f,'next-5',500);const end=await read(f,updates(next.nextCursor));assert.equal(end.hasMore,false);assert.deepEqual(end.messages.map((m:any)=>m.id),['next-4']);
  assert.deepEqual((await read(f,updates(next.nextCursor))).messages,end.messages);
  const later=await read(f,updates(end.nextCursor));assert.deepEqual(later.messages.map((m:any)=>m.id),['next-5']);assert.equal(later.hasMore,false);
  await append(f,'deleted-6',600);await f.DB.prepare("DELETE FROM message WHERE id='deleted-6'").run();const gap=await read(f,updates(later.nextCursor));assert.deepEqual(gap.messages,[]);
  await append(f,'after-gap-7',100);const afterGap=await read(f,updates(gap.nextCursor));assert.deepEqual(afterGap.messages.map((m:any)=>[m.id,m.sequence]),[['after-gap-7',7]]);
  const token=decoded(gap.nextCursor);
  for(const cursor of [encoded({...token,after:8}),encoded({...token,after:-1}),encoded({...token,after:1.1}),encoded({...token,through:8}),encoded({...token,through:1}),encoded({...token,extra:true}),encoded({...token,after:Number.MAX_SAFE_INTEGER+1})])assert.equal((await f.request(updates(cursor))).status,400);
});

test('append and history cursors bind current membership and every read still checks store authorization',{timeout:30_000},async t=>{
  const f=await conversationsFixture();t.after(f.close);const first=await read(f,'/conv-a/messages?limit=1','staff');assert.equal(typeof first.updatesCursor,'string');
  for(const path of ['/conv-a/message-updates','/conv-a/message-updates?cursor=','/conv-a/message-updates?cursor=%','/conv-a/message-updates?offset=1',updates(first.updatesCursor)+'&limit=1',updates(first.updatesCursor)+'&unknown=x',updates(first.pageCursor),page(first.updatesCursor)])assert.equal((await f.request(path,'staff')).status,400,path);
  assert.equal((await f.request('/conv-b/message-updates?cursor='+encodeURIComponent(first.updatesCursor),'staff')).status,400);
  await f.DB.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
  for(const path of [page(first.pageCursor),updates(first.updatesCursor)]){const response=await f.request(path,'staff');assert.equal(response.status,404);assert.equal('nextCursor'in(await response.json() as any),false);}
  await f.DB.batch([f.DB.prepare("DELETE FROM member WHERE id='staff-member'"),f.DB.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('rejoined','company','staff','member',2)"),f.DB.prepare("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES ('company','store-a','rejoined',2)")]);
  assert.equal((await f.request(page(first.pageCursor),'staff')).status,400);assert.equal((await f.request(updates(first.updatesCursor),'staff')).status,400);assert.equal((await read(f,'/conv-a/messages','staff')).viewerMemberId,'rejoined');
  const legacy={v:1,kind:'messages',orgId:'company',conversationId:'conv-a',at:300,id:'msg-a2'};assert.equal((await f.request(page(encoded(legacy)))).status,400);
});

test('append body budgets progress by actual delivered records and preserve oversized original messages',{timeout:30_000},async t=>{
  const f=await conversationsFixture();t.after(f.close);const first=await read(f,'/conv-a/messages');assert.equal(typeof first.updatesCursor,'string');
  const bodies=['x'.repeat(940*1024),'Б'.repeat(300_000),'Б'.repeat(300_000)];for(let i=0;i<bodies.length;i++)await append(f,'large-'+i,100,[bodies[i]]);
  let cursor=first.updatesCursor;const ids:string[]=[];
  for(let i=0;i<3;i++){const result=await read(f,updates(cursor,100));assert.equal(result.messages.length,1);assert.equal(result.messages[0].content[0],bodies[i]);ids.push(result.messages[0].id);assert.equal(result.hasMore,i<2);cursor=result.nextCursor;}
  assert.deepEqual(ids,['large-0','large-1','large-2']);assert.deepEqual((await read(f,updates(cursor,100))).messages,[]);
});

function beforeMessageRead(db:D1Database,hook:()=>Promise<void>):D1Database {
  function statement(target:D1PreparedStatement):D1PreparedStatement {
    return new Proxy(target,{get(value,key){
      if(key==='bind')return (...args:unknown[])=>statement(value.bind(...args));
      if(key==='all')return async()=>{await hook();return value.all();};
      const result=Reflect.get(value,key);return typeof result==='function'?result.bind(value):result;
    }});
  }
  return new Proxy(db,{get(target,key){
    if(key==='prepare')return (sql:string)=>sql.includes('JOIN message_append AS appended')?statement(target.prepare(sql)):target.prepare(sql);
    const result=Reflect.get(target,key);return typeof result==='function'?result.bind(target):result;
  }});
}

test('message reads recheck grants inside the final SQL and keep database failure distinct from an empty authorized page',{timeout:30_000},async t=>{
  const f=await conversationsFixture();t.after(f.close);const first=await read(f,'/conv-a/messages','staff');
  for(const path of [page(first.pageCursor),updates(first.updatesCursor)]){
    let calls=0;const DB=beforeMessageRead(f.DB,async()=>{calls++;await f.DB.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();});
    const response=await f.app.request(f.env.APP_BASE_URL+'/api/companies/company/conversations'+path,{headers:{cookie:f.cookies.staff}},{...f.env,DB} as never);
    assert.equal(calls,1);assert.equal(response.status,404);const body=await response.json() as any;assert.equal(body.error.code,'NOT_FOUND');assert.equal('nextCursor'in body,false);assert.equal('messages'in body,false);
    assert.equal(response.headers.get('cache-control'),'no-store');
    await f.DB.prepare("INSERT INTO store_grant VALUES ('company','store-a','staff-member',1)").run();
  }
  const DB=beforeMessageRead(f.DB,async()=>{throw new Error('synthetic append database failure');});
  const response=await f.app.request(f.env.APP_BASE_URL+'/api/companies/company/conversations'+updates(first.updatesCursor),{headers:{cookie:f.cookies.staff}},{...f.env,DB} as never);
  assert.equal(response.status,503);const body=await response.json() as any;assert.equal('messages'in body,false);assert.equal('nextCursor'in body,false);
});

test('history bounds are validated and append reads reject expired sessions and unverified accounts',{timeout:30_000},async t=>{
  const f=await conversationsFixture();t.after(f.close);const first=await read(f,'/conv-a/messages','staff'),token=decoded(first.pageCursor);
  for(const changed of [{snapshot:3},{snapshot:-1},{snapshot:1.1},{snapshot:Number.MAX_SAFE_INTEGER+1},{edge:{at:0,id:'',direction:'older',inclusive:false}},{edge:{at:-1,id:'m',direction:'older',inclusive:false}},{edge:{at:1.1,id:'m',direction:'older',inclusive:false}},{edge:{at:2,id:'m',direction:'wrong',inclusive:false}},{edge:{at:2,id:'m',direction:'older',inclusive:'true'}},{viewerMemberId:'owner-member'}]){
    assert.equal((await f.request(page(encoded({...token,...changed})),'staff')).status,400);
  }
  assert.equal((await f.request(updates(first.updatesCursor),'anonymous')).status,401);assert.equal((await f.request(updates(first.updatesCursor),'other')).status,404);
  assert.equal((await f.request(updates(first.updatesCursor),'owner')).status,400);
  await f.DB.prepare("UPDATE user SET email_verified=0 WHERE id='staff'").run();assert.equal((await f.request(updates(first.updatesCursor),'staff')).status,401);
  await f.DB.prepare("UPDATE user SET email_verified=1 WHERE id='staff'").run();await f.DB.prepare("UPDATE session SET expires_at=1 WHERE user_id='staff'").run();assert.equal((await f.request(updates(first.updatesCursor),'staff')).status,401);
});

test('4D3 history can navigate both directions and restore an inclusive anchor without crossing its snapshot',{timeout:30_000},async t=>{
  const f=await conversationsFixture();t.after(f.close);
  for(const id of ['msg-a3','msg-a4','msg-a5'])await append(f,id,300);
  const latest=await read(f,'/conv-a/messages?limit=2');assert.equal(latest.newerCursor,null);
  assert.deepEqual(latest.messages.map((m:any)=>m.id),['msg-a4','msg-a5']);
  const older=await read(f,page(latest.nextCursor,2));assert.deepEqual(older.messages.map((m:any)=>m.id),['msg-a2','msg-a3']);assert.equal(typeof older.newerCursor,'string');
  assert.deepEqual((await read(f,page(older.newerCursor,2))).messages,latest.messages);
  const oldest=await read(f,page(older.nextCursor,2));assert.deepEqual(oldest.messages.map((m:any)=>m.id),['msg-a1']);assert.equal(oldest.nextCursor,null);
  await append(f,'msg-a0',1);await append(f,'msg-a6',300);
  const anchored=await read(f,page(latest.pageCursor,2)+'&anchorId=msg-a3&direction=from');assert.deepEqual(anchored.messages.map((m:any)=>m.id),['msg-a3','msg-a4']);
  assert.deepEqual((await read(f,page(anchored.pageCursor,2))).messages,anchored.messages);
  assert.deepEqual((await read(f,page(anchored.nextCursor,2))).messages.map((m:any)=>m.id),['msg-a1','msg-a2']);
  assert.deepEqual((await read(f,page(anchored.newerCursor,2))).messages.map((m:any)=>m.id),['msg-a5']);
  for(const [direction,expected]of [['older',['msg-a1','msg-a2']],['newer',['msg-a4','msg-a5']]] as const){
    assert.deepEqual((await read(f,page(latest.pageCursor,2)+'&anchorId=msg-a3&direction='+direction)).messages.map((m:any)=>m.id),expected);
  }
  for(const anchor of ['msg-a0','msg-a6','msg-b','missing'])assert.equal((await f.request(page(latest.pageCursor)+'&anchorId='+anchor+'&direction=from')).status,404);
  for(const query of ['&anchorId=msg-a3','&direction=from','&anchorId=msg-a3&direction=wrong','&anchorId=&direction=from'])assert.equal((await f.request(page(latest.pageCursor)+query)).status,400);
  assert.equal((await f.request('/conv-a/messages?anchorId=msg-a3&direction=from')).status,400);
  assert.equal((await f.request(page(encoded({...decoded(latest.pageCursor),v:2,before:null})))).status,400);
});

test('4D3 updates issue a history checkpoint only through delivered messages including deletion gaps',{timeout:30_000},async t=>{
  const f=await conversationsFixture();t.after(f.close);const first=await read(f,'/conv-a/messages');
  await append(f,'third',500);await append(f,'fourth',50);
  const partial=await read(f,updates(first.updatesCursor));assert.equal(typeof partial.historyCursor,'string');
  assert.deepEqual((await read(f,page(partial.historyCursor,100))).messages.map((m:any)=>m.id),['msg-a1','msg-a2','third']);
  const restored=await read(f,page(partial.historyCursor,100)),end=await read(f,updates(restored.updatesCursor,100));
  assert.deepEqual(end.messages.map((m:any)=>m.id),['fourth']);assert.equal(decoded(end.historyCursor).snapshot,4);
  await append(f,'gone',600);await f.DB.prepare("DELETE FROM message WHERE id='gone'").run();
  const gap=await read(f,updates(end.nextCursor));assert.equal(decoded(gap.historyCursor).snapshot,5);assert.deepEqual(gap.messages,[]);
});

test('4D3 anchor reads keep byte budgets and recheck authorization after resolving the anchor',{timeout:30_000},async t=>{
  const f=await conversationsFixture();t.after(f.close);
  await append(f,'big-a',301,['Б'.repeat(300_000)]);await append(f,'big-b',302,['Б'.repeat(300_000)]);
  const first=await read(f,'/conv-a/messages','staff'),path=page(first.pageCursor,100)+'&anchorId=big-a&direction=from';
  const anchored=await read(f,path,'staff');assert.deepEqual(anchored.messages.map((m:any)=>m.id),['big-a']);assert.equal(typeof anchored.newerCursor,'string');
  assert.deepEqual((await read(f,page(anchored.newerCursor,100),'staff')).messages.map((m:any)=>m.id),['big-b']);
  let calls=0;const DB=beforeMessageRead(f.DB,async()=>{calls++;await f.DB.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();});
  const response=await f.app.request(f.env.APP_BASE_URL+'/api/companies/company/conversations'+path,{headers:{cookie:f.cookies.staff}},{...f.env,DB} as never);
  assert.equal(calls,1);assert.equal(response.status,404);assert.equal('messages'in(await response.json() as any),false);
});
