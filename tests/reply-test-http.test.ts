import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/application.ts';
import { conversationsFixture } from './fixtures/conversations.ts';
import { seedReplyTest } from './fixtures/reply-test.ts';
import { createReplyTestBudget,setReplyTestBudgetEnabled,readReplyTestExecutionContext,claimReplyTestProviderRequest } from '../src/modules/reply-tests/storage.ts';
import { readControlAccess } from '../src/modules/conversations/control-storage.ts';
import { normalizeControlState } from '../src/modules/conversations/control-state.ts';
import type { ReplyTestControlReader } from '../src/modules/reply-tests/service.ts';
import type { ReplyTestRuntime,ReplyTestInspection } from '../src/modules/reply-tests/execution.ts';
import { knowledgeProfile } from '../src/modules/knowledge/vectorize.ts';

async function fixture(){
  const f=await conversationsFixture(),actor={orgId:'company',actorUserId:'owner',sessionId:(await f.DB.prepare("SELECT id FROM session WHERE user_id='owner'").first<{id:string}>())!.id};
  const seed=await seedReplyTest(f.DB,actor,'store-a','reply-http');await seed.source();
  const control:ReplyTestControlReader=async(scope,caller)=>{const a=await readControlAccess(f.DB,caller,scope.conversationId);return a?.directory?{outcome:'found',view:{viewerMemberId:a.memberId,state:normalizeControlState(a.directory.state),projectionPending:false}}:{outcome:'not_found'};};
  await createReplyTestBudget(f.DB,actor,{id:'budget',startsAt:Date.now()-1000,endsAt:Date.now()+3600_000,limitMicros:100000,maxRuns:10});await setReplyTestBudgetEnabled(f.DB,actor,'budget',0,true);
  let embeds=0,generations=0,afterDispatch:()=>Promise<void>=async()=>{};
  const states=new Map<string,ReplyTestInspection>(),receipts=new Map<string,{submissionId:string;uid:string;acceptedAt:string}>();
  const runtime:ReplyTestRuntime={lookup:async id=>receipts.has(id)?{uid:receipts.get(id)!.uid}:null,inspect:async id=>states.get(id)??null,
    prepare:async(scope,id)=>{const run=await readReplyTestExecutionContext(f.DB,control,scope,id);assert.ok(run);states.set(id,{run,generation:0,http:0,closed:false,evidence:null});},
    dispatch:async run=>{if(!receipts.has(run.id)){assert.ok(await claimReplyTestProviderRequest(f.DB,control,run.payload.context.scope,run.id));generations++;receipts.set(run.id,{submissionId:crypto.randomUUID(),uid:crypto.randomUUID(),acceptedAt:new Date().toISOString()});await afterDispatch();}return receipts.get(run.id)!;},
    read:async id=>({outcome:'completed',text:JSON.stringify({kind:'answer',body:'Ширина — 26 см.',sources:[{chunkId:states.get(id)!.run.payload.evidence.chunks[0].chunkId,quote:'26 см.'}]}),metadata:{replyTest:{usageReported:true,usage:{input:9,output:3,cacheRead:2,cacheWrite:1},outputValid:true}}}),close:async()=>{throw new Error('unused');}};
  const env={...f.env,REPLY_TEST_ENABLED:'true',NVAPI_KEY:'synthetic',FLUE_REPLY_TEST_AGENT:{},KNOWLEDGE_INDEX:seed.index,
    KNOWLEDGE_AI:{run:async()=>{embeds++;return {data:[seed.embedding.values],shape:[1,1024]};}},
    REPLY_TEST_CONFIG_JSON:JSON.stringify({provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'nvidia-reply-test-v1',promptVersion:'grounded-reply-v1',maxInputTokens:262144,maxOutputTokens:2048,
      pricing:{version:'test',currency:'USD',inputMicrosPerMillion:100,outputMicrosPerMillion:200,cacheReadMicrosPerMillion:50,cacheWriteMicrosPerMillion:100}}),
    REPLY_TEST_QUERY_CONFIG_JSON:JSON.stringify({profile:knowledgeProfile.id,priceVersion:'test-bge',maxInputTokens:60000,inputMicrosPerMillion:11800,dailyLimitMicros:70800,maxQueries:100})};
  const app=createApp({replyTestControl:control,replyTestRuntime:runtime});
  const input=()=>({requestId:crypto.randomUUID(),messageId:seed.input.messageId,policyId:seed.input.policyId,stage:'presale',language:'ru'});
  function request(suffix='',options:{body?:unknown;method?:string;actor?:string;company?:string;conversation?:string;member?:string|null;origin?:string;query?:string;bindings?:object}={}){
    const who=options.actor??'owner',headers=new Headers({cookie:f.cookies[who]??'',origin:options.origin??f.env.APP_BASE_URL,'content-type':'application/json'});
    const member=options.member===undefined?`${who}-member`:options.member;if(member!==null)headers.set('X-DingBell-Member-Id',member);
    const method=options.method??(options.body===undefined?'GET':'POST');
    return app.request(`${f.env.APP_BASE_URL}/api/companies/${options.company??'company'}/conversations/${options.conversation??'reply-http'}/reply-tests${suffix}${options.query??''}`,
      {method,headers,...(method==='POST'?{body:JSON.stringify(options.body)}:{})},(options.bindings??env) as never);
  }
  return {...f,...seed,actor,env,input,request,onDispatch(fn:()=>Promise<void>){afterDispatch=fn;},counts:()=>({embeds,generations})};
}
async function code(response:Response,status:number,error:string){assert.equal(response.status,status,await response.clone().text());assert.equal((await response.json() as any).error.code,error);assert.equal(response.headers.get('cache-control'),'no-store');}

test('the authenticated answer-test API retrieves evidence, then separately generates and recovers the reviewed answer',{timeout:30000},async t=>{
  const f=await fixture();t.after(f.close);const input=f.input();
  const response=await f.request('',{body:input});assert.equal(response.status,200,await response.clone().text());const first=await response.json() as any;
  assert.equal(first.companyId,'company');assert.equal(first.conversationId,'reply-http');assert.equal(first.viewerMemberId,'owner-member');assert.equal(first.test.status,'ready');assert.equal(first.test.sources.length,1);assert.equal(first.test.answer,null);
  assert.deepEqual(f.counts(),{embeds:1,generations:0});
  const generated=await f.request(`/${input.requestId}/generate`,{body:{}});assert.equal(generated.status,200,await generated.clone().text());const answer=await generated.json() as any;
  assert.equal(answer.test.answer.status,'review_required');assert.equal(answer.test.answer.review.canSend,false);assert.equal(answer.test.answer.usageStatus,'settled');
  await f.request('',{body:input});await f.request(`/${input.requestId}/generate`,{body:{}});assert.deepEqual(f.counts(),{embeds:1,generations:1});
  const read=await f.request(`/${input.requestId}`);assert.equal(read.status,200);assert.deepEqual((await read.json() as any).test.answer,answer.test.answer);
  const serialized=JSON.stringify(answer);for(const hidden of ['sessionId','controllerId','payloadHash','vectors','NVAPI_KEY','reservedMicros','inputMicrosPerMillion'])assert.equal(serialized.includes(hidden),false,hidden);
  assert.equal(await f.DB.prepare('SELECT count(*) AS n FROM send_intent').first('n'),0);
});
test('answer-test routes require verified manager access, canonical membership and same-origin writes',{timeout:30000},async t=>{
  const f=await fixture();t.after(f.close);
  await code(await f.request('',{body:f.input(),actor:'anonymous'}),401,'UNAUTHENTICATED');
  await code(await f.request('',{body:f.input(),actor:'staff'}),403,'FORBIDDEN');
  await code(await f.request('',{body:f.input(),actor:'other'}),404,'NOT_FOUND');
  await code(await f.request('',{body:f.input(),origin:'https://elsewhere.invalid'}),403,'ORIGIN_REJECTED');
  for(const member of [null,'','%','%6fwner-member'])await code(await f.request('',{body:f.input(),member}),400,'INVALID_REQUEST');
  await code(await f.request('',{body:f.input(),member:'replaced-member'}),404,'NOT_FOUND');
  await code(await f.request('',{body:f.input(),bindings:{}}),503,'IDENTITY_NOT_CONFIGURED');
  assert.deepEqual(f.counts(),{embeds:0,generations:0});
});
test('clients cannot supply original question, scope, prices, embeddings or native receipts; identifiers cannot be rebound',{timeout:30000},async t=>{
  const f=await fixture();t.after(f.close);const input=f.input();
  for(const extra of [{question:'invented'},{storeId:'other'},{vectors:[1]},{config:{}},{price:0},{receipt:{}},{messageId:''},{stage:'notification'},{requestId:'not-uuid'}])
    await code(await f.request('',{body:{...input,...extra}}),400,'INVALID_REQUEST');
  await code(await f.request('',{body:input,query:'?retry=true'}),400,'INVALID_REQUEST');
  assert.equal((await f.request('',{body:input})).status,200);
  await code(await f.request('',{body:{...input,language:'en'}}),409,'REPLY_TEST_CONFLICT');
  await code(await f.request(`/${input.requestId}`,{conversation:'conv-a'}),404,'NOT_FOUND');
  await code(await f.request(`/${input.requestId}/generate`,{body:{runId:'invented'}}),400,'INVALID_REQUEST');
  await f.message('latest-http','Другой вопрос',20);
  const changed=await f.request(`/${input.requestId}/generate`,{body:{}});assert.equal(changed.status,200,await changed.clone().text());assert.equal((await changed.json() as any).test.status,'changed');assert.equal(f.counts().generations,0);
});
test('disabled and unpriced runtime settings make no embedding requests',{timeout:30000},async t=>{
  const f=await fixture();t.after(f.close);
  await code(await f.request('',{body:f.input(),bindings:{...f.env,REPLY_TEST_ENABLED:'false'}}),403,'REPLY_TEST_DISABLED');
  await code(await f.request('',{body:f.input(),bindings:{...f.env,REPLY_TEST_QUERY_CONFIG_JSON:''}}),503,'PRICING_UNAVAILABLE');
  await code(await f.request('',{body:f.input(),bindings:{...f.env,KNOWLEDGE_AI:undefined}}),503,'REPLY_TEST_UNAVAILABLE');
  assert.deepEqual(f.counts(),{embeds:0,generations:0});
});
test('a message arriving during generation invalidates all returned evidence and output',{timeout:30000},async t=>{
  const f=await fixture();t.after(f.close);const input=f.input();assert.equal((await f.request('',{body:input})).status,200);
  f.onDispatch(async()=>{await f.message('while-generating','Другой вопрос',20);});
  const response=await f.request(`/${input.requestId}/generate`,{body:{}});assert.equal(response.status,200);const body=await response.json() as any;
  assert.equal(body.test.status,'changed');assert.deepEqual(body.test.sources,[]);assert.equal(body.test.answer,null);assert.equal(f.counts().generations,1);
});
test('unstarted query admissions from an earlier UTC day cannot look ready to resume indefinitely',{timeout:30000},async t=>{
  const f=await fixture();t.after(f.close);const input=f.input();
  // Simulate an interrupted admission before embedding by removing its AI binding after the preflight.
  let reads=0;const env={...f.env,get KNOWLEDGE_AI(){return ++reads===1?f.env.KNOWLEDGE_AI:undefined;}};
  assert.equal((await f.request('',{body:input,bindings:env})).status,200);assert.equal(f.counts().embeds,0);
  const tomorrow=Date.now()+86_400_000;t.mock.method(Date,'now',()=>tomorrow);
  const response=await f.request(`/${input.requestId}`);assert.equal(response.status,200);assert.equal((await response.json() as any).test.status,'changed');
});
