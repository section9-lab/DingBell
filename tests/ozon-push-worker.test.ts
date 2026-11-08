import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pushFixture} from './fixtures/ozon-push.ts';
import {readInboundEvent} from '../src/modules/conversations/inbound.ts';
import {ensureControlDirectory} from '../src/modules/conversations/control-storage.ts';
import {readAiReplyDispatchContext,readReplyDispatchContext} from '../src/modules/conversations/reply-storage.ts';
import {runSyncPage} from '../src/modules/sync/runner.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {getStoreCoordinatorRuntime} from '../src/modules/sync/storage.ts';

test('after explicit cutover there are no discovery sweeps; a pushed message is read canonically exactly once',{timeout:60_000},async t=>{
 const f=await pushFixture();t.after(f.close);const url=await f.activate(),scope={orgId:'company',storeId:'store-a'},requests:string[]=[];
 const fetcher=(async(input)=>{requests.push(new URL(String(input)).pathname);return Response.json({has_next:false,messages:[{message_id:'18446744073709551616',created_at:new Date().toISOString(),user:{id:'9007199254740993',type:'Customer'},data:['Verified platform text'],is_image:false,is_read:false}]});}) as typeof fetch;
 await runSyncPage(f.env as never,scope,{fetcher});assert.deepEqual(requests,[]);assert.equal(await getStoreCoordinatorRuntime(f.DB,scope),null);
 const body={message_type:'TYPE_NEW_MESSAGE',seller_id:'1',chat_id:'18446744073709551615',chat_type:'BUYER_SELLER',message_id:'18446744073709551616',created_at:new Date().toISOString(),data:['Never trust this text']};
 assert.equal((await f.callback(url,body)).status,200);
 await runSyncPage(f.env as never,scope,{fetcher});
 assert.deepEqual(requests,['/v3/chat/history']);const page=await(await f.request('/conv-a/messages')).json();assert.ok(JSON.stringify(page).includes('Verified platform text'));assert.equal(JSON.stringify(page).includes('Never trust this text'),false);
 assert.equal((await f.callback(url,body)).status,200);await runSyncPage(f.env as never,scope,{fetcher});assert.equal(requests.length,1);
 const result=await(await f.manage()).json() as {push:{queue:{completed:number}}};assert.equal(result.push.queue.completed,1);
 const events=await f.DB.prepare("SELECT state,COUNT(*) AS count FROM ingest_event WHERE store_id='store-a' GROUP BY state").all<{state:string;count:number}>();assert.equal(events.results.find(row=>row.state==='pending')?.count,1);
});

test('a product Push refreshes only the affected product and its authoritative stock flags, without losing int64 IDs',{timeout:60_000},async t=>{
 const f=await pushFixture();t.after(f.close);const url=await f.activate(),scope={orgId:'company',storeId:'store-a'},requests:string[]=[],id='18446744073709551616';
 const response=await f.app.request(url,{method:'POST',headers:{'content-type':'application/json'},body:`{"message_type":"TYPE_CREATE_OR_UPDATE_ITEM","seller_id":1,"product_id":${id}}`},f.env as never);assert.equal(response.status,200);
 const fetcher=(async(input,init)=>{const path=new URL(String(input)).pathname;requests.push(path);const body=JSON.parse(String(init?.body));
  if(path==='/v3/product/info/list'){assert.deepEqual(body.product_id,[id]);return Response.json({items:[{id,offer_id:'product-push',name:'Canonical product',price:'25.50',currency_code:'CNY',sources:[]}]});}
  assert.equal(path,'/v3/product/list');assert.deepEqual(body.filter.product_id,[id]);return Response.json({result:{items:[{product_id:id,offer_id:'product-push',has_fbo_stocks:false,has_fbs_stocks:true,archived:false}],last_id:'',total:1}});
 }) as typeof fetch;
 await runSyncPage(f.env as never,scope,{fetcher});await delay(1050);await runSyncPage(f.env as never,scope,{fetcher});
 assert.deepEqual(requests,['/v3/product/info/list','/v3/product/list']);
 const product=await f.DB.prepare("SELECT facts,listing,detail_state AS state FROM product WHERE store_id='store-a' AND id=?").bind(id).first<{facts:string;listing:string;state:string}>();assert.equal(product?.state,'complete');assert.equal(JSON.parse(product!.facts).name,'Canonical product');assert.equal(JSON.parse(product!.listing).hasFbsStocks,true);
 const state=await(await f.manage()).json() as {push:{queue:{completed:number}}};assert.equal(state.push.queue.completed,1);
 await runSyncPage(f.env as never,scope,{fetcher});assert.equal(requests.length,2,'no catalog sweep may restart after the event is drained');
});

test('posting notifications refresh only the referenced FBS parcel and retain its real fulfillment type',{timeout:60_000},async t=>{
 const f=await pushFixture();t.after(f.close);const url=await f.activate(),scope={orgId:'company',storeId:'store-a'},paths:string[]=[];
 assert.equal((await f.callback(url,{message_type:'TYPE_STATE_CHANGED',seller_id:'1',posting_number:'123-456-1',new_state:'delivered'})).status,200);
 await runSyncPage(f.env as never,scope,{fetcher:(async(input,init)=>{paths.push(new URL(String(input)).pathname);assert.equal(JSON.parse(String(init?.body)).posting_number,'123-456-1');return Response.json({result:{posting_number:'123-456-1',order_id:'18446744073709551616',order_number:'123-456',status:'delivering',products:[{sku:'18446744073709551617',offer_id:'parcel-product',quantity:1,price:'20.00',currency_code:'CNY'}]}});}) as typeof fetch});
 assert.deepEqual(paths,['/v3/posting/fbs/get']);const posting=await f.DB.prepare("SELECT fulfillment_type AS mode,detail_facts AS facts FROM commerce_posting WHERE store_id='store-a' AND posting_number='123-456-1'").first<{mode:string;facts:string}>();assert.equal(posting?.mode,'fbs');assert.equal(JSON.parse(posting!.facts).status,'delivering','the notification status is not authoritative');
});

test('a crashed inbox lease is recovered, but revoking store access during the canonical read fences the import',{timeout:60_000},async t=>{
 const f=await pushFixture();t.after(f.close);const url=await f.activate(),scope={orgId:'company',storeId:'store-a'};
 await f.callback(url,{message_type:'TYPE_NEW_MESSAGE',seller_id:'1',chat_id:'18446744073709551615',message_id:'100',chat_type:'BUYER_SELLER'});
 await f.DB.prepare("UPDATE ozon_push_event SET state='processing',lease_token='crashed',lease_until=? WHERE store_id='store-a'").bind(Date.now()-1).run();
 let calls=0;await runSyncPage(f.env as never,scope,{fetcher:(async()=>{calls++;await f.DB.prepare("UPDATE store SET status='paused' WHERE id='store-a'").run();return Response.json({has_next:false,messages:[{message_id:'100',created_at:new Date().toISOString(),user:{id:'4',type:'Customer'},data:['Must not be committed after revocation'],is_image:false,is_read:false}]});}) as typeof fetch});
 assert.equal(calls,1);assert.equal(await f.DB.prepare("SELECT id FROM message WHERE store_id='store-a' AND platform_message_id='100'").first(),null);
 assert.equal(await getStoreCoordinatorRuntime(f.DB,scope),null);await runSyncPage(f.env as never,scope,{fetcher:(async()=>{throw new Error('must not call Ozon while paused');}) as typeof fetch});
 const state=await(await f.manage()).json() as {push:{queue:{retry:number}}};assert.equal(state.push.queue.retry,1,'the uncommitted event stays recoverable');
});

test('rate limiting persists the shared cooldown and retries the accepted notification after the delay',{timeout:60_000},async t=>{
 const f=await pushFixture();t.after(f.close);const url=await f.activate(),scope={orgId:'company',storeId:'store-a'};
 await f.callback(url,{message_type:'TYPE_NEW_MESSAGE',seller_id:'1',chat_id:'18446744073709551615',message_id:'101',chat_type:'BUYER_SELLER'});
 let calls=0;const fetcher=(async()=>{calls++;return calls===1?new Response('{}',{status:429,headers:{'Retry-After':'5'}}):Response.json({has_next:false,messages:[{message_id:'101',created_at:new Date().toISOString(),user:{id:'4',type:'Customer'},data:['Recovered message'],is_image:false,is_read:false}]});}) as typeof fetch;
 const before=Date.now();await runSyncPage(f.env as never,scope,{fetcher});const runtime=await getStoreCoordinatorRuntime(f.DB,scope);assert.ok(runtime&&runtime.dueAt>=before+5000);assert.ok(runtime.blockedUntil&&runtime.blockedUntil>=before+5000);
 await runSyncPage(f.env as never,scope,{fetcher});assert.equal(calls,1);await delay(5100);await runSyncPage(f.env as never,scope,{fetcher});assert.equal(calls,2);
 assert.ok(await f.DB.prepare("SELECT id FROM message WHERE store_id='store-a' AND platform_message_id='101'").first());
});

test('an explicitly requested catalog recovery is finite and never rearms catalog polling',{timeout:60_000},async t=>{
 const f=await pushFixture();t.after(f.close);await f.activate();const scope={orgId:'company',storeId:'store-a'};
 const requested=await f.manage({operation:'reconcile',expectedRevision:2,source:'products',commandId:crypto.randomUUID()});assert.equal(requested.status,200,await requested.clone().text());
 let lists=0,calls=0;const fetcher=(async(input,init)=>{calls++;const path=new URL(String(input)).pathname,body=JSON.parse(String(init?.body));if(path==='/v3/product/info/list')return Response.json({items:[{id:'42',offer_id:'finite-product',name:'Recovered catalog',price:'15',currency_code:'CNY'}]});
  const filtered=!!body.filter.product_id;if(!filtered)lists++;return Response.json({result:{items:filtered||lists===1?[{product_id:'42',offer_id:'finite-product',archived:false,has_fbs_stocks:true,has_fbo_stocks:false}]:[],last_id:filtered?'':lists===1?'page-two':'',total:1}});
 }) as typeof fetch;
 for(let count=0;count<8;count++){const runtime=await getStoreCoordinatorRuntime(f.DB,scope);if(!runtime)break;if(runtime.dueAt>Date.now())await delay(runtime.dueAt-Date.now()+10);await runSyncPage(f.env as never,scope,{fetcher});}
 assert.equal(lists,2);assert.equal(calls,4);assert.ok(await f.DB.prepare("SELECT id FROM product WHERE store_id='store-a' AND id='42' AND detail_state='complete'").first());assert.equal(await getStoreCoordinatorRuntime(f.DB,scope),null);
 await runSyncPage(f.env as never,scope,{fetcher});assert.equal(calls,4);
});

test('local simulation cannot reply or consume a later genuine live-message delivery',{timeout:60_000},async t=>{
 const f=await pushFixture();t.after(f.close);const url=await f.activate(),scope={orgId:'company',storeId:'store-a'},createdAt=new Date().toISOString();
 const body={message_type:'TYPE_NEW_MESSAGE',seller_id:'1',chat_id:'18446744073709551615',message_id:'102',chat_type:'BUYER_SELLER',created_at:createdAt};
 const simulation=await f.app.request(url,{method:'POST',headers:{'content-type':'application/json','X-DingBell-Local-Simulation':'1'},body:JSON.stringify(body)},{...f.env,APP_BASE_URL:'http://127.0.0.1:5173'} as never);assert.equal(simulation.status,200);
 const simulatedState=await(await f.manage()).json() as {push:{lastReceivedAt:string|null;lastSimulationAt:string|null;observedSellerId:string|null}};assert.equal(simulatedState.push.lastReceivedAt,null);assert.equal(simulatedState.push.observedSellerId,null);assert.ok(simulatedState.push.lastSimulationAt);
 const fetcher=(async()=>Response.json({has_next:false,messages:[{message_id:'102',created_at:createdAt,user:{id:'4',type:'Customer'},data:['One canonical message'],is_image:false,is_read:false}]})) as typeof fetch;
 await runSyncPage(f.env as never,scope,{fetcher});assert.equal(await f.DB.prepare("SELECT id FROM ingest_event WHERE store_id='store-a' AND state='pending'").first(),null);
 assert.equal((await f.callback(url,body)).status,200);await runSyncPage(f.env as never,scope,{fetcher});
 const messages=(await f.DB.prepare("SELECT id,ingest_mode AS mode FROM message WHERE store_id='store-a' AND platform_message_id='102'").all<{id:string;mode:string}>()).results;assert.equal(messages.length,1);assert.equal(messages[0]!.mode,'incremental');
 const event=await f.DB.prepare("SELECT state FROM ingest_event WHERE message_id=?").bind(messages[0]!.id).first<{state:string}>();assert.equal(event?.state,'pending','only the genuine verified delivery may promote the historical observation');
});

test('a canonical message edit preserves immutable history and blocks AI sending, not authorized human replies',{timeout:60_000},async t=>{
 const f=await pushFixture();t.after(f.close);const url=await f.activate(),scope={orgId:'company',storeId:'store-a'},createdAt=new Date().toISOString();
 const body={message_type:'TYPE_NEW_MESSAGE',seller_id:'1',chat_id:'18446744073709551615',message_id:'103',chat_type:'BUYER_SELLER',created_at:createdAt};
 let content='Original immutable fact';const fetcher=(async()=>Response.json({has_next:false,messages:[{message_id:'103',created_at:createdAt,user:{id:'4',type:'Customer'},data:[content],is_image:false,is_read:false}]})) as typeof fetch;
 await f.callback(url,body);await runSyncPage(f.env as never,scope,{fetcher});
 const login=await f.DB.prepare("SELECT id FROM session WHERE user_id='owner' LIMIT 1").first<{id:string}>();
 const directory=await ensureControlDirectory(f.DB,{orgId:'company',actorUserId:'owner',sessionId:login!.id},'conv-a',Date.now());assert.ok(directory);
 await f.DB.prepare("UPDATE store SET outbound_enabled=1 WHERE id='store-a'").run();assert.equal((await readAiReplyDispatchContext(f.DB,directory.scope))?.replyAvailable,true);
 content='Edited platform fact';await f.callback(url,{...body,message_type:'TYPE_UPDATE_MESSAGE',updated_at:new Date().toISOString()});await runSyncPage(f.env as never,scope,{fetcher});
 assert.equal((await readAiReplyDispatchContext(f.DB,directory.scope))?.replyAvailable,false);
 assert.equal((await readReplyDispatchContext(f.DB,directory.scope,'owner','owner-member'))?.replyAvailable,true);
 const state=await(await f.manage()).json() as {push:{reviewCount:number;events:{state:string;lastError:string}[]}};assert.equal(state.push.reviewCount,1);assert.ok(state.push.events.some(event=>event.state==='failed'&&event.lastError==='message_content_changed'));
 const message=await f.DB.prepare("SELECT content FROM message WHERE store_id='store-a' AND platform_message_id='103'").first<{content:string}>();assert.equal(JSON.parse(message!.content)[0],'Original immutable fact');
});

test('late notifications import the current canonical context but only the latest unanswered customer input can become live',{timeout:60_000},async t=>{
 const f=await pushFixture();t.after(f.close);const url=await f.activate(),scope={orgId:'company',storeId:'store-a'},at=Date.now();let live=0;
 const body=(id:string)=>({message_type:'TYPE_NEW_MESSAGE',seller_id:'1',chat_id:'18446744073709551615',message_id:id,chat_type:'BUYER_SELLER'});
 const records:[string,string,string,number][]=[['112','Customer','Current unanswered question',0],['111','Seller','Already answered on Ozon',0],['110','Customer','Old question',0]];
 const fetcher=(async()=>Response.json({has_next:false,messages:records.map(([id,type,text,offset])=>({message_id:id,created_at:new Date(at+offset).toISOString(),user:{id:'4',type},data:[text],is_image:false,is_read:false}))})) as typeof fetch;
 await f.callback(url,body('110'));await runSyncPage(f.env as never,scope,{fetcher,onCommittedLive:()=>{live++;}});
 const snapshot=await(await f.request('/conv-a/messages')).json();assert.ok(JSON.stringify(snapshot).includes('Already answered on Ozon'));assert.ok(JSON.stringify(snapshot).includes('Current unanswered question'));assert.equal(live,0);
 assert.equal(await f.DB.prepare("SELECT id FROM ingest_event WHERE store_id='store-a' AND state='pending'").first(),null);
 await f.callback(url,body('112'));await runSyncPage(f.env as never,scope,{fetcher,onCommittedLive:()=>{live++;}});assert.equal(live,1);
 const pending=(await f.DB.prepare("SELECT m.platform_message_id AS id,e.id AS eventId FROM ingest_event e JOIN message m ON m.id=e.message_id WHERE e.store_id='store-a' AND e.state='pending'").all<{id:string;eventId:string}>()).results;assert.deepEqual(pending.map(row=>row.id),['112']);
 const session=await f.DB.prepare("SELECT id FROM session WHERE user_id='owner' LIMIT 1").first<{id:string}>(),directory=await ensureControlDirectory(f.DB,{orgId:'company',actorUserId:'owner',sessionId:session!.id},'conv-a',Date.now());assert.ok(directory);assert.ok(await readInboundEvent(f.DB,directory.scope,pending[0]!.eventId));
 records.unshift(['113','Seller','Answered after the notification',0]);await f.callback(url,{...body('113'),message_type:'TYPE_MESSAGE_READ'});await runSyncPage(f.env as never,scope,{fetcher});assert.equal(await readInboundEvent(f.DB,directory.scope,pending[0]!.eventId),null,'a later authoritative seller reply supersedes an unsent AI input even when platform timestamps tie');
});
