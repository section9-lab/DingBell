import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {URL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {conversationControlFixture} from './fixtures/conversation-control.ts';
import {createPolicy,changePolicy} from '../src/modules/reply-policies/storage.ts';
import {changeAiBudget,reserveAiExecution,readAiExecution,bindAiExecutionReceipt,claimAiGeneration,settleAiGeneration,closeAiExecution} from '../src/modules/ai-runs/storage.ts';
const intakeConfig={maxGenerations:1,model:{provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'support-v1',promptVersion:'intake-v1',maxInputTokens:100,maxOutputTokens:100,
 pricing:{version:'synthetic',currency:'USD',inputMicrosPerMillion:1000000,outputMicrosPerMillion:1000000,cacheReadMicrosPerMillion:1000000,cacheWriteMicrosPerMillion:1000000}}};
async function fixture(through?:string,aiTimeoutMs=60000){
 const f=await conversationControlFixture(through,{aiEnabled:'true',aiTimeoutMs}),policyId=crypto.randomUUID();
 try{
  await f.db.prepare("UPDATE store SET status='verified' WHERE id='store'").run();
  const config={kind:'automatic' as const,name:'All stages',storeIds:['store'],priority:50,stages:['presale' as const,'order' as const,'aftersale' as const],mode:'automatic' as const,language:'customer' as const,tone:'concise' as const,instructions:'merchant data'};
  assert.ok(await createPolicy(f.db,f.actor(),policyId,config));assert.ok(await changePolicy(f.db,f.actor(),policyId,1,{action:'test'},crypto.randomUUID()));assert.ok(await changePolicy(f.db,f.actor(),policyId,2,{action:'publish'},crypto.randomUUID()));
  const append=async()=>{
   const id=crypto.randomUUID(),now=Date.now();await f.db.batch([
    f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES(?,'org','store','conv',?,'Customer','inbound','[\"Когда приедет заказ?\"]',0,0,?,?,'incremental')").bind(id,id,now,now),
    f.db.prepare("INSERT INTO ingest_event(id,organization_id,store_id,conversation_id,message_id,state,live_observed_at,trace_id,created_at) VALUES(?,'org','store','conv',?,'pending',?,'synthetic',?)").bind(id,id,now,now),
   ]);return id;
  };
  const messageId=await append(),request={runId:crypto.randomUUID(),expectedVersion:0,messageId},classification={stage:'order',language:'ru',customerRequestedHuman:false};
  return {...f,get db(){return f.db;},policyId,config,append,request,classification,start:(input:unknown=request)=>f.call('ai-intake-start',{request:input}),classify:(input:unknown=classification)=>f.call('ai-classify',{runId:request.runId,classification:input})};
 }catch(e){await f.close();throw e;}
}
test('intake admits only committed input and freezes candidate policy versions without inventing a stage',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const result=await f.start();assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.outcome,'accepted');const run=result.body.receipt.run;
 assert.equal(run.kind,'intake');assert.equal(run.admission.question,'Когда приедет заказ?');assert.equal(run.admission.candidates.length,3);assert.equal(run.admission.stage,undefined);assert.equal(run.admission.language,undefined);
 assert.equal((await f.call('ai-read',{runId:f.request.runId})).body,null);assert.deepEqual((await f.call('ai-work-read',{runId:f.request.runId})).body,run);
 await f.restart();assert.deepEqual((await f.start()).body.receipt,result.body.receipt);assert.equal(f.providerRequests.length,0);
});
test('an answer cannot silently adopt a policy version published after classification',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);assert.equal((await f.start()).body.outcome,'accepted');assert.equal((await f.classify()).body.outcome,'accepted');const next=(await f.call('ai-classified-input')).body;
 assert.ok(await changePolicy(f.db,f.actor(),f.policyId,3,{action:'draft',config:{...f.config,instructions:'updated merchant data'}},crypto.randomUUID()));
 assert.ok(await changePolicy(f.db,f.actor(),f.policyId,4,{action:'test'},crypto.randomUUID()));assert.ok(await changePolicy(f.db,f.actor(),f.policyId,5,{action:'publish'},crypto.randomUUID()));
 assert.equal((await f.call('ai-start',{request:next.request})).body.outcome,'unavailable');assert.equal(await f.db.prepare('SELECT count(*) n FROM ai_execution').first('n'),0);
});
test('a historical intake identity cannot be reused for an explicitly resumed answer',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);assert.equal((await f.start()).body.outcome,'accepted');assert.equal((await f.classify({...f.classification,customerRequestedHuman:true})).body.outcome,'accepted');
 const actor={...f.actor(),expectedMemberId:'owner-member'},request={...f.request,runId:crypto.randomUUID(),expectedVersion:2,previousRunId:f.request.runId,policyId:f.policyId,stage:'order',language:'ru'};
 assert.equal((await f.call('ai-resume',{actor,request})).body.outcome,'accepted');
 assert.equal((await f.call('execute',{command:{commandId:crypto.randomUUID(),expectedVersion:3,action:'takeover'}})).body.outcome,'accepted');
 assert.equal((await f.call('ai-resume',{actor,request:{...request,expectedVersion:4,previousRunId:request.runId,runId:f.request.runId}})).body.outcome,'conflict');
});
test('classification timeout enters the human queue and projection retries retain one receipt',{timeout:30000},async t=>{
 const f=await fixture(undefined,100);t.after(f.close);assert.equal((await f.start()).body.outcome,'accepted');await f.call('faults',{value:{project:true}});await delay(150);await f.call('repair');
 await f.call('faults',{value:{}});await f.restart();await f.call('repair');const r=await f.call('read');assert.equal(r.body.view.state.reception,'paused');assert.equal(r.body.view.state.workStatus,'needs_reply');
 const rows=(await f.db.prepare("SELECT receipt FROM conversation_control_event WHERE action='ai_classification'").all<{receipt:string}>()).results;assert.equal(rows.length,1);const receipt=JSON.parse(rows[0].receipt);assert.equal(receipt.origin,'system');assert.equal(receipt.classification,null);assert.equal(receipt.decision.reason,'timeout');assert.equal((await f.classify()).body.outcome,'conflict');
});
test('0039 preserves old financial and audit records, rolls back failure and keeps immutable guards',{timeout:30000},async t=>{
 const f=await fixture('0038');t.after(f.close);const request={...f.request,policyId:f.policyId,stage:'order',language:'ru'};assert.equal((await f.call('ai-start',{request})).body.outcome,'accepted');
 const budgetId=await budget(f),config={...intakeConfig,maxGenerations:2,model:{...intakeConfig.model,promptVersion:'support-v1'}},read=async(scope:any,id:string)=>(await f.call('ai-work-read',{runId:id},scope)).body;
 assert.equal((await reserveAiExecution(f.db,read,f.scope,request.runId,budgetId,config)).outcome,'reserved');
 const snapshot=async()=>({events:(await f.db.prepare('SELECT * FROM conversation_control_event').all()).results,run:await readAiExecution(f.db,f.scope,request.runId)}),before=await snapshot();
 const statements=(await readFile(new URL('../migrations/0039_ai_intake.sql',import.meta.url),'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);
 const guards=(await f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all()).results;
 await assert.rejects(()=>f.db.batch([...statements.map(s=>f.db.prepare(s)),f.db.prepare('SELECT * FROM missing_intake_upgrade_table')]));assert.deepEqual(await snapshot(),before);assert.deepEqual((await f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all()).results,guards);
 await f.db.batch(statements.map(s=>f.db.prepare(s)));assert.deepEqual(await snapshot(),before);assert.equal((await f.db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
 await assert.rejects(()=>f.db.prepare("UPDATE conversation_control_event SET receipt='{}'").run(),/IMMUTABLE/);await assert.rejects(()=>f.db.prepare("UPDATE ai_execution SET payload='{}'").run());
});
test('classification selects the server policy and persists a bound next-run identity without starting it',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);assert.equal((await f.start()).body.outcome,'accepted');
 const results=await Promise.all(Array.from({length:3},()=>f.classify()));assert.ok(results.every(r=>r.body.outcome==='accepted'));const first=results[0].body;
 assert.equal(first.receipt.decision.kind,'ready');assert.equal(first.receipt.decision.policyId,f.policyId);assert.equal(first.state.version,2);assert.equal(first.state.reception,'ai');assert.equal((await f.call('ai-work-read',{runId:f.request.runId})).body,null);
 const next=(await f.call('ai-classified-input')).body;assert.equal(next.request.stage,'order');assert.equal(next.request.language,'ru');assert.equal(next.request.policyId,f.policyId);assert.equal(next.request.expectedVersion,2);assert.notEqual(next.request.runId,f.request.runId);
 await f.restart();assert.deepEqual((await f.call('ai-classified-input')).body,next);assert.equal(await f.db.prepare('SELECT count(*) n FROM ai_execution').first('n'),0);
 assert.equal((await f.call('ai-start',{request:{...next.request,stage:'presale'}})).body.outcome,'conflict');assert.equal((await f.call('ai-start',{request:next.request})).body.outcome,'accepted');assert.equal((await f.call('ai-classified-input')).body,null);
});
test('unknown classification and explicit requests for a person enter the human queue; historical replies cannot restore authority',{timeout:30000},async t=>{
 for(const input of [{stage:'unknown',language:'ru',customerRequestedHuman:false},{stage:'order',language:'unknown',customerRequestedHuman:false},{stage:'order',language:'ru',customerRequestedHuman:true}]){
  const f=await fixture();try{assert.equal((await f.start()).body.outcome,'accepted');const r=await f.classify(input);assert.equal(r.body.outcome,'accepted');assert.equal(r.body.receipt.decision.kind,'handoff');assert.equal(r.body.state.reception,'paused');assert.equal(r.body.state.workStatus,'needs_reply');assert.equal((await f.call('ai-classified-input')).body,null);
   const claimed=await f.call('execute',{command:{commandId:crypto.randomUUID(),expectedVersion:2,action:'claim'}});assert.equal(claimed.body.outcome,'accepted');const replay=await f.classify(input);assert.deepEqual(replay.body.receipt,r.body.receipt);assert.equal(replay.body.state.reception,'human');assert.equal(replay.body.state.version,3);
  }finally{await f.close();}
 }
});
test('new input and human takeover revoke classification; forged model authority and non-live input are refused',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);assert.equal((await f.start({...f.request,stage:'presale'})).status,500);await f.db.prepare('UPDATE ingest_event SET live_observed_at=NULL').run();assert.equal((await f.start()).body.outcome,'unavailable');await f.db.prepare('UPDATE ingest_event SET live_observed_at=created_at').run();assert.equal((await f.start()).body.outcome,'accepted');
 assert.equal((await f.classify({...f.classification,policyId:f.policyId})).status,500);const id=await f.append();assert.equal((await f.call('inbound',{eventId:id})).body.outcome,'accepted');assert.equal((await f.call('ai-work-read',{runId:f.request.runId})).body,null);assert.notEqual((await f.classify()).body.outcome,'accepted');
 assert.equal((await f.call('execute',{command:{commandId:crypto.randomUUID(),expectedVersion:2,action:'takeover'}})).body.outcome,'accepted');assert.equal((await f.start({...f.request,runId:crypto.randomUUID(),expectedVersion:3,messageId:id})).body.outcome,'conflict');
});
async function budget(f:Awaited<ReturnType<typeof fixture>>){
 const actor={...f.actor(),expectedMemberId:'owner-member'},id=crypto.randomUUID(),startsAt=Math.floor(Date.now()/86400000)*86400000;
 assert.equal((await changeAiBudget(f.db,actor,{id,action:'create',startsAt,endsAt:startsAt+86400000,limitMicros:1000000,maxRuns:5})).outcome,'applied');assert.equal((await changeAiBudget(f.db,actor,{id:crypto.randomUUID(),action:'set_enabled',budgetId:id,expectedRevision:0,enabled:true})).outcome,'applied');return id;
}
test('classification reuses the production financial ledger and closes before the answer run can start',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);assert.equal((await f.start()).body.outcome,'accepted');const budgetId=await budget(f),read=async(scope:any,id:string)=>(await f.call('ai-work-read',{runId:id},scope)).body;
 const reserved=await reserveAiExecution(f.db,read,f.scope,f.request.runId,budgetId,intakeConfig);assert.equal(reserved.outcome,'reserved');assert.equal(reserved.run!.config.maxGenerations,1);assert.equal((reserved.run!.modelInput as any).task,'classify');assert.equal(await f.db.prepare('SELECT admitted_runs FROM ai_budget WHERE id=?').bind(budgetId).first('admitted_runs'),1);
 const receipt={submissionId:'synthetic',uid:'synthetic-intake',acceptedAt:new Date().toISOString()};await bindAiExecutionReceipt(f.db,f.scope,f.request.runId,receipt);assert.equal(await claimAiGeneration(f.db,read,f.scope,f.request.runId,1),true);assert.equal(await claimAiGeneration(f.db,read,f.scope,f.request.runId,2),false);
 assert.equal((await f.classify()).body.outcome,'accepted');const next=(await f.call('ai-classified-input')).body;assert.equal((await f.call('ai-start',{request:next.request})).body.outcome,'unavailable');
 await settleAiGeneration(f.db,f.scope,f.request.runId,1,receipt,{input:1,output:1,cacheRead:0,cacheWrite:0});await closeAiExecution(f.db,f.scope,f.request.runId,{kind:'runtime_closed',providerPermits:1,receipt,outcome:'completed',evidenceId:crypto.randomUUID(),instanceId:`ai-support:${f.request.runId}`,executionClosed:true,verifiedAt:Date.now()});
 assert.equal((await f.call('ai-start',{request:next.request})).body.outcome,'accepted');const supportConfig={...intakeConfig,maxGenerations:2,model:{...intakeConfig.model,promptVersion:'support-v1'}};
 assert.equal((await reserveAiExecution(f.db,read,f.scope,next.request.runId,budgetId,supportConfig)).outcome,'reserved');assert.equal(await f.db.prepare('SELECT admitted_runs FROM ai_budget WHERE id=?').bind(budgetId).first('admitted_runs'),2);
});
test('intake cannot use an answer prompt or multiple generations, and a disabled candidate cannot grant financial admission',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const started=await f.start(),run=started.body.receipt.run,budgetId=await budget(f),read=async()=>run;
 for(const config of [{...intakeConfig,maxGenerations:2},{...intakeConfig,model:{...intakeConfig.model,promptVersion:'support-v1'}}])assert.equal((await reserveAiExecution(f.db,read,f.scope,f.request.runId,budgetId,config)).outcome,'pricing_unavailable');
 await f.db.prepare('UPDATE reply_policy SET enabled=0 WHERE id=?').bind(f.policyId).run();assert.equal((await reserveAiExecution(f.db,read,f.scope,f.request.runId,budgetId,intakeConfig)).outcome,'budget_unavailable');assert.equal(await f.db.prepare('SELECT admitted_runs FROM ai_budget WHERE id=?').bind(budgetId).first('admitted_runs'),0);
});
