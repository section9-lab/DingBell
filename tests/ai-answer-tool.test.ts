import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as v from 'valibot';
import type {AiRun} from '../src/modules/conversations/ai-state.ts';
async function api(){const m=await import('../src/modules/conversations/answer-tool.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.createAnswerTool,'function');return m!;}
function run():AiRun{return {schemaVersion:1,scope:{organizationId:'org',storeId:'store',conversationId:'conv',controllerId:'controller'},request:{runId:crypto.randomUUID(),expectedVersion:0,messageId:'message',policyId:'policy',stage:'presale',language:'ru'},
 admission:{messageId:'message',inputRevision:1,question:'Какая ширина?',policyId:'policy',policyRevision:1,policyConfig:{kind:'automatic',name:'Support',storeIds:['store'],priority:50,stages:['presale'],mode:'automatic',language:'customer',tone:'concise',instructions:''},stage:'presale',language:'ru'},controlEpoch:1,startedAt:1,deadlineAt:60001};}
test('answer submission has no model-selected authority, saves once and confirms a separate human-review handoff',async()=>{
 const m=await api(),work=run(),data={body:'Ширина — 26 см.',citations:['a'.repeat(64)]};let submissions=0,handoffs=0;
 const tool=m.createAnswerTool(work,{async submit(scope,id,input){assert.deepEqual(scope,work.scope);assert.equal(id,work.request.runId);assert.deepEqual(input,data);submissions++;return {status:'submitted',canSend:false,reviewRequired:true};},async requestHandoff(scope,id,input){
  assert.deepEqual(scope,work.scope);assert.equal(id,work.request.runId);assert.equal(input.reason,'merchant_decision');assert.equal('schemaVersion' in input&&input.schemaVersion,2);assert.deepEqual(input.neededInformation,[]);handoffs++;
  return {outcome:'accepted',receipt:{action:'request_handoff',origin:'agent',commandId:`ai-handoff:${id}`,expectedVersion:1,actorUserId:null,actorMemberId:null,run:work,input,
   appliedState:{schemaVersion:2,lifecycle:'open',reception:'paused',workStatus:'needs_reply',assignedMemberId:null,version:2,sequence:2,controlEpoch:2,updatedAt:2}}};
 }});
 assert.ok(v.is(tool.input,data));assert.ok(!v.is(tool.input,{...data,runId:'forged'}));assert.ok(!v.is(tool.input,{...data,citations:[]}));
 const saved=new Map<string,unknown>(),ctx={data,toolCallId:'synthetic',step:{do:async(name:string,fn:()=>unknown)=>{if(!saved.has(name))saved.set(name,await fn());return saved.get(name);}}};
 const first=await tool.run(ctx as any);assert.deepEqual(first,{output:{status:'submitted',reviewRequired:true,handoff:'committed',canSend:false,sent:false},terminate:true});
 assert.deepEqual(await tool.run(ctx as any),first);assert.equal(submissions,1);assert.equal(handoffs,1);
});
test('a rejected or uncertain draft cannot be reported as submitted or generate another model response',async()=>{
 const m=await api(),work=run();let handoffs=0;
 for(const outcome of [{status:'unavailable',canSend:false,reviewRequired:true},{status:'submitted',canSend:true,reviewRequired:true},null]){
  const tool=m.createAnswerTool(work,{submit:async()=>outcome,requestHandoff:async()=>{handoffs++;return {outcome:'unavailable'};}});
  const result=await tool.run({data:{body:'Test',citations:['a'.repeat(64)]},step:{do:async(_name:string,fn:()=>unknown)=>fn()}} as any);
  assert.equal(result.terminate,true);assert.notEqual(result.output.status,'submitted');assert.equal(result.output.canSend,false);assert.equal(result.output.sent,false);
 }
 assert.equal(handoffs,3,'even an unavailable draft requests safe fallback without claiming it succeeded');
});
