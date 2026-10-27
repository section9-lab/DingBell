import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fauxProvider,fauxAssistantMessage,fauxText,fauxToolCall,type FauxResponseFactory} from '@earendil-works/pi-ai';
import {init,observe,useModel,useTool,useResponseFinish} from '@flue/runtime';
import {start,sqlite} from '@flue/runtime/node';
import {createHandoffTool} from '../../src/modules/conversations/handoff-tool.ts';
import type {AiRun,AiHandoffToolInput,ControlledAiHandoff} from '../../src/modules/conversations/ai-state.ts';
import type {ControlScope} from '../../src/modules/conversations/control-types.ts';
import {createPolicy,changePolicy} from '../../src/modules/reply-policies/storage.ts';
import {conversationControlFixture} from '../fixtures/conversation-control.ts';

async function fixture(){
 const f=await conversationControlFixture(undefined,{aiEnabled:'true'}),policyId=crypto.randomUUID();
 try{
  await f.db.prepare("UPDATE store SET status='verified' WHERE id='store'").run();
  await f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES('customer-1','org','store','conv','1','Customer','inbound','[\"Мне нужен человек.\"]',0,0,1,1,'incremental')").run();
  const config={kind:'automatic' as const,name:'Support',storeIds:['store'],priority:50,stages:['presale' as const],mode:'automatic' as const,language:'customer' as const,tone:'concise' as const,instructions:''};
  assert.ok(await createPolicy(f.db,f.actor(),policyId,config));assert.ok(await changePolicy(f.db,f.actor(),policyId,1,{action:'test'},crypto.randomUUID()));assert.ok(await changePolicy(f.db,f.actor(),policyId,2,{action:'publish'},crypto.randomUUID()));
  const request={runId:crypto.randomUUID(),expectedVersion:0,messageId:'customer-1',policyId,stage:'presale',language:'ru'};
  const result=await f.call('ai-start',{request});assert.equal(result.body.outcome,'accepted');return {f,run:result.body.receipt.run as AiRun};
 }catch(e){await f.close();throw e;}
}
test('Flue tool execution records actual Cloudflare handoff outcomes without granting customer-send authority',{timeout:90000},async t=>{
 for(const mode of ['success','human-takeover','lost-response','invalid-authority'] as const)await t.test(mode,async()=>{
  const {f,run}=await fixture(),directory=await mkdtemp(join(tmpdir(),'dingbell-handoff-tool-'));
  let runtime:Awaited<ReturnType<typeof start>>|undefined,turns=0,rpcs=0;const results:{isError:boolean;result:unknown}[]=[];
  const input:AiHandoffToolInput={reason:'customer_request',neededInformation:[]};
  const id=`handoff-tool-${run.request.runId}`;
  const unsubscribe=observe(event=>{if(event.type==='tool'&&event.instanceId===id)results.push({isError:event.isError,result:event.result});});
  try{
   const faux=fauxProvider({api:'dingbell-handoff-tool-fixture',provider:'dingbell-handoff-tool-fixture',models:[{id:'model'}]});
   const reply:FauxResponseFactory=()=>{turns++;faux.appendResponses([reply]);return turns===1?fauxAssistantMessage(fauxToolCall('request_handoff',mode==='invalid-authority'?{...input,runId:crypto.randomUUID()}:input),{stopReason:'toolUse'}):fauxAssistantMessage(fauxText('Untrusted model fallback'));};faux.setResponses([reply]);
   const controller={async requestHandoff(scope:ControlScope,runId:string,value:ControlledAiHandoff){rpcs++;const result=await f.call('ai-handoff',{runId,input:value},scope);if(mode==='lost-response')throw new Error('synthetic lost receipt');assert.equal(result.status,200);return result.body;}};
   function HandoffAgent(){useModel('dingbell-handoff-tool-fixture/model',{compaction:false});useTool(createHandoffTool(run,controller));useResponseFinish(({response})=>({toolCalls:response.toolCalls}));return 'Exercise the isolated handoff tool with synthetic input.';}
   HandoffAgent.agentName='HandoffToolFixture';HandoffAgent.durability={maxAttempts:1,timeoutMs:10000};
   const launch=()=>start({agents:[HandoffAgent],db:sqlite(join(directory,'flue.sqlite')),providers:[faux.provider],env:{}});
   runtime=await launch();
   if(mode==='human-takeover')assert.equal((await f.call('execute',{command:{commandId:crypto.randomUUID(),expectedVersion:1,action:'takeover'}})).body.outcome,'accepted');
   const handle=init(HandoffAgent,{id}),submission={message:'Synthetic consumer request',idempotencyKey:run.request.runId},receipt=await handle.dispatch(submission);
   const result=await handle.read(receipt,{signal:AbortSignal.timeout(10000)});
   if(mode==='invalid-authority'){
    assert.equal(rpcs,0);assert.equal(turns,2);assert.equal(results.length,1);assert.equal(results[0]!.isError,true);assert.equal((await f.call('read')).body.view.state.reception,'ai');
   }else{
    assert.equal(rpcs,1);assert.equal(turns,1,'a terminal handoff result must not generate a follow-up customer reply');assert.equal(result.text,'');assert.equal(results.length,1);assert.equal(results[0]!.isError,false);
    const serialized=JSON.stringify(results[0]!.result),status=mode==='success'?'committed':mode==='human-takeover'?'rejected':'unconfirmed';assert.ok(serialized.includes(status),serialized);
    for(const privateValue of [run.request.runId,run.scope.controllerId,run.admission.question])assert.equal(serialized.includes(privateValue),false);
    assert.equal((await f.call('read')).body.view.state.reception,mode==='human-takeover'?'human':'paused');
   }
   const audits=await f.db.prepare("SELECT count(*) n FROM conversation_control_event WHERE action='request_handoff'").first<{n:number}>();assert.equal(audits!.n,mode==='success'||mode==='lost-response'?1:0);
   assert.equal((await f.db.prepare('SELECT count(*) n FROM send_intent').first<{n:number}>())!.n,0);assert.equal(f.providerRequests.length,0);
   if(mode==='success'){
    assert.deepEqual(await handle.dispatch(submission),{...receipt,deduplicated:true});await runtime.stop();runtime=undefined;await f.restart('false');runtime=await launch();
    const restored=init(HandoffAgent,{id});assert.deepEqual(await restored.dispatch(submission),{...receipt,deduplicated:true});assert.deepEqual(await restored.read(receipt,{signal:AbortSignal.timeout(10000)}),result);assert.equal(rpcs,1);assert.equal(turns,1);
   }
  }finally{unsubscribe();await runtime?.stop();await f.close();await rm(directory,{recursive:true,force:true});}
 });
});
