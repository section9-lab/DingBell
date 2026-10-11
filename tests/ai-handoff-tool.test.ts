import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as v from 'valibot';
import type {AiRun,AiHandoff} from '../src/modules/conversations/ai-state.ts';
async function api(){const m=await import('../src/modules/conversations/handoff-tool.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.createHandoffTool,'function','handoff must use a bounded Flue tool bound to the admitted run');return m!;}
function fixture(){
 const run:AiRun={schemaVersion:1,scope:{organizationId:'org',storeId:'store',conversationId:'conv',controllerId:'controller'},
  request:{runId:crypto.randomUUID(),expectedVersion:0,messageId:'message',policyId:'policy',stage:'presale',language:'ru'},
  admission:{messageId:'message',inputRevision:1,question:'Мне нужен человек.',policyId:'policy',policyRevision:1,policyConfig:{kind:'automatic',name:'Support',storeIds:['store'],priority:50,stages:['presale'],mode:'automatic',language:'customer',tone:'concise',instructions:''},stage:'presale',language:'ru'},controlEpoch:1,startedAt:1,deadlineAt:60001};
 const input:AiHandoff={reason:'customer_request',summary:'Клиент просит человека.',neededInformation:[]};
 const receipt={action:'request_handoff',origin:'agent',commandId:`ai-handoff:${run.request.runId}`,expectedVersion:1,actorUserId:null,actorMemberId:null,run:structuredClone(run),input,
  appliedState:{schemaVersion:2,lifecycle:'open',reception:'paused',assignedMemberId:null,workStatus:'needs_reply',version:2,sequence:2,controlEpoch:2,updatedAt:2}};
 return {run,input,result:{outcome:'accepted',receipt}};
}
const context=(data:AiHandoff)=>({data,toolCallId:'synthetic-tool-call',step:{do:async<T>(_name:string,fn:()=>T|Promise<T>)=>fn()},log:{info(){},warn(){},error(){}}});
test('Flue handoff captures its authority, exposes only constrained input and returns a terminal minimal result',async()=>{
 const {createHandoffTool}=await api(),f=fixture(),original=structuredClone(f.run);let args:unknown[]=[];
 const tool=createHandoffTool(f.run,{async requestHandoff(...input){args=input;return f.result;}});
 f.run.scope.organizationId='other';f.run.request.runId=crypto.randomUUID();
 assert.equal(tool.name,'request_handoff');assert.equal(tool.durable,true);assert.equal(tool.timeoutMs,10000);
 for(const field of ['runId','organizationId','body','actorUserId','language'])assert.equal(v.is(tool.input!,{...f.input,[field]:'chosen'}),false);
 assert.deepEqual(await tool.run(context(f.input)),{output:{status:'committed',canSend:false,sent:false},terminate:true});
 assert.deepEqual(args,[original.scope,original.request.runId,f.input]);
});
test('mismatched or absent handoff receipts and lost responses never become confirmed success',async()=>{
 const {createHandoffTool}=await api(),f=fixture();
 for(const result of [{outcome:'accepted'},{...f.result,receipt:{...f.result.receipt,origin:'system'}},{...f.result,receipt:{...f.result.receipt,input:{...f.input,summary:'changed'}}},{...f.result,receipt:{...f.result.receipt,run:{...f.result.receipt.run,scope:{...f.run.scope,organizationId:'foreign'}}}},null]){
  const tool=createHandoffTool(f.run,{async requestHandoff(){return result;}});assert.deepEqual(await tool.run(context(f.input)),{output:{status:'unconfirmed',canSend:false,sent:false},terminate:true});
 }
 const lost=createHandoffTool(f.run,{async requestHandoff(){throw new Error('synthetic lost response');}});assert.deepEqual(await lost.run(context(f.input)),{output:{status:'unconfirmed',canSend:false,sent:false},terminate:true});
});
test('refused handoffs terminate without claiming success and an already aborted call cannot invoke the controller',async()=>{
 const {createHandoffTool}=await api(),f=fixture();let calls=0;
 for(const outcome of ['conflict','unavailable']){
  const tool=createHandoffTool(f.run,{async requestHandoff(){calls++;return {outcome};}});
  assert.deepEqual(await tool.run(context(f.input)),{output:{status:'rejected',canSend:false,sent:false},terminate:true});
  const before=calls;await assert.rejects(()=>tool.run({...context(f.input),signal:AbortSignal.abort()}) as Promise<unknown>,{name:'AbortError'});assert.equal(calls,before);
 }
});
