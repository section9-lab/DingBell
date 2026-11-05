import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pushFixture as fixture} from './fixtures/ozon-push.ts';

test('a manager can prepare a private callback and Ozon can validate it without a browser session',{timeout:60_000},async t=>{
 const f=await fixture();t.after(f.close);
 const prepared=await f.manage({operation:'prepare',expectedRevision:0});assert.equal(prepared.status,200,await prepared.clone().text());
 const result=await prepared.json() as {push:{revision:number;mode:string;callbackUrl:string}};assert.equal(result.push.mode,'prepared');assert.equal(result.push.revision,1);assert.ok(result.push.callbackUrl.startsWith(f.env.APP_BASE_URL+'/api/ozon/push/'));
 const ping=await f.callback(result.push.callbackUrl,{message_type:'TYPE_PING',time:new Date().toISOString()});assert.equal(ping.status,200);const ack=await ping.json() as {name:string;version:string;time:string};assert.equal(ack.name,'DingBell');assert.equal(ack.version,'1');assert.ok(Number.isFinite(Date.parse(ack.time)));
 const state=await(await f.manage()).json() as {push:{lastPingAt:string;callbackUrl?:string}};assert.ok(state.push.lastPingAt);assert.equal(state.push.callbackUrl,undefined,'ordinary status reads must not disclose a callback credential');
});

test('callbacks are store-bound, durably deduplicated, and never import callback text as buyer messages',{timeout:60_000},async t=>{
 const f=await fixture();t.after(f.close);
 const result=await(await f.manage({operation:'prepare',expectedRevision:0,sellerId:'1'})).json() as {push:{callbackUrl:string}};
 const body={message_type:'TYPE_NEW_MESSAGE',seller_id:'1',chat_id:'18446744073709551615',chat_type:'BUYER_SELLER',message_id:'18446744073709551616',created_at:new Date().toISOString(),data:['UNTRUSTED_CALLBACK_TEXT']};
 assert.equal((await f.callback(result.push.callbackUrl,body)).status,200);assert.equal((await f.callback(result.push.callbackUrl,body)).status,200);
 const state=await(await f.manage()).json() as {push:{queue:{pending:number};events:{target:string}[]}};assert.equal(state.push.queue.pending,1);assert.equal(state.push.events[0]!.target,body.chat_id);assert.equal(JSON.stringify(state).includes('UNTRUSTED_CALLBACK_TEXT'),false);
 const messages=await(await f.request('/conv-a/messages')).json();assert.equal(JSON.stringify(messages).includes('UNTRUSTED_CALLBACK_TEXT'),false);
 assert.equal((await f.callback(result.push.callbackUrl,{...body,seller_id:'2'})).status,404);
 assert.equal((await f.manage({operation:'prepare',expectedRevision:1},'staff')).status,403);
 const rotated=await f.manage({operation:'prepare',expectedRevision:1});assert.equal(rotated.status,200);assert.equal((await f.callback(result.push.callbackUrl,{message_type:'TYPE_PING'})).status,404);
});

test('a simulation sent to a public deployment is rejected, never silently promoted to genuine delivery',{timeout:60_000},async t=>{
 const f=await fixture();t.after(f.close);const url=await f.activate();f.env.APP_BASE_URL='https://public.example.invalid';
 const message={message_type:'TYPE_NEW_MESSAGE',seller_id:'1',chat_id:'18446744073709551615',chat_type:'BUYER_SELLER',message_id:'18446744073709551616',created_at:new Date().toISOString()};
 for(const body of[{message_type:'TYPE_PING'},message]){
  const response=await f.app.request(url,{method:'POST',headers:{'content-type':'application/json','X-DingBell-Local-Simulation':'1'},body:JSON.stringify(body)},f.env as never);
  assert.equal(response.status,403,'a copied local callback credential must not convert a simulation into a live event');
 }
 assert.equal((await f.DB.prepare('SELECT COUNT(*) AS n FROM ozon_push_event').first<{n:number}>())!.n,0);
 assert.equal((await f.DB.prepare('SELECT last_received_at FROM store_push_endpoint').first<{last_received_at:number|null}>())!.last_received_at,null);
 assert.equal((await f.callback(url,message)).status,200,'ordinary public notifications still work');
 assert.equal((await f.DB.prepare('SELECT simulated FROM ozon_push_event').first<{simulated:number}>())!.simulated,0);
});
