/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from './conversations-api.ts';

const instant='2026-10-09T00:00:00.000Z';
const message={id:'msg',sequence:1,platformMessageId:'18446744073709551615',content:['Здравствуйте','<script>literal</script>'],senderId:'9007199254740993',senderType:'Customer',direction:'inbound',isImage:false,eventAt:instant,receivedAt:instant,ingestMode:'backfill',orderNumber:'order-1',sku:'9007199254740993'};
const conversation={id:'conversation',store:{id:'store',name:'Synthetic',status:'paused'},platformThreadId:'18446744073709551615',platformType:'BUYER_SELLER',platformStatus:'Opened',platformCreatedAt:instant,importedAt:instant,lastMessageAt:instant,latestMessage:{...message,content:[message.content[0]],previewTruncated:true}};
const workflow={version:0,lifecycle:'open',workStatus:'needs_reply',assignedMemberId:null,assigneeName:null};
const listMetadata={viewerMemberId:'member-viewer',counts:{all:4,mine:1,unassigned:2}};
const pageMetadata={viewerMemberId:'member-viewer',pageCursor:'history-page',updatesCursor:'updates-start',newerCursor:null};
const detail={...conversation,sync:{enabled:false,lastSuccessAt:null,lastError:null,backfillComplete:true}};
function method(name:string){const value=Reflect.get(api,name);assert.equal(typeof value,'function',`${name} must be implemented`);return value as (...args:any[])=>Promise<any>;}

test('conversation list requests preserve exact identifiers and encode independent filters',async t=>{
  const read=method('readConversations'),calls:{url:string;init:RequestInit}[]=[];
  t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json({...listMetadata,companyId:'c/1',conversations:[{...conversation,workflow}],nextCursor:null});});
  const result=await read('c/1',{storeId:'store',searchField:'order',search:'A/B + 1',limit:1});
  assert.equal(result.conversations[0].platformThreadId,'18446744073709551615');assert.equal(result.conversations[0].latestMessage.senderId,'9007199254740993');
  const url=new URL(calls[0].url,'https://example.invalid');assert.equal(url.pathname,'/api/companies/c%2F1/conversations');
  assert.equal(url.searchParams.get('storeId'),'store');assert.equal(url.searchParams.get('searchField'),'order');assert.equal(url.searchParams.get('search'),'A/B + 1');assert.equal(url.searchParams.get('limit'),'1');
  assert.equal(calls[0].init.cache,'no-store');assert.equal(calls[0].init.credentials,'same-origin');
});

test('conversation list replies validate company, store, schema, dates and requested page limit',async t=>{
  const read=method('readConversations');
  for(const response of [
    {companyId:'other',conversations:[],nextCursor:null},
    {companyId:'company',conversations:[{...conversation,store:{...conversation.store,id:'other'}}],nextCursor:null},
    {companyId:'company',conversations:[{...conversation,platformThreadId:1844}],nextCursor:null},
    {companyId:'company',conversations:[{...conversation,lastMessageAt:'2026-99-99T00:00:00Z'}],nextCursor:null},
    {companyId:'company',conversations:[conversation,{...conversation,id:'second'}],nextCursor:null},
    {companyId:'company',conversations:[conversation],nextCursor:'x'.repeat(5000)},
  ]){
    const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({...listMetadata,...response,conversations:response.conversations.map(item=>({...item,workflow}))}));
    await assert.rejects(read('company',{storeId:'store',limit:1}),{code:'INVALID_RESPONSE'});mock.mock.restore();
  }
});

test('conversation detail and message pages reject a different requested scope or malformed facts',async t=>{
  const read=method('readConversation'),messages=method('readConversationMessages');
  for(const response of [{companyId:'other',conversation:detail},{companyId:'company',conversation:{...detail,id:'other'}},{companyId:'company',conversation:{...detail,sync:{...detail.sync,lastSuccessAt:'yesterday'}}}]){
    const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(response));await assert.rejects(read('company','conversation'),{code:'INVALID_RESPONSE'});mock.mock.restore();
  }
  for(const response of [
    {companyId:'company',conversationId:'other',messages:[],nextCursor:null},
    {companyId:'other',conversationId:'conversation',messages:[],nextCursor:null},
    {companyId:'company',conversationId:'conversation',messages:[{...message,content:'raw text'}],nextCursor:null},
    {companyId:'company',conversationId:'conversation',messages:[{...message,platformMessageId:10}],nextCursor:null},
    {companyId:'company',conversationId:'conversation',messages:[{...message,receivedAt:'not-a-date'}],nextCursor:null},
    {companyId:'company',conversationId:'conversation',messages:[message,{...message,id:'second'}],nextCursor:null},
  ]){
    const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({...pageMetadata,...response}));await assert.rejects(messages('company','conversation',{limit:1}),{code:'INVALID_RESPONSE'});mock.mock.restore();
  }
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({...pageMetadata,companyId:'company',conversationId:'conversation',messages:[message],nextCursor:null}));
  const accepted=await messages('company','conversation');assert.deepEqual(accepted.messages[0].content,message.content);assert.equal(accepted.messages[0].orderNumber,'order-1');mock.mock.restore();
});

test('invalid read options make no request and transport failures are never retried',async t=>{
  const read=method('readConversations'),messages=method('readConversationMessages');let calls=0;
  const mock=t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Synthetic network failure');});
  for(const options of [{limit:0},{limit:101},{limit:1.5},{search:'orphan'},{searchField:'thread'},{searchField:'email',search:'x'},{unknown:true},{cursor:''}])await assert.rejects(read('company',options),{code:'INVALID_REQUEST'});
  await assert.rejects(messages('company','conversation',{limit:101}),{code:'INVALID_REQUEST'});assert.equal(calls,0);
  await assert.rejects(read('company'),{code:'NETWORK_ERROR'});assert.equal(calls,1);mock.mock.restore();
});

test('message queues expose viewer-scoped counts and workflow metadata while leaving detail replies unchanged',async t=>{
  const read=method('readConversations'),readDetail=method('readConversation');
  const list={companyId:'company',viewerMemberId:'member-viewer',counts:{all:4,mine:1,unassigned:2},conversations:[{...conversation,workflow}],nextCursor:null};
  let payload:any=list;
  t.mock.method(globalThis,'fetch',async()=>Response.json(payload));
  const result=await read('company');assert.deepEqual(result.counts,list.counts);
  assert.equal(result.viewerMemberId,'member-viewer');assert.deepEqual(result.conversations[0].workflow,workflow);
  payload={companyId:'company',conversation:detail};assert.equal('workflow' in (await readDetail('company','conversation')).conversation,false);
});

test('queue and state filters are encoded independently from store, exact search and pagination',async t=>{
  const read=method('readConversations'),calls:string[]=[];
  const current={...workflow,version:7,workStatus:'waiting_internal',assignedMemberId:'member-viewer',assigneeName:'当前客服'};
  t.mock.method(globalThis,'fetch',async(url:string)=>{calls.push(url);return Response.json({companyId:'c/1',viewerMemberId:'member-viewer',counts:{all:4,mine:1,unassigned:2},conversations:[{...conversation,workflow:current}],nextCursor:null});});
  const result=await read('c/1',{queue:'mine',state:'waiting_internal',storeId:'store',searchField:'order',search:'A/B + 1',cursor:'opaque_cursor',limit:1});
  const url=new URL(calls[0],'https://example.invalid');
  for(const [key,value]of Object.entries({queue:'mine',state:'waiting_internal',storeId:'store',searchField:'order',search:'A/B + 1',cursor:'opaque_cursor',limit:'1'}))assert.equal(url.searchParams.get(key),value);
  assert.deepEqual(result.counts,{all:4,mine:1,unassigned:2});assert.deepEqual(result.conversations[0].workflow,current);
});

test('queue replies reject missing metadata, inconsistent counts and malformed workflow states',async t=>{
  const read=method('readConversations');
  const valid={companyId:'company',...listMetadata,conversations:[{...conversation,workflow}],nextCursor:null};
  const invalidWorkflows=[undefined,{}, {...workflow,version:-1},{...workflow,version:0.5},{...workflow,version:Number.MAX_SAFE_INTEGER+1},
    {...workflow,lifecycle:'waiting'},{...workflow,workStatus:null},{...workflow,workStatus:'waiting_shipping'},{...workflow,lifecycle:'resolved'},
    {...workflow,assignedMemberId:1},{...workflow,assignedMemberId:''},{...workflow,assigneeName:'失配姓名'},
    {...workflow,assignedMemberId:'member-other',assigneeName:1}];
  const payloads=[{...valid,viewerMemberId:undefined},{...valid,viewerMemberId:''},{...valid,viewerMemberId:3},{...valid,counts:undefined},
    ...[{all:-1,mine:0,unassigned:0},{all:1.5,mine:0,unassigned:0},{all:Number.MAX_SAFE_INTEGER+1,mine:0,unassigned:0},{all:1,mine:2,unassigned:0},
      {all:1,mine:0,unassigned:2},{all:2,mine:2,unassigned:1},{all:0,mine:0,unassigned:0},{all:1,mine:-1,unassigned:0},
      {all:1,mine:0,unassigned:0.5},{all:1,mine:0,unassigned:undefined}].map(counts=>({...valid,counts})),
    ...invalidWorkflows.map(value=>({...valid,conversations:[{...conversation,workflow:value}]}))];
  for(const payload of payloads){const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(payload));await assert.rejects(read('company'),{code:'INVALID_RESPONSE'});assert.equal(mock.mock.callCount(),1);mock.mock.restore();}
});

test('queue and state predicates validate returned rows without treating removed assignees as unassigned',async t=>{
  const read=method('readConversations');let current:any=workflow,counts=listMetadata.counts;
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({companyId:'company',...listMetadata,counts,conversations:[{...conversation,workflow:current}],nextCursor:null}));
  for(const state of ['needs_reply','waiting_customer','waiting_internal','resolved']){
    current={...workflow,lifecycle:state==='resolved'?'resolved':'open',workStatus:state==='resolved'?null:state};
    assert.equal((await read('company',{queue:'unassigned',state})).conversations.length,1);
    await assert.rejects(read('company',{queue:'mine',state}),{code:'INVALID_RESPONSE'});
    await assert.rejects(read('company',{state:state==='resolved'?'needs_reply':'resolved'}),{code:'INVALID_RESPONSE'});
  }
  for(const name of [null,'','   ','现任客服']){
    current={...workflow,assignedMemberId:'member-viewer',assigneeName:name};
    assert.equal((await read('company',{queue:'mine',state:'all'})).conversations[0].workflow.assigneeName,name);
    await assert.rejects(read('company',{queue:'unassigned'}),{code:'INVALID_RESPONSE'});
  }
  current={...workflow,assignedMemberId:'member-other',assigneeName:null};
  await assert.rejects(read('company',{queue:'mine'}),{code:'INVALID_RESPONSE'});
  assert.equal((await read('company',{queue:'all'})).conversations[0].workflow.assignedMemberId,'member-other');
  current={...workflow,assignedMemberId:'member-viewer',assigneeName:'客服'};counts={all:4,mine:0,unassigned:2};
  await assert.rejects(read('company',{queue:'mine'}),{code:'INVALID_RESPONSE'});
  current=workflow;counts={all:4,mine:1,unassigned:0};await assert.rejects(read('company',{queue:'unassigned'}),{code:'INVALID_RESPONSE'});mock.mock.restore();
});

test('unknown queue and state values fail before network access',async t=>{
  const read=method('readConversations');let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('must not request');});
  for(const options of [{queue:''},{queue:'assigned'},{queue:null},{queue:1},{state:''},{state:'open'},{state:null},{state:1}])await assert.rejects(read('company',options),{code:'INVALID_REQUEST'});
  assert.equal(calls,0);
});

test('message history preserves required stable-page and append boundaries with safe unique message sequences',async t=>{
  const read=method('readConversationMessages'),valid={companyId:'company',conversationId:'conversation',...pageMetadata,messages:[message],nextCursor:null};
  let payload:any=valid;const calls:string[]=[];t.mock.method(globalThis,'fetch',async(url:string)=>{calls.push(url);return Response.json(payload);});
  const result=await read('company','conversation',{cursor:'stable/page +',limit:1});
  assert.equal(result.pageCursor,'history-page');assert.equal(result.updatesCursor,'updates-start');assert.equal(result.viewerMemberId,'member-viewer');assert.equal(result.messages[0].sequence,1);
  assert.equal(new URL(calls[0],'https://example.invalid').searchParams.get('cursor'),'stable/page +');
  for(const bad of [{pageCursor:undefined},{pageCursor:''},{updatesCursor:undefined},{viewerMemberId:undefined},{nextCursor:'history-page'},
    ...[undefined,0,-1,1.5,Number.MAX_SAFE_INTEGER+1].map(sequence=>({messages:[{...message,sequence}]})),{messages:[message,{...message,id:'other'}]}]){
    payload={...valid,...bad};await assert.rejects(read('company','conversation'),{code:'INVALID_RESPONSE'});
  }
});

test('message updates validate bounded ordered batches and require a progressing cursor without retrying',async t=>{
  const read=method('readConversationMessageUpdates'),valid={companyId:'c/1',conversationId:'thread/1',viewerMemberId:'member-viewer',messages:[message],nextCursor:'next',historyCursor:'applied',hasMore:true};
  let payload:any=valid;const calls:{url:string;init:RequestInit}[]=[];const controller=new AbortController();
  const mock=t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json(payload);});
  const result=await read('c/1','thread/1',{cursor:'start +',limit:1},controller.signal);assert.deepEqual(result.messages[0],message);
  const url=new URL(calls[0].url,'https://example.invalid');assert.equal(url.pathname,'/api/companies/c%2F1/conversations/thread%2F1/message-updates');assert.equal(url.searchParams.get('cursor'),'start +');assert.equal(url.searchParams.get('limit'),'1');
  assert.equal(calls[0].init.cache,'no-store');assert.equal(calls[0].init.credentials,'same-origin');assert.ok(calls[0].init.signal);assert.equal(calls[0].init.signal.aborted,false);
  controller.abort();assert.equal(calls[0].init.signal.aborted,true,'the request timeout may compose the caller signal but must preserve cancellation');
  const before=calls.length;
  for(const options of [{},{cursor:''},{cursor:'x',limit:0},{cursor:'x',limit:101},{cursor:'x',after:4}])await assert.rejects(read('c/1','thread/1',options),{code:'INVALID_REQUEST'});
  assert.equal(calls.length,before);
  for(const bad of [{companyId:'other'},{conversationId:'other'},{viewerMemberId:''},{hasMore:undefined},{hasMore:'true'},{nextCursor:null},{messages:[],hasMore:true},
    {nextCursor:'start'},{messages:[message,{...message,id:'other'}]},{messages:[{...message,sequence:2},{...message,id:'other',sequence:1}]},
    {messages:[message,{...message,id:'other',sequence:2}]}]){
    payload={...valid,...bad};await assert.rejects(read('c/1','thread/1',{cursor:'start',limit:1}),{code:'INVALID_RESPONSE'});
  }
  payload={...valid,messages:[{...message,sequence:2},{...message,id:'other',sequence:1}]};await assert.rejects(read('c/1','thread/1',{cursor:'start',limit:2}),{code:'INVALID_RESPONSE'});
  payload={...valid,messages:[],nextCursor:'start',hasMore:false};assert.deepEqual((await read('c/1','thread/1',{cursor:'start'})).messages,[]);
  payload={...valid,messages:[],nextCursor:'after-deleted-gap',hasMore:false};assert.equal((await read('c/1','thread/1',{cursor:'start'})).nextCursor,'after-deleted-gap');
  mock.mock.restore();let attempts=0;t.mock.method(globalThis,'fetch',async()=>{attempts++;throw new Error('synthetic connection loss');});
  await assert.rejects(read('company','conversation',{cursor:'start'}),{code:'NETWORK_ERROR'});assert.equal(attempts,1);
});

test('4D3 message client preserves navigation checkpoints and validates paired anchor options',async t=>{
  const read=method('readConversationMessages'),updates=method('readConversationMessageUpdates');let calls=0,url='',payload:any={companyId:'company',conversationId:'conversation',...pageMetadata,messages:[message],nextCursor:null,newerCursor:'newer'};
  t.mock.method(globalThis,'fetch',async(input:string)=>{calls++;url=input;return Response.json(payload);});
  assert.equal((await read('company','conversation')).newerCursor,'newer');
  await read('company','conversation',{cursor:'snapshot',anchorId:'message /+',direction:'from',limit:50});assert.equal(new URL(url,'https://example.invalid').searchParams.get('anchorId'),'message /+');
  const before=calls;for(const options of [{anchorId:'m',direction:'from'},{cursor:'c',anchorId:'m'},{cursor:'c',direction:'from'},{cursor:'c',anchorId:'m',direction:'wrong'}])await assert.rejects(read('company','conversation',options),{code:'INVALID_REQUEST'});assert.equal(calls,before);
  for(const newerCursor of [undefined,'',7,'history-page']){payload={...payload,newerCursor};await assert.rejects(read('company','conversation'),{code:'INVALID_RESPONSE'});}
  payload={companyId:'company',conversationId:'conversation',viewerMemberId:'member-viewer',messages:[message],nextCursor:'next',hasMore:false,historyCursor:'applied'};
  assert.equal((await updates('company','conversation',{cursor:'start'})).historyCursor,'applied');
  for(const historyCursor of [undefined,'',7]){payload={...payload,historyCursor};await assert.rejects(updates('company','conversation',{cursor:'start'}),{code:'INVALID_RESPONSE'});}
});
