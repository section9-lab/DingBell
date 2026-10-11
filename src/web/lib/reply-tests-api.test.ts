/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retrieveReplyTest,generateReplyTest,readReplyTest } from './reply-tests-api.ts';

const input={requestId:'00000000-0000-4000-8000-000000000001',messageId:'message',policyId:'policy',stage:'presale' as const,language:'ru' as const};
const view={...input,policyRevision:1,question:'Размер?',status:'ready',sources:[],answer:null};
const response={companyId:'company',conversationId:'conversation',viewerMemberId:'member',test:view};
test('answer-test requests bind membership and the frozen target; generation sends no model input',async t=>{
  const calls:{url:string;init:RequestInit}[]=[];
  t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json(response);});
  await retrieveReplyTest('company','conversation','member',input);
  await generateReplyTest('company','conversation','member',input);
  const abort=new AbortController();await readReplyTest('company','conversation','member',input,abort.signal);
  assert.deepEqual(calls.map(c=>c.url),['/api/companies/company/conversations/conversation/reply-tests',
    `/api/companies/company/conversations/conversation/reply-tests/${input.requestId}/generate`,
    `/api/companies/company/conversations/conversation/reply-tests/${input.requestId}`]);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)),input);assert.equal(calls[1].init.body,'{}');assert.equal(calls[2].init.body,undefined);
  for(const {init}of calls){assert.equal(init.cache,'no-store');assert.equal(init.credentials,'same-origin');assert.equal(new Headers(init.headers).get('X-DingBell-Member-Id'),'member');}
});
test('answer-test responses reject scope or target drift, contradictory state and invented send permissions',async t=>{
  let payload:unknown=response;t.mock.method(globalThis,'fetch',async()=>Response.json(payload));
  for(payload of [{...response,companyId:'other'},{...response,conversationId:'other'},{...response,viewerMemberId:'rejoined'},
    ...[{messageId:'other'},{policyId:'other'},{stage:'aftersale'},{language:'en'},{requestId:crypto.randomUUID()},
      {status:'changed',sources:[{documentId:'doc',revision:1,chunkId:'chunk',bodyHash:'a'.repeat(64),body:'source',score:1}]},
      {status:'prepared',answer:{status:'pending',usageStatus:'held',reason:null,review:null}}].map(change=>({...response,test:{...view,...change}}))]){
    await assert.rejects(readReplyTest('company','conversation','member',input),{code:'INVALID_RESPONSE'});
    await assert.rejects(retrieveReplyTest('company','conversation','member',input),{code:'OPERATION_UNCONFIRMED'});
  }
});
test('invalid identities and browser-supplied facts fail before any network call',async t=>{
  const fetch=t.mock.method(globalThis,'fetch',async()=>Response.json(response));
  for(const invalid of ['', ' x','a'.repeat(129),'a\n','\ud800'])await assert.rejects(retrieveReplyTest(invalid,'conversation','member',input),{code:'INVALID_REQUEST'});
  for(const patch of [{question:'injected'},{budgetId:'forged'},{requestId:'bad'},{messageId:' a'},{stage:'notification'}])
    await assert.rejects(retrieveReplyTest('company','conversation','member',{...input,...patch} as typeof input),{code:'INVALID_REQUEST'});
  assert.equal(fetch.mock.callCount(),0);
});
test('uncertain POSTs are never retried and reads keep their original failure code',async t=>{
  let error='INTERNAL_ERROR';const fetch=t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:error}},{status:503}));
  await assert.rejects(generateReplyTest('company','conversation','member',input),{code:'OPERATION_UNCONFIRMED'});assert.equal(fetch.mock.callCount(),1);
  await assert.rejects(readReplyTest('company','conversation','member',input),{code:'INTERNAL_ERROR'});
  for(error of ['REPLY_TEST_DISABLED','BUDGET_UNAVAILABLE','REPLY_TEST_QUERY_LIMIT','PRICING_UNAVAILABLE','FORBIDDEN','REPLY_TEST_CONFLICT'])
    await assert.rejects(retrieveReplyTest('company','conversation','member',input),{code:error});
});
