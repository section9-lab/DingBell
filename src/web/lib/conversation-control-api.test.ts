/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from './conversation-control-api.ts';
import { ApiError } from './api.ts';

const instant='2026-10-09T00:00:00.000Z';
const command={commandId:'00000000-0000-4000-8000-000000000001',expectedVersion:3,action:'takeover'};
const state={schemaVersion:2,version:4,controlEpoch:4,sequence:4,lifecycle:'open',workStatus:'needs_reply',reception:'human',assignedMemberId:'member-agent',updatedAt:instant};
const assignee={memberId:'member-agent',name:'客服甲',status:'eligible'};
const control={state,viewerMemberId:'member-agent',projectionPending:false,assignee};
const receipt={...command,actorUserId:'user-agent',actorMemberId:'member-agent',appliedState:state};
const response={companyId:'company',conversationId:'conversation',receipt,control};
function method(name:string){const value=Reflect.get(api,name);assert.equal(typeof value,'function',`${name} must be implemented`);return value as (...args:any[])=>Promise<any>;}

test('cancellation acknowledgements bind the target and frozen member and unknown errors stay unconfirmed',async t=>{
  const input={...command,action:'cancel_reply',targetIntentId:crypto.randomUUID()},accepted={...receipt,...input};let payload:any=accepted;
  const mock=t.mock.method(globalThis,'fetch',async(_url:string,init:RequestInit)=>{
    assert.deepEqual(JSON.parse(String(init.body)),input);assert.equal(new Headers(init.headers).get('X-DingBell-Member-Id'),'member-agent');
    return Response.json({...response,receipt:payload});
  });
  const send=()=>api.sendConversationCommand('company','conversation',input as any,'member-agent');
  assert.deepEqual((await send()).receipt,accepted);
  for(const change of [{targetIntentId:crypto.randomUUID()},{actorMemberId:'former-member'},{action:'takeover'}]){
    payload={...accepted,...change};await assert.rejects(send(),{code:'OPERATION_UNCONFIRMED'});
  }
  await assert.rejects(api.sendConversationCommand('company','conversation',input as any),{code:'INVALID_REQUEST'});assert.equal(mock.mock.callCount(),4);
  mock.mock.restore();t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'SYNTHETIC_UNKNOWN'}},{status:500}));await assert.rejects(send(),{code:'OPERATION_UNCONFIRMED'});
});

test('a canceled public reply cannot claim a provider attempt or an error',async t=>{
  const reply={intentId:command.commandId,commandId:command.commandId,body:'Отмена',status:'canceled',revision:2,createdAt:instant,updatedAt:instant,reason:null,attempt:null};
  let payload:any=reply;t.mock.method(globalThis,'fetch',async()=>Response.json({companyId:'company',conversationId:'conversation',reply:payload}));
  assert.deepEqual((await api.readConversationReply('company','conversation',command.commandId)).reply,reply);
  for(const changed of [{reason:'ERROR'},{attempt:{id:command.commandId+':1',status:'sending',startedAt:instant,finishedAt:null,httpStatus:null,providerResult:null,errorCode:null}}]){
    payload={...reply,...changed};await assert.rejects(api.readConversationReply('company','conversation',command.commandId),{code:'INVALID_RESPONSE'});
  }
});

test('translated send acknowledgements bind the preview reference and hash of the confirmed body',async t=>{
  const input={...command,action:'send_reply',body:'  Ответ после проверки.  ',previewRequestId:crypto.randomUUID()};
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input.body)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  const proof={requestId:input.previewRequestId,runId:crypto.randomUUID(),sourceRevision:3,sourceHash:'a'.repeat(64),outputHash:'b'.repeat(64),confirmedBodyHash:hash};
  const accepted={...receipt,...input,intentId:input.commandId,translation:proof};let payload:any=accepted;
  const mock=t.mock.method(globalThis,'fetch',async(_url:string,init:RequestInit)=>{assert.deepEqual(JSON.parse(String(init.body)),input);return Response.json({...response,receipt:payload});});
  assert.deepEqual((await api.sendConversationCommand('company','conversation',input as any,'member-agent')).receipt,accepted);
  for(const change of [{previewRequestId:undefined},{previewRequestId:crypto.randomUUID()},{translation:undefined},
    {translation:{...proof,requestId:crypto.randomUUID()}},{translation:{...proof,confirmedBodyHash:'f'.repeat(64)}},
    {translation:{...proof,runId:'forged'}},{translation:{...proof,sourceRevision:-1}}]){
    payload={...accepted,...change};await assert.rejects(api.sendConversationCommand('company','conversation',input as any,'member-agent'),{code:'OPERATION_UNCONFIRMED'});
  }
  assert.equal(mock.mock.callCount(),8);
});

test('reply commands preserve confirmed text, bind the intent to the command and allow an immutable older acceptance',async t=>{
  const send=method('sendConversationCommand');
  const input={...command,action:'send_reply',body:'  Здравствуйте!\nРазмер — 26 см.  '};
  const applied={...state,controlEpoch:2};
  const current={...applied,version:6,sequence:6,lifecycle:'resolved',workStatus:null,controlEpoch:3};
  const replyReceipt={...receipt,...input,intentId:input.commandId,appliedState:applied};
  const mock=t.mock.method(globalThis,'fetch',async(_url:string,init:RequestInit)=>{
    assert.deepEqual(JSON.parse(String(init.body)),input);
    return Response.json({...response,receipt:replyReceipt,control:{...control,state:current}});
  });
  const value=await send('company','conversation',input,'member-agent');
  assert.deepEqual(value.receipt,replyReceipt);assert.equal(value.control.state.version,6);assert.equal(mock.mock.callCount(),1);
});

test('reply commands reject invalid or client-routed inputs before fetch and reject mismatched acceptance receipts',async t=>{
  const send=method('sendConversationCommand');const input={...command,action:'send_reply',body:'Здравствуйте'};
  let payload:any={...response,receipt:{...receipt,...input,intentId:input.commandId}};
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(payload));
  for(const change of [{body:''},{body:'  \n'},{body:'a'.repeat(1001)},{body:'\ud800'},{body:'a\u0000b'},{chatId:'other'},{intentId:'forged'},{credentialVersion:2}]) {
    await assert.rejects(send('company','conversation',{...input,...change},'member-agent'),{code:'INVALID_REQUEST'});
  }
  assert.equal(mock.mock.callCount(),0);
  const accepted=payload.receipt;
  for(const change of [{intentId:undefined},{intentId:'not-uuid'},{intentId:'00000000-0000-4000-8000-000000000099'},
    {body:'Другой ответ'},{appliedState:{...state,reception:'paused'}},{appliedState:{...state,lifecycle:'resolved',workStatus:null}},{appliedState:{...state,schemaVersion:1}}]) {
    payload={...response,receipt:{...accepted,...change}};
    await assert.rejects(send('company','conversation',input,'member-agent'),{code:'OPERATION_UNCONFIRMED'});
  }
});

test('reply reads bind scope and intent and keep unknown results distinct from successful sends',async t=>{
  const read=method('readConversationReply'),controller=new AbortController();
  const reply={intentId:command.commandId,commandId:command.commandId,body:'Здравствуйте',status:'unknown',revision:3,
    createdAt:instant,updatedAt:instant,reason:'PROVIDER_TIMEOUT',
    attempt:{id:`${command.commandId}:1`,status:'unknown',startedAt:instant,finishedAt:instant,httpStatus:null,providerResult:null,errorCode:'PROVIDER_TIMEOUT'}};
  const mock=t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{
    assert.equal(url,`/api/companies/c%2F1/conversations/chat%2F1/replies/${command.commandId}`);
    assert.equal(init.method??'GET','GET');assert.equal(init.cache,'no-store');assert.equal(init.credentials,'same-origin');
    assert.equal(init.signal?.aborted,false);
    return Response.json({companyId:'c/1',conversationId:'chat/1',reply:{...reply,credentialVersion:99,threadId:'private'}});
  });
  const result=await read('c/1','chat/1',command.commandId,controller.signal);
  assert.deepEqual(result.reply,reply);assert.equal(mock.mock.callCount(),1);
});

test('reply reads reject wrong scope, identity, impossible status combinations and invalid input without resending',async t=>{
  const read=method('readConversationReply');
  const reply={intentId:command.commandId,commandId:command.commandId,body:'Здравствуйте',status:'queued',revision:1,
    createdAt:instant,updatedAt:instant,reason:null,attempt:null};
  let payload:any={companyId:'company',conversationId:'conversation',reply};
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(payload));
  for(const id of ['', 'not-a-uuid','a'.repeat(257)])await assert.rejects(read('company','conversation',id),{code:'INVALID_REQUEST'});
  assert.equal(mock.mock.callCount(),0);
  assert.deepEqual((await read('company','conversation',command.commandId)).reply,reply);
  for(const change of [{intentId:'00000000-0000-4000-8000-000000000099'},{commandId:'00000000-0000-4000-8000-000000000099'},
    {status:'sent'},{status:'sending'},{status:'skipped'}, {status:'pending'}, {body:''}, {revision:0},{createdAt:'bad'}, {updatedAt:'2025-01-01T00:00:00.000Z'},
    {status:'sent',attempt:{id:'attempt-1',status:'sent',startedAt:instant,finishedAt:instant,httpStatus:500,providerResult:'success',errorCode:null}}]) {
    payload={companyId:'company',conversationId:'conversation',reply:{...reply,...change}};
    await assert.rejects(read('company','conversation',command.commandId),{code:'INVALID_RESPONSE'});
  }
  payload={companyId:'other',conversationId:'conversation',reply};
  await assert.rejects(read('company','conversation',command.commandId),{code:'INVALID_RESPONSE'});
});

test('reply gates preserve explicit rejection codes and Chinese guidance without retries',async t=>{
  const send=method('sendConversationCommand'),input={...command,action:'send_reply',body:'Здравствуйте'};
  for(const [code,status,message] of [
    ['OUTBOUND_DISABLED',403,'当前部署或店铺尚未开启对外回复。'],
    ['CAPABILITY_UNVERIFIED',412,'尚未确认店铺的回复权限，请联系管理员核实。'],
    ['REPLY_UNAVAILABLE',412,'当前会话或店铺暂不满足发送条件，请刷新状态后确认。'],
    ['PREVIEW_UNAVAILABLE',412,'原翻译预览不可用于本次回复，请核对原文并重新生成预览。'],
  ] as const){
    const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code},requestId:'reply-gate'},{status}));
    await assert.rejects(send('company','conversation',input,'member-agent'),(error:any)=>error instanceof ApiError&&error.code===code&&error.message===message&&error.requestId==='reply-gate');
    assert.equal(mock.mock.callCount(),1);mock.mock.restore();
  }
});

test('reply reads preserve queued, skipped, in-flight, accepted and explicitly rejected outcomes',async t=>{
  const read=method('readConversationReply');
  const base={intentId:command.commandId,commandId:command.commandId,body:'Здравствуйте',revision:3,createdAt:instant,updatedAt:instant};
  const attempt={id:`${command.commandId}:1`,startedAt:instant,finishedAt:instant,httpStatus:null,providerResult:null,errorCode:null};
  for(const reply of [
    {...base,status:'queued',reason:null,attempt:null},
    {...base,status:'canceled',reason:null,attempt:null},
    {...base,status:'skipped',reason:'permission_revoked',attempt:null},
    {...base,status:'sending',reason:null,attempt:{...attempt,status:'sending',finishedAt:null}},
    {...base,status:'sent',reason:null,attempt:{...attempt,status:'sent',httpStatus:200,providerResult:'success'}},
    {...base,status:'failed',reason:'rate_limited',attempt:{...attempt,status:'failed',httpStatus:429,errorCode:'rate_limited'}},
    {...base,status:'failed',reason:'invalid_request',attempt:{...attempt,status:'failed',errorCode:'invalid_request'}},
  ]){
    const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({companyId:'company',conversationId:'conversation',reply}));
    assert.deepEqual((await read('company','conversation',command.commandId)).reply,reply);
    assert.equal(mock.mock.callCount(),1);mock.mock.restore();
  }
});

test('reply reads reject attempts belonging to another intent',async t=>{
  const read=method('readConversationReply');
  const reply={intentId:command.commandId,commandId:command.commandId,body:'Здравствуйте',status:'unknown',revision:3,
    createdAt:instant,updatedAt:instant,reason:'PROVIDER_TIMEOUT',
    attempt:{id:'00000000-0000-4000-8000-000000000099:1',status:'unknown',startedAt:instant,finishedAt:instant,httpStatus:null,providerResult:null,errorCode:'PROVIDER_TIMEOUT'}};
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({companyId:'company',conversationId:'conversation',reply}));
  await assert.rejects(read('company','conversation',command.commandId),{code:'INVALID_RESPONSE'});
  assert.equal(mock.mock.callCount(),1);
});

test('control reads bind encoded scope, current membership and GET-only cancellation',async t=>{
  const read=method('readConversationControl');const calls:{url:string;init:RequestInit}[]=[];const controller=new AbortController();
  t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json({companyId:'c/1',conversationId:'chat/1',control});});
  const value=await read('c/1','chat/1',controller.signal);
  assert.deepEqual(value.control,control);assert.equal(value.control.viewerMemberId,'member-agent');assert.equal(calls[0].url,'/api/companies/c%2F1/conversations/chat%2F1/control');
  assert.equal(calls[0].init.method??'GET','GET');assert.equal(calls[0].init.cache,'no-store');assert.equal(calls[0].init.credentials,'same-origin');
  assert.equal(calls[0].init.signal?.aborted,false);controller.abort();assert.equal(calls[0].init.signal?.aborted,true);assert.equal(calls.length,1);
});

test('control reads accept unassigned AI reception without accepting impossible AI lifecycle or assignment',async t=>{
 const read=method('readConversationControl'),active={...control,assignee:null,state:{...state,reception:'ai',assignedMemberId:null}};
 t.mock.method(globalThis,'fetch',async()=>Response.json({companyId:'company',conversationId:'conversation',control:active}));
 assert.equal((await read('company','conversation')).control.state.reception,'ai');
});
test('control reads reject wrong scope, invalid state versions, enums, IDs and timestamps',async t=>{
  const read=method('readConversationControl');
  const invalidStates=[{...state,schemaVersion:1},{...state,schemaVersion:3},{...state,version:-1},{...state,version:Number.MAX_SAFE_INTEGER+1},{...state,controlEpoch:0.5},
    {...state,sequence:'4'},{...state,lifecycle:'archived'},{...state,reception:'ai'},{...state,assignedMemberId:123},{...state,assignedMemberId:''},
    {...state,workStatus:undefined},{...state,workStatus:null},{...state,workStatus:'waiting_delivery'},{...state,lifecycle:'resolved',workStatus:'needs_reply'},
    {...state,updatedAt:Date.now()},{...state,updatedAt:'2026-02-30T00:00:00.000Z'},{...state,updatedAt:'2026-10-09T00:00:00Z'}];
  const payloads=[{companyId:'other',conversationId:'conversation',control},{companyId:'company',conversationId:'other',control},
    {companyId:'company',conversationId:'conversation',control:{...control,viewerMemberId:''}},
    {companyId:'company',conversationId:'conversation',control:{...control,projectionPending:1}},
    ...invalidStates.map(value=>({companyId:'company',conversationId:'conversation',control:{...control,state:value}}))];
  for(const payload of payloads){const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(payload));await assert.rejects(read('company','conversation'),{code:'INVALID_RESPONSE'});assert.equal(mock.mock.callCount(),1);mock.mock.restore();}
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({companyId:'company',conversationId:'conversation',control:{...control,assignee:null,state:{...state,version:0,controlEpoch:0,sequence:0,assignedMemberId:null,reception:'paused'}}}));
  assert.equal((await read('company','conversation')).control.state.assignedMemberId,null);mock.mock.restore();
});

test('accepted commands preserve command identity and support older receipts alongside newer control',async t=>{
  const send=method('sendConversationCommand');
  for(const action of ['claim','takeover','resolve','reopen','set_work_status']){
    const request={...command,action,...(action==='set_work_status'?{workStatus:'waiting_internal'}:{})};
    const applied={...state,lifecycle:action==='resolve'?'resolved':'open',workStatus:action==='resolve'?null:action==='set_work_status'?'waiting_internal':'needs_reply'};
    const current={...applied,lifecycle:'open',workStatus:'needs_reply',version:7,sequence:7,controlEpoch:7,assignedMemberId:'member-other',updatedAt:'2026-10-09T00:05:00.000Z'};
    const calls:{url:string;init:RequestInit}[]=[];
    const mock=t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json({...response,companyId:'c/1',conversationId:'chat/1',receipt:{...receipt,...request,appliedState:applied},control:{...control,state:current,projectionPending:true,assignee:{...assignee,memberId:'member-other',name:'客服乙'}}});});
    const value=await send('c/1','chat/1',request);
    assert.equal(value.receipt.appliedState.version,4);assert.equal(value.control.state.version,7);assert.equal(value.control.state.assignedMemberId,'member-other');assert.equal(value.control.projectionPending,true);
    assert.equal(value.receipt.appliedState.lifecycle,action==='resolve'?'resolved':'open');assert.equal(value.control.state.lifecycle,'open');
    assert.equal(value.receipt.appliedState.workStatus,applied.workStatus);assert.equal(value.control.state.workStatus,'needs_reply');
    assert.notEqual(value.receipt.actorUserId,value.receipt.actorMemberId);assert.equal(calls[0].url,'/api/companies/c%2F1/conversations/chat%2F1/commands');assert.equal(calls[0].init.method,'POST');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)),request);assert.equal(new Headers(calls[0].init.headers).get('content-type'),'application/json');assert.equal(calls.length,1);mock.mock.restore();
  }
});

test('invalid command inputs are rejected before fetch and do not accept caller actor fields or write signals',async t=>{
  const read=method('readConversationControl'),send=method('sendConversationCommand');let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('must not be reached');});
  for(const body of [null,{}, {commandId:command.commandId,action:'claim'},{commandId:command.commandId,expectedVersion:0}, {...command,commandId:'not-a-uuid'},{...command,expectedVersion:-1},{...command,expectedVersion:1.5},
    {...command,expectedVersion:Number.MAX_SAFE_INTEGER},{...command,expectedVersion:Number.MAX_SAFE_INTEGER+1},{...command,expectedVersion:'3'},{...command,action:'resume_ai'},
    {...command,action:'set_work_status'},{...command,action:'set_work_status',workStatus:null},{...command,action:'set_work_status',workStatus:'waiting_delivery'},
    ...['claim','takeover','resolve','reopen'].map(action=>({...command,action,workStatus:'needs_reply'})),
    {...command,assignee},{...command,actorUserId:'other'},{...command,signal:new AbortController().signal}])await assert.rejects(send('company','conversation',body),{code:'INVALID_REQUEST'});
  for(const [companyId,id]of [['','conversation'],['company',''],['company','x'.repeat(257)]]){
    await assert.rejects(read(companyId,id),{code:'INVALID_REQUEST'});await assert.rejects(send(companyId,id,command),{code:'INVALID_REQUEST'});
  }
  assert.equal(calls,0);
});

test('the final safe version increment is accepted while maximum counters remain readable',async t=>{
  const read=method('readConversationControl'),send=method('sendConversationCommand');
  const finalState={...state,version:Number.MAX_SAFE_INTEGER,controlEpoch:Number.MAX_SAFE_INTEGER,sequence:Number.MAX_SAFE_INTEGER};
  const finalCommand={...command,expectedVersion:Number.MAX_SAFE_INTEGER-1};
  const finalResponse={...response,receipt:{...receipt,...finalCommand,appliedState:finalState},control:{...control,state:finalState}};
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(finalResponse));
  assert.equal((await read('company','conversation')).control.state.version,Number.MAX_SAFE_INTEGER);
  assert.equal((await send('company','conversation',finalCommand)).receipt.appliedState.version,Number.MAX_SAFE_INTEGER);
  assert.equal(mock.mock.callCount(),2);
});

test('mismatched accepted receipts are unconfirmed and never overwrite the expected command contract',async t=>{
  const send=method('sendConversationCommand');
  const payloads=[{...response,companyId:'other'},{...response,conversationId:'other'},
    ...[{commandId:'00000000-0000-4000-8000-000000000002'},{expectedVersion:2},{action:'resolve'},{actorUserId:''},{actorMemberId:'member-other'},
      {appliedState:{...state,version:3}},{appliedState:{...state,version:5}},{appliedState:{...state,updatedAt:'invalid'}}].map(value=>({...response,receipt:{...receipt,...value}})),
    {...response,control:{...control,state:{...state,version:3}}},
    ...[{controlEpoch:9},{sequence:9},{lifecycle:'resolved',workStatus:null},{workStatus:'waiting_internal'},{reception:'paused'},{assignedMemberId:null},{updatedAt:'2026-10-09T00:00:01.000Z'}].map(value=>({...response,control:{...control,state:{...state,...value},assignee:'assignedMemberId' in value?null:assignee}})),
    {...response,control:{...control,viewerMemberId:'other'}},
  ];
  for(const payload of payloads){const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(payload));await assert.rejects(send('company','conversation',command),{code:'OPERATION_UNCONFIRMED'});assert.equal(mock.mock.callCount(),1);mock.mock.restore();}
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(response));assert.deepEqual(await send('company','conversation',command),response);mock.mock.restore();
});

test('commands snapshot their validated request while awaiting a response',async t=>{
  const send=method('sendConversationCommand');const input={...command};let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});let body:string|undefined;
  t.mock.method(globalThis,'fetch',async(_url:string,init:RequestInit)=>{body=String(init.body);await pending;return Response.json(response);});
  const operation=send('company','conversation',input);input.action='resolve';input.expectedVersion=8;input.commandId='00000000-0000-4000-8000-000000000009';release();
  assert.deepEqual(JSON.parse(body!),command);assert.equal((await operation).receipt.commandId,command.commandId);
});

test('legacy receipts retain their v1 fields while equal-version current states are compared after normalization',async t=>{
  const send=method('sendConversationCommand');
  for(const lifecycle of ['open','resolved']){
    const {workStatus:_workStatus,...base}=state;
    const legacy={...base,schemaVersion:1,lifecycle};
    const current={...state,lifecycle,workStatus:lifecycle==='open'?'needs_reply':null};
    const input={...command,action:lifecycle==='open'?'takeover':'resolve'};
    const payload={...response,receipt:{...receipt,...input,appliedState:legacy},control:{...control,state:current}};
    let output=payload;
    const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(output));
    const accepted=await send('company','conversation',input);
    assert.deepEqual(accepted.receipt.appliedState,legacy);assert.deepEqual(accepted.control.state,current);
    output={...payload,control:{...control,state:{...current,workStatus:'waiting_internal'}}};
    await assert.rejects(send('company','conversation',input),{code:'OPERATION_UNCONFIRMED'});
    assert.equal(mock.mock.callCount(),2);mock.mock.restore();
  }
});

test('work-status receipts must echo their command and contain a matching open v2 applied state',async t=>{
  const send=method('sendConversationCommand');
  for(const workStatus of ['needs_reply','waiting_customer','waiting_internal']){
    const input={...command,action:'set_work_status',workStatus};
    const applied={...state,workStatus};
    const accepted={...response,receipt:{...receipt,...input,appliedState:applied},control:{...control,state:applied}};
    const {workStatus:_workStatus,...legacy}=applied;
    const invalid=[{...accepted,receipt:{...accepted.receipt,workStatus:undefined}},
      {...accepted,receipt:{...accepted.receipt,workStatus:workStatus==='needs_reply'?'waiting_internal':'needs_reply'}},
      {...accepted,receipt:{...accepted.receipt,appliedState:{...legacy,schemaVersion:1}}},
      {...accepted,receipt:{...accepted.receipt,appliedState:{...applied,lifecycle:'resolved',workStatus:null}}},
      {...accepted,receipt:{...accepted.receipt,appliedState:{...applied,workStatus:workStatus==='needs_reply'?'waiting_internal':'needs_reply'}}},
    ];
    for(const payload of invalid){const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(payload));await assert.rejects(send('company','conversation',input),{code:'OPERATION_UNCONFIRMED'});assert.equal(mock.mock.callCount(),1);mock.mock.restore();}
    const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(accepted));assert.deepEqual(await send('company','conversation',input),accepted);mock.mock.restore();
  }
});

test('unknown submissions, lost replies and malformed success are never retried',async t=>{
  const send=method('sendConversationCommand'),read=method('readConversationControl');
  for(const input of [command,{...command,action:'reopen'},{...command,action:'set_work_status',workStatus:'waiting_internal'},{...command,action:'transfer',targetMemberId:'target',reason:'检查'},{...command,action:'add_note',body:'正文'}])for(const invoke of [async()=>{throw new TypeError('lost response');},async()=>new Response('not-json',{status:503}),async()=>new Response('not-json',{status:200}),async()=>Response.json({ok:true})]){
    const mock=t.mock.method(globalThis,'fetch',invoke);await assert.rejects(send('company','conversation',input),{code:'OPERATION_UNCONFIRMED'});assert.equal(mock.mock.callCount(),1);mock.mock.restore();
  }
  const mock=t.mock.method(globalThis,'fetch',async()=>{throw new TypeError('read offline');});await assert.rejects(read('company','conversation'),{code:'NETWORK_ERROR'});assert.equal(mock.mock.callCount(),1);mock.mock.restore();
});

test('documented conflicts and unavailable control errors preserve codes, request IDs and Chinese guidance',async t=>{
  const send=method('sendConversationCommand'),read=method('readConversationControl');
  for(const [code,status,write]of [['CONTROL_NOT_CONFIGURED',503,false],['CONTROL_UNAVAILABLE',503,false],['NOT_FOUND',404,false],['CONVERSATION_CHANGED',409,true],['COMMAND_CONFLICT',409,true],['TRANSFER_TARGET_UNAVAILABLE',409,true]] as const){
    const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code},requestId:'request-fixture'},{status}));
    await assert.rejects(write?send('company','conversation',command):read('company','conversation'),(error:any)=>error instanceof ApiError&&error.code===code&&error.requestId==='request-fixture');assert.equal(mock.mock.callCount(),1);mock.mock.restore();
  }
  assert.equal(new ApiError('CONTROL_NOT_CONFIGURED').message,'会话处理服务尚未配置，请联系部署管理员。');
  assert.equal(new ApiError('CONTROL_UNAVAILABLE').message,'暂时无法读取会话处理状态，请重试。');
  assert.equal(new ApiError('CONVERSATION_CHANGED').message,'会话状态已变化，请刷新确认后再操作。');
  assert.equal(new ApiError('TRANSFER_TARGET_UNAVAILABLE').message,'该成员当前无法接手此会话，请重新选择。');
  assert.equal(new ApiError('COMMAND_CONFLICT').message,'操作记录发生冲突，请重新读取会话状态后再操作。');
});

test('transfer commands normalize the reason and validate target, receipt facts and independent newer state',async t=>{
  const send=method('sendConversationCommand');
  const input={...command,action:'transfer',targetMemberId:'member-target',reason:'  请协助核实商品说明  '};
  const normalized={...input,reason:'请协助核实商品说明'},applied={...state,assignedMemberId:'member-target',workStatus:'waiting_internal'};
  const accepted={...response,receipt:{...receipt,...normalized,appliedState:applied},control:{...control,state:applied,assignee:{...assignee,memberId:'member-target'}}};
  let payload:any=accepted;let sent:any;
  const mock=t.mock.method(globalThis,'fetch',async(_url:string,init:RequestInit)=>{sent=JSON.parse(String(init.body));return Response.json(payload);});
  assert.deepEqual(await send('company','conversation',input),accepted);assert.deepEqual(sent,normalized);
  payload={...accepted,control:{...control,assignee:{...assignee,memberId:'member-other'},state:{...state,version:7,sequence:7,controlEpoch:7,lifecycle:'resolved',workStatus:null,assignedMemberId:'member-other'}}};
  assert.equal((await send('company','conversation',input)).control.state.version,7);
  const {workStatus:_status,...legacy}=applied;
  for(const change of [{targetMemberId:'other'},{targetMemberId:undefined},{reason:undefined},{reason:input.reason},{reason:'different'},
    {appliedState:{...legacy,schemaVersion:1}},{appliedState:{...applied,lifecycle:'resolved',workStatus:null}},
    {appliedState:{...applied,reception:'paused'}},{appliedState:{...applied,assignedMemberId:'other'}},{appliedState:{...applied,assignedMemberId:null}}]){
    payload={...accepted,receipt:{...accepted.receipt,...change}};
    await assert.rejects(send('company','conversation',input),{code:'OPERATION_UNCONFIRMED'});
  }
  assert.equal(mock.mock.callCount(),12);
});

test('transfer input bounds fail before fetch and old actions cannot carry transfer fields',async t=>{
  const send=method('sendConversationCommand');let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('must not be reached');});
  const valid={...command,action:'transfer',targetMemberId:'member-target',reason:'检查'};
  for(const value of [{...valid,targetMemberId:undefined},{...valid,targetMemberId:''},{...valid,targetMemberId:'a'.repeat(257)},
    {...valid,reason:undefined},{...valid,reason:1},{...valid,reason:''},{...valid,reason:' \n\t '},{...valid,reason:'字'.repeat(501)},
    {...valid,workStatus:'needs_reply'},...['claim','takeover','resolve','reopen','set_work_status'].map(action=>({...valid,action,...(action==='set_work_status'?{workStatus:'needs_reply'}:{})}))]){
    await assert.rejects(send('company','conversation',value),{code:'INVALID_REQUEST'});
  }
  assert.equal(calls,0);
});

test('transfer target pages bind scope, offset, qualified member shape and GET-only cancellation',async t=>{
  const read=method('readConversationTransferTargets');const controller=new AbortController();
  const targets=[{memberId:'owner-a',name:'同事',email:'owner@example.invalid',role:'owner'},
    {memberId:'admin-a',name:'管理员',email:'admin@example.invalid',role:'admin'},
    {memberId:'member-a',name:'客服',email:'member@example.invalid',role:'member'}];
  let payload:any={companyId:'c/1',conversationId:'chat/1',targets,nextOffset:100};const calls:{url:string;init:RequestInit}[]=[];
  t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json(payload);});
  assert.deepEqual(await read('c/1','chat/1',0,controller.signal),payload);
  assert.equal(calls[0].url,'/api/companies/c%2F1/conversations/chat%2F1/transfer-targets?offset=0');
  assert.equal(calls[0].init.method??'GET','GET');assert.equal(calls[0].init.cache,'no-store');controller.abort();assert.equal(calls[0].init.signal?.aborted,true);
  const invalid=[{...payload,companyId:'other'},{...payload,conversationId:'other'},{...payload,targets:Array(101).fill(targets[0])},
    ...[{memberId:''},{memberId:1},{name:null},{email:null},{role:'superadmin'}].map(value=>({...payload,targets:[{...targets[0],...value}]})),
    ...[-1,0,1,99,101,10000,10001,100.5,'100'].map(nextOffset=>({...payload,nextOffset}))];
  for(const value of invalid){payload=value;await assert.rejects(read('c/1','chat/1'),{code:'INVALID_RESPONSE'});}
  payload={companyId:'c/1',conversationId:'chat/1',targets:[],nextOffset:null};
  assert.equal((await read('c/1','chat/1',10000)).nextOffset,null);
  assert.equal(calls.at(-1)?.url,'/api/companies/c%2F1/conversations/chat%2F1/transfer-targets?offset=10000');
  payload={...payload,nextOffset:10100};await assert.rejects(read('c/1','chat/1',10000),{code:'INVALID_RESPONSE'});
  const countBefore=calls.length;
  for(const offset of [-1,0.5,10001,'0',null])await assert.rejects(read('c/1','chat/1',offset),{code:'INVALID_REQUEST'});
  assert.equal(calls.length,countBefore);
});

test('assignee metadata refreshes independently of equal-version states and immutable receipts',async t=>{
  const read=method('readConversationControl'),send=method('sendConversationCommand');
  for(const currentAssignee of [assignee,{...assignee,name:'更新后的姓名'},{...assignee,name:'   '},{...assignee,status:'ineligible'}, {...assignee,name:null,status:'removed'}]){
    const payload={...response,control:{...control,assignee:currentAssignee}};
    let body:any;
    const mock=t.mock.method(globalThis,'fetch',async(_url:string,init:RequestInit)=>{if(init.body)body=JSON.parse(String(init.body));return Response.json(payload);});
    const current=await read('company','conversation');assert.deepEqual(current.control.assignee,currentAssignee);assert.deepEqual(current.control.state,state);
    const accepted=await send('company','conversation',command);assert.deepEqual(accepted.receipt,receipt);assert.deepEqual(accepted.control.assignee,currentAssignee);
    assert.deepEqual(body,command);assert.equal('assignee' in accepted.receipt.appliedState,false);mock.mock.restore();
  }
});

test('missing, malformed or mismatched assignee metadata fails reads and leaves writes unconfirmed',async t=>{
  const read=method('readConversationControl'),send=method('sendConversationCommand');
  const invalid=[undefined,null,{}, {...assignee,memberId:''},{...assignee,memberId:'other'},{...assignee,status:'online'},
    {...assignee,name:null},{...assignee,name:42},{...assignee,status:'ineligible',name:null},{...assignee,status:'removed'}];
  for(const metadata of invalid){
    const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({...response,control:{...control,assignee:metadata}}));
    await assert.rejects(read('company','conversation'),{code:'INVALID_RESPONSE'});
    await assert.rejects(send('company','conversation',command),{code:'OPERATION_UNCONFIRMED'});
    assert.equal(mock.mock.callCount(),2);mock.mock.restore();
  }
  const unassigned={...state,assignedMemberId:null};
  let metadata:any=null;
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({...response,control:{...control,state:unassigned,assignee:metadata}}));
  assert.equal((await read('company','conversation')).control.assignee,null);
  metadata=assignee;await assert.rejects(read('company','conversation'),{code:'INVALID_RESPONSE'});mock.mock.restore();
});

test('an older receipt keeps assignee A while current metadata describes assignee B',async t=>{
  const send=method('sendConversationCommand');
  const current={...state,version:8,sequence:8,controlEpoch:8,assignedMemberId:'member-b'};
  const payload={...response,control:{...control,state:current,assignee:{memberId:'member-b',name:'当前负责人',status:'ineligible'}}};
  t.mock.method(globalThis,'fetch',async()=>Response.json(payload));
  const accepted=await send('company','conversation',command);
  assert.deepEqual(accepted.receipt,receipt);assert.equal(accepted.receipt.appliedState.assignedMemberId,'member-agent');
  assert.deepEqual(accepted.control,payload.control);
});

test('internal notes preserve plaintext and author snapshots on open or resolved conversations without advancing the control epoch',async t=>{
  const send=method('sendConversationCommand');
  const bodies=['  <b>仅团队可见</b>\r\n\t请复核商品说明  ','字'.repeat(4000),'😀'.repeat(2000)];
  for(const [lifecycle,controlEpoch] of [['open',2],['resolved',2],['open',Number.MAX_SAFE_INTEGER]] as const)for(const body of bodies){
    const input={...command,action:'add_note',body};
    const applied={...state,controlEpoch,lifecycle,workStatus:lifecycle==='resolved'?null:'waiting_internal'};
    const payload={...response,receipt:{...receipt,...input,authorName:'原作者姓名',appliedState:applied},control:{...control,state:applied}};
    let sent:any;
    const mock=t.mock.method(globalThis,'fetch',async(_url:string,init:RequestInit)=>{sent=JSON.parse(String(init.body));return Response.json(payload);});
    const accepted=await send('company','conversation',input);
    assert.deepEqual(sent,input);assert.deepEqual(accepted,payload);assert.equal(accepted.control.state.controlEpoch,controlEpoch);assert.equal(accepted.receipt.authorName,'原作者姓名');mock.mock.restore();
  }
});

test('note validation rejects empty, oversized, malformed Unicode and control characters without altering valid text',async t=>{
  const send=method('sendConversationCommand');let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('must not fetch');});
  const invalid=[undefined,null,42,'',' \r\n\t ','字'.repeat(4001),'😀'.repeat(2001),'\ud800','\udc00',...Array.from({length:32},(_,index)=>index).filter(index=>![9,10,13].includes(index)).map(index=>`正文${String.fromCharCode(index)}`),'正文\u007f'];
  for(const body of invalid)await assert.rejects(send('company','conversation',{...command,action:'add_note',body}),{code:'INVALID_REQUEST'});
  for(const extra of [{authorName:'伪造作者'},{actorUserId:'other'},{targetMemberId:'other'},{workStatus:'needs_reply'}])await assert.rejects(send('company','conversation',{...command,action:'add_note',body:'正文',...extra}),{code:'INVALID_REQUEST'});
  for(const action of ['claim','takeover','resolve','reopen'])await assert.rejects(send('company','conversation',{...command,action,body:'正文'}),{code:'INVALID_REQUEST'});
  assert.equal(calls,0);
});

test('note receipts require original body, author name and a v2 applied state even for older accepted commands',async t=>{
  const send=method('sendConversationCommand'),input={...command,action:'add_note',body:'  原文\n保留  '};
  const applied={...state,controlEpoch:1};
  const accepted={...response,receipt:{...receipt,...input,authorName:'写入时姓名',appliedState:applied},control:{...control,state:applied}};
  const {workStatus:_workStatus,...legacy}=applied;
  for(const changes of [{body:undefined},{body:input.body.trim()},{body:'其他文字'},{authorName:undefined},{authorName:null},{authorName:7},{appliedState:{...legacy,schemaVersion:1}}]){
    const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({...accepted,receipt:{...accepted.receipt,...changes}}));
    await assert.rejects(send('company','conversation',input),{code:'OPERATION_UNCONFIRMED'});assert.equal(mock.mock.callCount(),1);mock.mock.restore();
  }
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({...accepted,control:{...control,state:{...state,version:10,sequence:10},assignee:{...assignee,name:'现在的姓名'}}}));
  const result=await send('company','conversation',input);assert.equal(result.receipt.authorName,'写入时姓名');assert.equal(result.control.state.version,10);mock.mock.restore();
});

const note={commandId:'00000000-0000-4000-8000-000000000101',sequence:9,body:'  <img src=x> 原始正文\n\t保留  ',authorMemberId:'member-author',authorName:'备注作者',createdAt:instant};

test('note pages bind scope and bounded pagination while exposing only display fields',async t=>{
  const read=method('readConversationNotes'),controller=new AbortController();const calls:{url:string;init:RequestInit}[]=[];
  const older={...note,commandId:'00000000-0000-4000-8000-000000000102',sequence:8};
  t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json({companyId:'c/1',conversationId:'chat/1',notes:[{...note,actorUserId:'private-user',controllerId:'private-controller'},older],nextCursor:'opaque_cursor'});});
  const result=await read('c/1','chat/1',{limit:2,cursor:'previous_cursor'},controller.signal);
  assert.deepEqual(result.notes,[note,older]);assert.equal(calls[0].url,'/api/companies/c%2F1/conversations/chat%2F1/notes?limit=2&cursor=previous_cursor');
  assert.equal(calls[0].init.method??'GET','GET');assert.equal(calls[0].init.cache,'no-store');assert.equal(calls[0].init.credentials,'same-origin');controller.abort();assert.equal(calls[0].init.signal?.aborted,true);
  await read('c/1','chat/1');assert.equal(calls[1].url,'/api/companies/c%2F1/conversations/chat%2F1/notes?limit=20');
});

test('note pages reject invalid scope, rows, ordering and pagination bounds',async t=>{
  const read=method('readConversationNotes');const valid={companyId:'company',conversationId:'conversation',notes:[note],nextCursor:null};
  const invalidRows=[{commandId:'bad'},{sequence:0},{sequence:-1},{sequence:0.5},{sequence:Number.MAX_SAFE_INTEGER+1},{body:' '},{body:'\ud800'},{body:'x\u0000'},{body:'x'.repeat(4001)},{authorMemberId:''},{authorMemberId:1},{authorName:null},{authorName:undefined},{createdAt:instant.slice(0,-5)+'Z'}];
  const payloads=[{...valid,companyId:'other'},{...valid,conversationId:'other'},
    ...invalidRows.map(value=>({...valid,notes:[{...note,...value}]})),
    {...valid,notes:[note,{...note,commandId:'00000000-0000-4000-8000-000000000102'}]},
    {...valid,notes:[note,{...note,commandId:'00000000-0000-4000-8000-000000000102',sequence:10}]},
    {...valid,notes:[note,{...note,sequence:8}]},{...valid,notes:Array(21).fill(note)},
    ...['','a'.repeat(4097),42].map(nextCursor=>({...valid,nextCursor}))];
  for(const payload of payloads){const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(payload));await assert.rejects(read('company','conversation'),{code:'INVALID_RESPONSE'});assert.equal(mock.mock.callCount(),1);mock.mock.restore();}
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({...valid,notes:[]}));assert.deepEqual((await read('company','conversation')).notes,[]);mock.mock.restore();
});

test('note read inputs fail before fetch for invalid bounds or unexpected filters',async t=>{
  const read=method('readConversationNotes');let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({companyId:'company',conversationId:'conversation',notes:[],nextCursor:null});});
  for(const options of [null,{limit:0},{limit:51},{limit:1.5},{limit:'20'},{cursor:''},{cursor:'a'.repeat(4097)},{cursor:null},{offset:0},{storeId:'store'}])await assert.rejects(read('company','conversation',options),{code:'INVALID_REQUEST'});
  await assert.rejects(read('','conversation'),{code:'INVALID_REQUEST'});await assert.rejects(read('company',''),{code:'INVALID_REQUEST'});assert.equal(calls,0);
  await read('company','conversation',{limit:50});assert.equal(calls,1);
});

test('the editor can reuse the exact non-mutating note body validation',()=>{
  const valid=Reflect.get(api,'isValidConversationNoteBody');assert.equal(typeof valid,'function');
  for(const body of [' 正文\n\t ','字'.repeat(4000),'😀'.repeat(2000)])assert.equal(valid(body),true);
  for(const body of ['', ' \n\t ', '字'.repeat(4001), '😀'.repeat(2001), '\ud800', '文本\u0001', '文本\u007f'])assert.equal(valid(body),false);
});
