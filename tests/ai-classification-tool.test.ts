import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as v from 'valibot';
import type {AiIntakeRun,AiClassification} from '../src/modules/conversations/ai-intake.ts';
import {classifyDecision} from '../src/modules/conversations/ai-intake.ts';
async function api(){const m=await import('../src/modules/conversations/classification-tool.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.createClassificationTool,'function','classification needs a bounded Flue tool');return m!;}
function fixture(){
 const scope={organizationId:'org',storeId:'store',conversationId:'conv',controllerId:'controller'},run:AiIntakeRun={schemaVersion:2,kind:'intake',scope,request:{runId:crypto.randomUUID(),expectedVersion:0,messageId:'message'},
  admission:{messageId:'message',inputRevision:1,question:'Когда приедет заказ?',event:{scope,eventId:'event',messageId:'message',sequence:1,eventAt:1,liveObservedAt:1},candidates:[{stage:'order',policyId:'policy',policyRevision:1,mode:'automatic',language:'customer'}]},controlEpoch:1,startedAt:1,deadlineAt:60001};
 const classification:AiClassification={stage:'order',language:'ru',customerRequestedHuman:false};
 const receipt={action:'ai_classification',origin:'agent',commandId:`ai-classification:${run.request.runId}`,expectedVersion:1,actorUserId:null,actorMemberId:null,run:structuredClone(run),classification,
  decision:{kind:'ready',nextRunId:crypto.randomUUID(),stage:'order',language:'ru',policyId:'policy',policyRevision:1},appliedState:{schemaVersion:2,lifecycle:'open',reception:'ai',assignedMemberId:null,workStatus:'needs_reply',version:2,sequence:2,controlEpoch:2,updatedAt:2}};
 return {run,classification,receipt,result:{outcome:'accepted',receipt}};
}
const context=(data:AiClassification)=>({data,toolCallId:'synthetic',step:{do:async<T>(_name:string,fn:()=>T|Promise<T>)=>fn()},log:{info(){},warn(){},error(){}}});
test('classification preserves human requests and suggestion-only policies, and uses a fixed policy language',()=>{
 const f=fixture();f.run.admission.candidates[0].language='en';
 assert.equal((classifyDecision(f.run,{...f.classification,language:'unknown'}) as any).language,'en');
 assert.deepEqual(classifyDecision(f.run,{...f.classification,customerRequestedHuman:true}),{kind:'handoff',reason:'customer_request'});
 f.run.admission.candidates[0].mode='suggest';assert.deepEqual(classifyDecision(f.run,f.classification),{kind:'handoff',reason:'policy_unavailable'});
 assert.deepEqual(classifyDecision(f.run,{...f.classification,stage:'aftersale'}),{kind:'handoff',reason:'policy_unavailable'});
});
test('classification tool freezes authority, accepts only classification fields and ends the run',async()=>{
 const m=await api(),f=fixture(),original=structuredClone(f.run);let captured:unknown[]=[];const tool=m.createClassificationTool(f.run,{async recordAiClassification(...args){captured=args;return f.result;}});
 f.run.scope.organizationId='other';assert.equal(tool.name,'submit_classification');assert.equal(tool.durable,true);assert.equal(tool.timeoutMs,10000);
 for(const key of ['runId','policyId','orderId','organizationId','body','actorUserId'])assert.equal(v.is(tool.input!,{...f.classification,[key]:'forged'}),false);
 assert.deepEqual(await tool.run(context(f.classification)),{output:{status:'committed',canSend:false,sent:false},terminate:true});assert.deepEqual(captured,[original.scope,original.request.runId,f.classification]);
});
test('classification never confirms mismatched receipts or lost acknowledgements, and respects cancellation',async()=>{
 const m=await api(),f=fixture();
 for(const result of [null,{outcome:'accepted'},{...f.result,receipt:{...f.receipt,origin:'system'}},{...f.result,receipt:{...f.receipt,classification:{...f.classification,language:'en'}}},{...f.result,receipt:{...f.receipt,run:{...f.run,request:{...f.run.request,runId:crypto.randomUUID()}}}}]){
  const tool=m.createClassificationTool(f.run,{async recordAiClassification(){return result;}});assert.equal((await tool.run(context(f.classification)) as any).output.status,'unconfirmed');
 }
 const lost=m.createClassificationTool(f.run,{async recordAiClassification(){throw new Error('lost response');}});assert.equal((await lost.run(context(f.classification)) as any).output.status,'unconfirmed');
 const denied=m.createClassificationTool(f.run,{async recordAiClassification(){return {outcome:'conflict'};}});assert.equal((await denied.run(context(f.classification)) as any).output.status,'rejected');
 const aborted=m.createClassificationTool(f.run,{async recordAiClassification(){throw new Error('must not run');}});await assert.rejects(async()=>aborted.run({...context(f.classification),signal:AbortSignal.abort()}));
});
