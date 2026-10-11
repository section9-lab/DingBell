import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as v from 'valibot';
import type {AiRun} from '../src/modules/conversations/ai-state.ts';
import {aiAnswerFixture} from './fixtures/ai-answer.ts';
import {reviewAiKnowledgeEvidence} from '../src/modules/ai-runs/knowledge.ts';
async function api(){const m=await import('../src/modules/conversations/reply-tool.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.createReplyTool,'function','An automatic reply must use a scoped preparation tool, never submit_answer or direct send');return m!;}
function run():AiRun{return {schemaVersion:1,scope:{organizationId:'org',storeId:'store',conversationId:'conv',controllerId:'controller'},request:{runId:crypto.randomUUID(),expectedVersion:0,messageId:'message',policyId:'policy',stage:'presale',language:'ru'},
 admission:{messageId:'message',inputRevision:1,question:'Какая ширина?',policyId:'policy',policyRevision:1,policyConfig:{kind:'automatic',name:'Support',storeIds:['store'],priority:50,stages:['presale'],mode:'automatic',language:'customer',tone:'concise',instructions:''},stage:'presale',language:'ru'},controlEpoch:1,startedAt:1,deadlineAt:60001};}
const data={body:'Ширина — 26 см.',citations:['a'.repeat(64)]};
function handoff(work:AiRun,input:unknown){return {outcome:'accepted',receipt:{action:'request_handoff',origin:'agent',commandId:`ai-handoff:${work.request.runId}`,expectedVersion:1,actorUserId:null,actorMemberId:null,run:work,input,
 appliedState:{schemaVersion:2,lifecycle:'open',reception:'paused',workStatus:'needs_reply',assignedMemberId:null,version:2,sequence:2,controlEpoch:2,updatedAt:2}}};}
function context(signal?:AbortSignal){const saved=new Map<string,unknown>();return {data,signal,toolCallId:'synthetic-reply',step:{do:async(name:string,fn:()=>unknown)=>{if(!saved.has(name))saved.set(name,await fn());return saved.get(name);}}};}

test('reply preparation freezes original authority and terminates without sending or handing off on success',async()=>{
 const m=await api(),value=run(),original=structuredClone(value);let preparations=0,wakes=0,handoffs=0;
 const tool=m.createReplyTool(value,{async prepare(scope,id,input){assert.deepEqual(scope,original.scope);assert.equal(id,original.request.runId);assert.deepEqual(input,data);preparations++;return {status:'prepared',intentId:'ai-reply:'+id,canSend:false,sent:false};},
  async wakeAiReply(scope,id){assert.deepEqual(scope,original.scope);assert.equal(id,original.request.runId);wakes++;},async requestHandoff(){handoffs++;return {outcome:'unavailable'};}});
 assert.equal(tool.name,'prepare_reply');assert.ok(v.is(tool.input,data));
 for(const extra of [{runId:'forged'},{scope:{storeId:'foreign'}},{platformThreadId:'forged'},{deadlineAt:900000},{credentialVersion:2},{actorMemberId:'owner-member'},{canSend:true}])assert.equal(v.is(tool.input,{...data,...extra}),false);
 assert.equal(v.is(tool.input,{...data,citations:[]}),false);
 value.scope.storeId='forged';value.request.runId=crypto.randomUUID();const ctx=context(),first=await tool.run(ctx as any);
 assert.deepEqual(first,{output:{status:'prepared',observation:'scheduled',handoff:'none',canSend:false,sent:false},terminate:true});
 assert.deepEqual(await tool.run(ctx as any),first);assert.equal(preparations,1);assert.equal(wakes,2,'durable replay can repeat an idempotent observation wake');assert.equal(handoffs,0);
 for(const privateValue of [original.request.runId,original.scope.controllerId])assert.equal(JSON.stringify(first.output).includes(privateValue),false);
});
test('a failed wake keeps a confirmed immutable reply and can retry observation without human handoff',async()=>{
 const m=await api(),work=run();let preparations=0,wakes=0,handoffs=0;
 const tool=m.createReplyTool(work,{async prepare(_scope,id){preparations++;return {status:'prepared',intentId:'ai-reply:'+id,canSend:false,sent:false};},async wakeAiReply(){if(++wakes===1)throw new Error('synthetic lost wake');},async requestHandoff(){handoffs++;return {outcome:'unavailable'};}});
 const ctx=context(),first=await tool.run(ctx as any);assert.deepEqual(first,{output:{status:'prepared',observation:'unconfirmed',handoff:'none',canSend:false,sent:false},terminate:true});
 const recovered=await tool.run(ctx as any);assert.equal(recovered.output.status,'prepared');assert.equal(recovered.output.observation,'scheduled');assert.equal(preparations,1);assert.equal(wakes,2);assert.equal(handoffs,0);
});
test('rejected, conflicting, uncertain or forged preparation results request handoff and never wake a sender',async()=>{
 const m=await api(),work=run();let handoffs=0,wakes=0;
 for(const outcome of [{status:'unavailable',intentId:null,canSend:false,sent:false},{status:'conflict',intentId:'ai-reply:'+work.request.runId,canSend:false,sent:false},
  {status:'unconfirmed',intentId:'ai-reply:'+work.request.runId,canSend:false,sent:false},{status:'prepared',intentId:'ai-reply:'+crypto.randomUUID(),canSend:false,sent:false},
  {status:'prepared',intentId:'ai-reply:'+work.request.runId,canSend:true,sent:false},null]){
  const tool=m.createReplyTool(work,{prepare:async()=>outcome,async wakeAiReply(){wakes++;},async requestHandoff(scope,id,input){assert.deepEqual(scope,work.scope);assert.equal(id,work.request.runId);assert.equal(input.reason,'tool_failure');handoffs++;return handoff(work,input);}});
  const ctx=context(),first=await tool.run(ctx as any);assert.equal(first.terminate,true);assert.notEqual(first.output.status,'prepared');assert.equal(first.output.handoff,'committed');assert.equal(first.output.observation,'not_requested');assert.equal(first.output.sent,false);assert.equal(first.output.canSend,false);
  assert.deepEqual(await tool.run(ctx as any),first);
 }
 assert.equal(handoffs,6);assert.equal(wakes,0);
});
test('preparation exceptions fail closed and an aborted tool performs no writes or wake',async()=>{
 const m=await api(),work=run();let preparations=0,wakes=0,handoffs=0;
 const tool=m.createReplyTool(work,{async prepare(){preparations++;throw new Error('synthetic preparation unavailable');},async wakeAiReply(){wakes++;},async requestHandoff(){handoffs++;return {outcome:'unavailable'};}});
 const first=await tool.run(context() as any);assert.equal(first.terminate,true);assert.equal(first.output.status,'unconfirmed');assert.equal(first.output.handoff,'rejected');assert.equal(first.output.canSend,false);assert.equal(first.output.sent,false);
 const controller=new AbortController();controller.abort(new Error('synthetic abort'));await assert.rejects(async()=>await tool.run(context(controller.signal) as any));assert.equal(preparations,1);assert.equal(handoffs,1);assert.equal(wakes,0);
});
test('the reply prompt can review original published evidence only while all three switches remain enabled',{timeout:30000},async t=>{
 const x=await aiAnswerFixture('support-reply-v1');t.after(x.f.close);const env={...x.env,AI_OUTBOUND_ENABLED:'true',OUTBOUND_ENABLED:'true'},id=x.run.request.runId;
 assert.deepEqual(await reviewAiKnowledgeEvidence(env,x.read,x.scope,id,x.evidence),x.evidence);
 for(const flag of ['AI_RECEPTION_ENABLED','AI_OUTBOUND_ENABLED','OUTBOUND_ENABLED'])assert.equal(await reviewAiKnowledgeEvidence({...env,[flag]:'false'},x.read,x.scope,id,x.evidence),null,flag);
});
