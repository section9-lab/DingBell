/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from './api.ts';
import { submitReplyPreview,readReplyPreview,isValidReplyPreviewRequest,isReplyPreviewRejected,type ReplyPreviewRequest } from './conversation-preview-api.ts';

const input:ReplyPreviewRequest={requestId:'00000000-0000-4000-8000-000000000001',source:'  请核对规格。\r\n26 cm\t<b>纯文本</b>  ',sourceRevision:7};
const preview={...input,targetLanguage:'ru',status:'ready',translation:'  Проверьте размер: 26 см.\n<b>текст</b>  ',reason:null,usageStatus:'settled'};
const response={companyId:'company',conversationId:'conversation',viewerMemberId:'member',preview};

test('preview POST preserves the frozen request and has no routing or send command fields',async t=>{
  const mock=t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{
    assert.equal(url,'/api/companies/c%2F1/conversations/chat%2F1/reply-previews');
    assert.equal(init.method,'POST');assert.equal(init.cache,'no-store');assert.equal(init.credentials,'same-origin');
    assert.equal(new Headers(init.headers).get('X-DingBell-Member-Id'),encodeURIComponent('成员 /甲'));
    assert.deepEqual(JSON.parse(String(init.body)),input);
    return Response.json({...response,companyId:'c/1',conversationId:'chat/1',viewerMemberId:'成员 /甲'});
  });
  assert.deepEqual(await submitReplyPreview('c/1','chat/1','成员 /甲',input),{...response,companyId:'c/1',conversationId:'chat/1',viewerMemberId:'成员 /甲'});
  assert.equal(mock.mock.callCount(),1);
});
test('preview GET carries only the request ID in its URL and supports a read abort signal',async t=>{
  const abort=new AbortController();
  const mock=t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{
    assert.equal(url,`/api/companies/company/conversations/conversation/reply-previews/${input.requestId}`);
    assert.equal(init.method??'GET','GET');assert.equal(init.body,undefined);assert.equal(init.cache,'no-store');
    assert.equal(new Headers(init.headers).get('X-DingBell-Member-Id'),'member');assert.equal(init.signal?.aborted,false);
    abort.abort();assert.equal(init.signal?.aborted,true);return Response.json(response);
  });
  assert.deepEqual(await readReplyPreview('company','conversation','member',input,abort.signal),response);assert.equal(mock.mock.callCount(),1);
});
test('preview requests reject unsafe identities, extra fields and malformed source before fetch',async t=>{
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(response));
  for(const change of [{requestId:'not-uuid'},{source:''},{source:' \n\t'},{source:'x'.repeat(1001)},{source:'\ud800'},{source:'a\u0000b'},{source:'a\u007fb'},
    {sourceRevision:-1},{sourceRevision:0.5},{sourceRevision:Number.MAX_SAFE_INTEGER+1},{sourceRevision:'1'},{storeId:'forged'},{targetLanguage:'en'},{receipt:{uid:'private'}}]){
    const value={...input,...change} as ReplyPreviewRequest;assert.equal(isValidReplyPreviewRequest(value),false);
    await assert.rejects(submitReplyPreview('company','conversation','member',value),{code:'INVALID_REQUEST'});
    await assert.rejects(readReplyPreview('company','conversation','member',value),{code:'INVALID_REQUEST'});
  }
  for(const invalid of ['', ' x','x ','a'.repeat(257),'\ud800','a\u001fb','a\u007fb']){
    for(const values of [[invalid,'conversation','member'],['company',invalid,'member'],['company','conversation',invalid]]){
      await assert.rejects(submitReplyPreview(values[0]!,values[1]!,values[2]!,input),{code:'INVALID_REQUEST'});
      await assert.rejects(readReplyPreview(values[0]!,values[1]!,values[2]!,input),{code:'INVALID_REQUEST'});
    }
  }
  assert.equal(mock.mock.callCount(),0);
  assert.equal(isValidReplyPreviewRequest({...input,source:'字'.repeat(1000),sourceRevision:Number.MAX_SAFE_INTEGER}),true);
});
test('preview responses must match member, scope, exact source and draft revision',async t=>{
  let payload:any=response;const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(payload));
  const invalid=[{...response,companyId:'other'},{...response,conversationId:'other'},{...response,viewerMemberId:'rejoined'},
    {...response,viewerMemberId:undefined},...[{requestId:'00000000-0000-4000-8000-000000000002'},{source:input.source.trim()},{sourceRevision:8},{sourceRevision:6},{targetLanguage:'en'}]
      .map(change=>({...response,preview:{...preview,...change}}))];
  for(payload of invalid){
    await assert.rejects(readReplyPreview('company','conversation','member',input),{code:'INVALID_RESPONSE'});
    await assert.rejects(submitReplyPreview('company','conversation','member',input),{code:'OPERATION_UNCONFIRMED'});
  }
  assert.equal(mock.mock.callCount(),invalid.length*2);
});
test('preview state and body validation accepts held usable output but never promotes uncertain output',async t=>{
  let value:any=preview;t.mock.method(globalThis,'fetch',async()=>Response.json({...response,preview:value}));
  for(const patch of [{usageStatus:'held',reason:'USAGE_UNCONFIRMED'},
    {status:'pending',translation:null,reason:null,usageStatus:'held'},
    {status:'unconfirmed',translation:null,reason:'AUTHORITY_UNAVAILABLE',usageStatus:'settled'},
    {status:'unconfirmed',translation:null,reason:'OUTPUT_UNCONFIRMED',usageStatus:'settled'},
    {status:'unavailable',translation:null,reason:'EXECUTION_CLOSED',usageStatus:'released'}]){
    value={...preview,...patch};assert.deepEqual((await readReplyPreview('company','conversation','member',input)).preview,value);
  }
  for(const patch of [{translation:null},{translation:''},{translation:'\ud800'},{translation:'x'.repeat(1001)},
    {status:'pending',translation:'not ready'},{status:'unconfirmed',translation:'not ready'},{status:'unavailable',translation:'not ready'},
    {status:'pending',translation:null,reason:'INVALID_OUTPUT'},{status:'invented'},{usageStatus:'free'},{reason:'raw provider secret error'},
    {status:'unconfirmed',translation:null,reason:null},{status:'unavailable',translation:null,reason:null}]){
    value={...preview,...patch};await assert.rejects(readReplyPreview('company','conversation','member',input),{code:'INVALID_RESPONSE'});
  }
});
test('missing or extra preview DTO fields are not silently accepted',async t=>{
  let payload:any=response;t.mock.method(globalThis,'fetch',async()=>Response.json(payload));
  for(const field of Object.keys(preview)){const value:any={...preview};delete value[field];payload={...response,preview:value};await assert.rejects(readReplyPreview('company','conversation','member',input),{code:'INVALID_RESPONSE'});}
  for(payload of [{...response,receipt:{uid:'private'}},{...response,preview:{...preview,storeId:'private'}}])await assert.rejects(readReplyPreview('company','conversation','member',input),{code:'INVALID_RESPONSE'});
});
test('released budget can only describe a closed unavailable execution, never a usable translation',async t=>{
  let value:any={...preview,usageStatus:'released'};t.mock.method(globalThis,'fetch',async()=>Response.json({...response,preview:value}));
  for(const patch of [{},{status:'pending',translation:null},{status:'unconfirmed',translation:null,reason:'AUTHORITY_UNAVAILABLE'}]){
    value={...preview,usageStatus:'released',...patch};await assert.rejects(readReplyPreview('company','conversation','member',input),{code:'INVALID_RESPONSE'});
  }
  // The first failed zero-request observation closes and releases with EXECUTION_FAILED;
  // later reads of the released run report EXECUTION_CLOSED.
  for(const reason of ['EXECUTION_FAILED','EXECUTION_CLOSED']){
    value={...preview,usageStatus:'released',status:'unavailable',translation:null,reason};
    assert.deepEqual((await readReplyPreview('company','conversation','member',input)).preview,value);
  }
});
test('preview POST preserves explicit rejection and conflict codes but treats unknown errors as unconfirmed',async t=>{
  let errorCode='TRANSLATION_DISABLED',status=403;
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:errorCode},requestId:'public-request-id'},{status}));
  for(const [code,http] of [['TRANSLATION_DISABLED',403],['BUDGET_UNAVAILABLE',412],['PRICING_UNAVAILABLE',503],['RUNTIME_UNAVAILABLE',503],
    ['PREVIEW_CONFLICT',409],['NOT_FOUND',404],['UNAUTHENTICATED',401],['INVALID_REQUEST',400],['REQUEST_TOO_LARGE',413],['ORIGIN_REJECTED',403]] as const){
    errorCode=code;status=http;await assert.rejects(submitReplyPreview('company','conversation','member',input),(error:any)=>error instanceof ApiError&&error.code===code&&error.requestId==='public-request-id');
  }
  errorCode='UPSTREAM_UNAVAILABLE';status=503;
  await assert.rejects(submitReplyPreview('company','conversation','member',input),(error:any)=>error instanceof ApiError&&error.code==='OPERATION_UNCONFIRMED'&&error.requestId==='public-request-id');
  assert.equal(mock.mock.callCount(),11);
  await assert.rejects(readReplyPreview('company','conversation','member',input),{code:'UPSTREAM_UNAVAILABLE'});assert.equal(mock.mock.callCount(),12);
});
test('network and invalid-success POSTs never retry or replace the original request',async t=>{
  const mock=t.mock.method(globalThis,'fetch',async(_url:string,_init:RequestInit):Promise<Response>=>{throw new Error('synthetic private network error');});
  await assert.rejects(submitReplyPreview('company','conversation','member',input),{code:'OPERATION_UNCONFIRMED'});assert.equal(mock.mock.callCount(),1);
  mock.mock.mockImplementation(async()=>Response.json({accepted:true}));
  await assert.rejects(submitReplyPreview('company','conversation','member',input),{code:'OPERATION_UNCONFIRMED'});assert.equal(mock.mock.callCount(),2);
  for(const call of mock.mock.calls)assert.deepEqual(JSON.parse(String((call.arguments[1] as RequestInit).body)),input);
});
test('only explicit POST admission rejection allows releasing the preview journal',()=>{
  for(const code of ['INVALID_REQUEST','REQUEST_TOO_LARGE','ORIGIN_REJECTED','IDENTITY_NOT_CONFIGURED','TRANSLATION_DISABLED','BUDGET_UNAVAILABLE','PRICING_UNAVAILABLE','RUNTIME_UNAVAILABLE'])assert.equal(isReplyPreviewRejected(new ApiError(code)),true,code);
  for(const code of ['PREVIEW_CONFLICT','OPERATION_UNCONFIRMED','TRANSLATION_UNAVAILABLE','NETWORK_ERROR','INVALID_RESPONSE','NOT_FOUND','UNAUTHENTICATED','FORBIDDEN','UPSTREAM_UNAVAILABLE'])assert.equal(isReplyPreviewRejected(new ApiError(code)),false,code);
  assert.equal(isReplyPreviewRejected({code:'BUDGET_UNAVAILABLE'}),false);assert.equal(isReplyPreviewRejected(new Error('unknown')),false);
});
