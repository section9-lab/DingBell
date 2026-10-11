/// <reference types="node" />
import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as module from './ai-reception-api.ts';
const api=module as Record<string,(...args:any[])=>Promise<any>>;
const command={commandId:'00000000-0000-4000-8000-000000000001',expectedVersion:4};
const boundary={commandId:command.commandId,controlEpoch:2,afterSequence:55,resumedAt:'2026-10-10T10:00:00.000Z'};
const result={companyId:'company',conversationId:'conversation',viewerMemberId:'member',projectionPending:false,
 control:{version:5,controlEpoch:2,sequence:5,lifecycle:'open',reception:'ai',updatedAt:boundary.resumedAt},waiting:boundary,
 resumption:{...boundary,expectedVersion:4,appliedVersion:5,actorMemberId:'member'}};
test('resumption writes only the reviewed command and reads use canonical membership without a POST',async t=>{
 assert.equal(typeof api.resumeAiReception,'function');let mode='post';const signal=new AbortController().signal;
 const mock=t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{
  assert.equal(init.credentials,'same-origin');assert.equal(init.cache,'no-store');assert.equal(new Headers(init.headers).get('X-DingBell-Member-Id'),encodeURIComponent('成员 /甲'));
  const base='/api/companies/c%2F1/conversations/chat%2F1';assert.equal(url,`${base}${mode==='state'?'/ai-reception':`/ai-resumptions${mode==='read'?'/'+command.commandId:''}`}`);
  assert.equal(init.method??'GET',mode==='post'?'POST':'GET');assert.equal(init.body,mode==='post'?JSON.stringify(command):undefined);if(mode!=='post')assert.equal(init.signal?.aborted,false);
  return Response.json({...result,companyId:'c/1',conversationId:'chat/1',viewerMemberId:'成员 /甲',resumption:mode==='state'?null:{...result.resumption,actorMemberId:'成员 /甲'}});
 });
 await api.resumeAiReception!('c/1','chat/1','成员 /甲',command);mode='read';await api.readAiResumption!('c/1','chat/1','成员 /甲',command,signal);mode='state';await api.readAiReception!('c/1','chat/1','成员 /甲',signal);assert.equal(mock.mock.callCount(),3);
});
test('untrusted response scope, original version and waiting authority cannot be accepted',async t=>{
 assert.equal(typeof api.readAiResumption,'function');let payload:any=result;t.mock.method(globalThis,'fetch',async()=>Response.json(payload));
 const invalid=[{...result,companyId:'other'},{...result,conversationId:'other'},{...result,viewerMemberId:'rejoined'},
  {...result,resumption:null},{...result,resumption:{...result.resumption,commandId:crypto.randomUUID()}},{...result,resumption:{...result.resumption,expectedVersion:3,appliedVersion:4}},
  {...result,waiting:{...boundary,controlEpoch:1}},{...result,control:{...result.control,reception:'human'}},{...result,providerKey:'unexpected'}];
 for(payload of invalid){await assert.rejects(api.readAiResumption!('company','conversation','member',command),{code:'INVALID_RESPONSE'});await assert.rejects(api.resumeAiReception!('company','conversation','member',command),{code:'OPERATION_UNCONFIRMED'});}
 payload={...result,waiting:null,control:{...result.control,reception:'human',version:6,controlEpoch:3}};
 assert.deepEqual((await api.readAiResumption!('company','conversation','member',command)).resumption,result.resumption);
 await assert.rejects(api.readAiReception!('company','conversation','member'),{code:'INVALID_RESPONSE'});
});
test('invalid identities and attempts to supply server authority fail before any request',async t=>{
 assert.equal(typeof api.resumeAiReception,'function');const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(result));
 for(const value of [undefined,null,{}]){await assert.rejects(api.resumeAiReception!('company','conversation','member',value),{code:'INVALID_REQUEST'});await assert.rejects(api.readAiResumption!('company','conversation','member',value),{code:'INVALID_REQUEST'});}
 for(const change of [{commandId:'invalid'},{expectedVersion:-1},{expectedVersion:0.1},{expectedVersion:Number.MAX_SAFE_INTEGER},{previousRunId:crypto.randomUUID()},{messageId:'old'},{budgetId:'chosen'}])
  await assert.rejects(api.resumeAiReception!('company','conversation','member',{...command,...change}),{code:'INVALID_REQUEST'});
 for(const bad of ['',' x','x ','x'.repeat(257),'\ud800','x\u0000'])for(const args of [[bad,'conversation','member'],['company',bad,'member'],['company','conversation',bad]])
  await assert.rejects(api.readAiReception!(...args),{code:'INVALID_REQUEST'});
 assert.equal(mock.mock.callCount(),0);
});
test('lost and malformed write responses stay unconfirmed without automatic retries',async t=>{
 assert.equal(typeof api.resumeAiReception,'function');const mock=t.mock.method(globalThis,'fetch',async()=>{throw new TypeError('network');});
 await assert.rejects(api.resumeAiReception!('company','conversation','member',command),{code:'OPERATION_UNCONFIRMED'});assert.equal(mock.mock.callCount(),1);
});
