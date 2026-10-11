import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {URL} from 'node:url';
import {conversationControlFixture} from './fixtures/conversation-control.ts';
import {createPolicy,changePolicy} from '../src/modules/reply-policies/storage.ts';
import {ensureControlDirectory} from '../src/modules/conversations/control-storage.ts';
import type {ControlScope,ControlActor} from '../src/modules/conversations/control-types.ts';
import type {AiRun} from '../src/modules/conversations/ai-state.ts';
const config={model:{provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'support-v1',promptVersion:'support-v1',maxInputTokens:100,maxOutputTokens:10,
 pricing:{version:'synthetic',currency:'USD',inputMicrosPerMillion:1000000,outputMicrosPerMillion:1000000,cacheReadMicrosPerMillion:1000000,cacheWriteMicrosPerMillion:1000000}},maxGenerations:3};
const receipt={submissionId:'submission',uid:'incarnation',acceptedAt:new Date().toISOString()};
async function api(){const m=await import('../src/modules/ai-runs/storage.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.reserveAiExecution,'function','production AI needs a separate persistent financial and execution ledger');return m!;}
async function fixture(upTo?:string){
 const f=await conversationControlFixture(upTo,{aiEnabled:'true'}),policyId=crypto.randomUUID(),actor={...f.actor(),expectedMemberId:'owner-member'};
 try{
  await f.db.prepare("UPDATE store SET status='verified' WHERE id='store'").run();
  const policy={kind:'automatic' as const,name:'Support',storeIds:['store'],priority:50,stages:['presale' as const],mode:'automatic' as const,language:'customer' as const,tone:'concise' as const,instructions:''};
  assert.ok(await createPolicy(f.db,actor,policyId,policy));assert.ok(await changePolicy(f.db,actor,policyId,1,{action:'test'},crypto.randomUUID()));assert.ok(await changePolicy(f.db,actor,policyId,2,{action:'publish'},crypto.randomUUID()));
  async function activate(conversationId='conv'){
   const scope=(await ensureControlDirectory(f.db,actor,conversationId,Date.now()))!.scope,messageId=`customer-${conversationId}`;
   await f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES(?,'org','store',?,?,'Customer','inbound','[\"Мне нужен человек.\"]',0,0,1,1,'incremental')").bind(messageId,conversationId,messageId).run();
   const request={runId:crypto.randomUUID(),expectedVersion:0,messageId,policyId,stage:'presale',language:'ru'},result=await f.call('ai-start',{request},scope);assert.equal(result.body.outcome,'accepted');return result.body.receipt.run as AiRun;
  }
  const reader=async(scope:ControlScope,runId:string)=>{const r=await f.call('ai-read',{runId},scope);assert.equal(r.status,200);return r.body as AiRun|null;};
  return {f,actor,activate,reader};
 }catch(e){await f.close();throw e;}
}
async function budget(m:Awaited<ReturnType<typeof api>>,f:Awaited<ReturnType<typeof fixture>>,maxRuns=10,limitMicros=10000){
 const id=crypto.randomUUID(),startsAt=Math.floor(Date.now()/86400000)*86400000;
 const created=await m.changeAiBudget(f.f.db,f.actor,{id,action:'create',startsAt,endsAt:startsAt+86400000,limitMicros,maxRuns});assert.equal(created.outcome,'applied');
 assert.equal((await m.changeAiBudget(f.f.db,f.actor,{id:crypto.randomUUID(),action:'set_enabled',budgetId:id,expectedRevision:0,enabled:true})).outcome,'applied');return id;
}
async function repairApi(){const m=await import('../src/modules/ai-runs/repair.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.claimAiRepairs,'function','historical runs need an independent durable repair cursor before conversation rotation');return m!;}
test('AI repairs claim disjoint bounded batches and stale workers cannot overwrite a later claim',{timeout:30000},async t=>{
 const repair=await repairApi(),m=await api(),f=await fixture();t.after(f.f.close);const id=await budget(m,f);
 for(const conversationId of ['conv','second']){const run=await f.activate(conversationId);await m.reserveAiExecution(f.f.db,f.reader,run.scope,run.request.runId,id,config);}
 const now=Date.now(),batches=await Promise.all([repair.claimAiRepairs(f.f.db,now,1),repair.claimAiRepairs(f.f.db,now,1)]);
 assert.equal(batches[0].length,1);assert.equal(batches[1].length,1);assert.notEqual(batches[0][0].runId,batches[1][0].runId);assert.deepEqual(await repair.claimAiRepairs(f.f.db,now,50),[]);
 const first=batches[0][0];await f.f.db.prepare('UPDATE ai_execution SET repair_due_at=0 WHERE id=?').bind(first.runId).run();const replacement=(await repair.claimAiRepairs(f.f.db,now+1,1))[0];assert.notEqual(replacement.token,first.token);
 await repair.finishAiRepair(f.f.db,first);await repair.finishAiRepair(f.f.db,{...replacement,scope:{...replacement.scope,organizationId:'foreign'}});
 assert.equal(await f.f.db.prepare('SELECT repair_token FROM ai_execution WHERE id=?').bind(first.runId).first('repair_token'),replacement.token);
 await repair.finishAiRepair(f.f.db,replacement);const row=await f.f.db.prepare('SELECT repair_due_at AS due,repair_token AS token FROM ai_execution WHERE id=?').bind(first.runId).first<any>();assert.equal(row.token,null);assert.ok(row.due>now);
 await assert.rejects(()=>repair.claimAiRepairs(f.f.db,now,0));await assert.rejects(()=>repair.claimAiRepairs(f.f.db,now,51));
});
test('repair completion stops settled records but keeps closed unknown usage eligible for later reconciliation',{timeout:30000},async t=>{
 const repair=await repairApi(),m=await api(),f=await fixture();t.after(f.f.close);const id=await budget(m,f),run=await f.activate();
 await m.reserveAiExecution(f.f.db,f.reader,run.scope,run.request.runId,id,config);await m.bindAiExecutionReceipt(f.f.db,run.scope,run.request.runId,receipt);assert.equal(await m.claimAiGeneration(f.f.db,f.reader,run.scope,run.request.runId,1),true);
 await m.closeAiExecution(f.f.db,run.scope,run.request.runId,{kind:'runtime_closed',evidenceId:crypto.randomUUID(),instanceId:`ai-support:${run.request.runId}`,receipt,outcome:'aborted',executionClosed:true,providerPermits:1,verifiedAt:Date.now()});
 const claim=(await repair.claimAiRepairs(f.f.db,Date.now(),50))[0];await repair.finishAiRepair(f.f.db,claim);
 const due=await f.f.db.prepare('SELECT repair_due_at FROM ai_execution WHERE id=?').bind(run.request.runId).first<number>('repair_due_at');assert.ok(due!>Date.now()+240000);
 assert.equal((await m.readAiExecution(f.f.db,run.scope,run.request.runId))!.remainingReservedMicros,110);
 await m.settleAiGeneration(f.f.db,run.scope,run.request.runId,1,receipt,{input:10,output:5,cacheRead:0,cacheWrite:0});await f.f.db.prepare('UPDATE ai_execution SET repair_due_at=0 WHERE id=?').bind(run.request.runId).run();
 await repair.finishAiRepair(f.f.db,(await repair.claimAiRepairs(f.f.db,Date.now(),50))[0]);assert.equal(await f.f.db.prepare('SELECT repair_due_at FROM ai_execution WHERE id=?').bind(run.request.runId).first('repair_due_at'),null);
 assert.deepEqual(await repair.claimAiRepairs(f.f.db,Date.now(),50),[]);
});
test('0034 schedules pre-existing executions while preserving every original column and immutable financial records',{timeout:30000},async t=>{
 await repairApi();const m=await api(),f=await fixture('0033');t.after(f.f.close);const id=await budget(m,f),run=await f.activate();await m.reserveAiExecution(f.f.db,f.reader,run.scope,run.request.runId,id,config);
 const tables=(await f.f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'_cf_METADATA'").all<{name:string}>()).results.map(r=>r.name),columns=new Map<string,string[]>();
 const quote=(x:string)=>'"'+x.replaceAll('"','""')+'"';for(const table of tables)columns.set(table,(await f.f.db.prepare(`PRAGMA table_info(${quote(table)})`).all<{name:string}>()).results.map(c=>c.name));
 const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await f.f.db.prepare(`SELECT ${columns.get(table)!.map(quote).join(',')} FROM ${quote(table)}`).all()).results.map(r=>JSON.stringify(r)).sort()])));
 const before=await snapshot();await f.f.migrateAfter('0033');assert.deepEqual(await snapshot(),before);assert.equal(await f.f.db.prepare('SELECT repair_due_at FROM ai_execution WHERE id=?').bind(run.request.runId).first('repair_due_at'),0);
 assert.deepEqual((await f.f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);await assert.rejects(()=>f.f.db.prepare("UPDATE ai_execution SET payload_hash=? WHERE id=?").bind('a'.repeat(64),run.request.runId).run());
 await assert.rejects(()=>f.f.db.prepare('UPDATE conversation_control_event SET projected_at=projected_at+1').run());
 const guards=(await f.f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'conversation_control_event_%' ORDER BY name").all<{name:string}>()).results.map(r=>r.name);assert.deepEqual(guards,['conversation_control_event_immutable','conversation_control_event_insert_guard']);
});
test('0035 audit upgrade rolls back table replacement on failure and restores the original immutable guards',{timeout:30000},async t=>{
 const f=await fixture('0034');t.after(f.f.close);await f.activate();
 const read=async()=>({events:(await f.f.db.prepare('SELECT * FROM conversation_control_event').all()).results,guards:(await f.f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'conversation_control_event_%' ORDER BY name").all()).results});
 const before=await read(),statements=(await readFile(new URL('../migrations/0035_ai_resume.sql',import.meta.url),'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean),drop=statements.findIndex(s=>s.startsWith('DROP TABLE'));
 assert.ok(drop>0);await assert.rejects(()=>f.f.db.batch([...statements.slice(0,drop+1),'SELECT * FROM synthetic_missing_upgrade_table'].map(s=>f.f.db.prepare(s))));assert.deepEqual(await read(),before);
 await f.f.db.batch(statements.map(s=>f.f.db.prepare(s)));assert.deepEqual(await read(),before);assert.deepEqual((await f.f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
});
test('background AI repair addresses saved execution IDs without consulting the current conversation slot',{timeout:30000},async t=>{
 const repair=await repairApi();assert.equal(typeof repair.repairAiExecutions,'function','Cron must reconcile historical financial plans independently');
 const m=await api(),f=await fixture();t.after(f.f.close);const id=await budget(m,f),ids:string[]=[];
 for(const conversationId of ['conv','second']){const run=await f.activate(conversationId);await m.reserveAiExecution(f.f.db,f.reader,run.scope,run.request.runId,id,config);ids.push(run.request.runId);}
 const env={DB:f.f.db,AI_RECEPTION_ENABLED:'false',FLUE_SUPPORT_AGENT:{},CONVERSATION_CONTROLLER:{get(){throw new Error('current slot must not be consulted');}}} as any,calls:string[]=[];
 await repair.repairAiExecutions(env,{reconcile:async(_env,scope,runId)=>{assert.equal(scope.organizationId,'org');calls.push(runId);throw new Error('synthetic runtime outage');}});
 assert.deepEqual(calls.sort(),ids.sort());assert.equal(await f.f.db.prepare('SELECT count(*) AS n FROM ai_execution WHERE repair_due_at>0 AND repair_token IS NULL').first('n'),2);
 await repair.repairAiExecutions(env,{reconcile:async()=>{throw new Error('not yet due');}});assert.equal(calls.length,2);
 await f.f.db.prepare('UPDATE ai_execution SET repair_due_at=0').run();await repair.repairAiExecutions({...env,FLUE_SUPPORT_AGENT:undefined});assert.equal(await f.f.db.prepare('SELECT count(*) AS n FROM ai_execution WHERE repair_due_at=0').first('n'),2);
});
test('explicit AI resumption replaces only a closed run and preserves old receipts and unknown financial work',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.f.close);const id=await budget(m,f),run=await f.activate();await m.reserveAiExecution(f.f.db,f.reader,run.scope,run.request.runId,id,config);
 await m.bindAiExecutionReceipt(f.f.db,run.scope,run.request.runId,receipt);assert.equal(await m.claimAiGeneration(f.f.db,f.reader,run.scope,run.request.runId,1),true);
 const takeover=await f.f.call('execute',{command:{commandId:crypto.randomUUID(),action:'takeover',expectedVersion:1}});assert.equal(takeover.body.outcome,'accepted');
 const request={...run.request,runId:crypto.randomUUID(),previousRunId:run.request.runId,expectedVersion:2};
 const resume=()=>f.f.call('ai-resume',{request,actor:f.actor});assert.equal((await resume()).body.outcome,'unavailable','a live or unknown original execution cannot be retired');
 await m.closeAiExecution(f.f.db,run.scope,run.request.runId,{kind:'runtime_closed',evidenceId:crypto.randomUUID(),instanceId:`ai-support:${run.request.runId}`,receipt,outcome:'aborted',executionClosed:true,providerPermits:1,verifiedAt:Date.now()});
 const result=await resume();assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.outcome,'accepted');assert.equal(result.body.receipt.action,'ai_resume');assert.equal(result.body.receipt.actorMemberId,'owner-member');assert.equal(result.body.state.reception,'ai');assert.equal(result.body.state.controlEpoch,3);
 assert.equal(await f.reader(run.scope,run.request.runId),null);assert.equal((await f.reader(run.scope,request.runId))!.request.runId,request.runId);assert.deepEqual((await resume()).body.receipt,result.body.receipt);
 assert.deepEqual((await f.f.call('ai-start',{request:run.request})).body.receipt.run,run);assert.equal((await m.readAiExecution(f.f.db,run.scope,run.request.runId))!.remainingReservedMicros,110);
 const pending=await(await repairApi()).claimAiRepairs(f.f.db,Date.now());assert.ok(pending.some(c=>c.runId===run.request.runId));assert.equal((await f.f.call('ai-resume',{request,actor:{...f.actor,expectedMemberId:'replacement'}})).body.outcome,'not_found');
 await f.f.restart('false');assert.deepEqual((await resume()).body.receipt,result.body.receipt);
});
test('future-message resumption retains old held usage and only rotates the run after a new input',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.f.close);const id=await budget(m,f),run=await f.activate();await m.reserveAiExecution(f.f.db,f.reader,run.scope,run.request.runId,id,config);
 await m.bindAiExecutionReceipt(f.f.db,run.scope,run.request.runId,receipt);assert.equal(await m.claimAiGeneration(f.f.db,f.reader,run.scope,run.request.runId,1),true);
 assert.equal((await f.f.call('execute',{command:{commandId:crypto.randomUUID(),action:'takeover',expectedVersion:1}})).body.outcome,'accepted');
 const request={commandId:crypto.randomUUID(),previousRunId:run.request.runId,expectedVersion:2},listen=()=>f.f.call('ai-listen',{request,actor:f.actor});assert.equal((await listen()).body.outcome,'unavailable');
 await m.closeAiExecution(f.f.db,run.scope,run.request.runId,{kind:'runtime_closed',evidenceId:crypto.randomUUID(),instanceId:`ai-support:${run.request.runId}`,receipt,outcome:'aborted',executionClosed:true,providerPermits:1,verifiedAt:Date.now()});
 const listened=await listen();assert.equal(listened.body.outcome,'accepted');assert.equal(await f.reader(run.scope,run.request.runId),null);
 const oldBudget=await m.readAiBudget(f.f.db,f.actor,id);assert.equal(oldBudget!.reservedMicros,110);assert.equal(await f.f.db.prepare('SELECT count(*) n FROM ai_execution').first('n'),1);
 const at=listened.body.receipt.listening.createdAt;
 await f.f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES('next','org','store','conv','next','Customer','inbound','[\"Новый вопрос\"]',0,0,?,?,'incremental')").bind(at,at).run();
 const next={...run.request,runId:crypto.randomUUID(),expectedVersion:3,messageId:'next'},started=await f.f.call('ai-start',{request:next});assert.equal(started.body.outcome,'accepted');assert.equal((await f.reader(run.scope,next.runId))!.request.runId,next.runId);
 assert.deepEqual(await m.readAiBudget(f.f.db,f.actor,id),oldBudget);assert.ok((await(await repairApi()).claimAiRepairs(f.f.db,Date.now())).some(c=>c.runId===run.request.runId));
 assert.equal((await listen()).body.state.version,4);assert.deepEqual((await listen()).body.receipt,listened.body.receipt);
});
test('AI resumption requires current membership, an open human-controlled version, and exactly one winning command',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.f.close);const run=await f.activate();await f.f.call('execute',{command:{commandId:crypto.randomUUID(),action:'takeover',expectedVersion:1}});
 const request={...run.request,runId:crypto.randomUUID(),previousRunId:run.request.runId,expectedVersion:2},resume=(value=request,actor:ControlActor=f.actor)=>f.f.call('ai-resume',{request:value,actor});
 assert.equal((await resume(request,f.f.actor())).body.outcome,'not_found');assert.equal((await resume({...request,previousRunId:crypto.randomUUID()})).body.outcome,'conflict');
 assert.equal((await f.f.call('ai-resume',{request,actor:f.actor},{...run.scope,organizationId:'other-org'})).body.outcome,'not_found');
 assert.equal((await resume({...request,controlEpoch:999} as any)).status,500);assert.equal((await f.f.call('read')).body.view.state.version,2);
 await f.f.call('execute',{command:{commandId:crypto.randomUUID(),action:'resolve',expectedVersion:2}});assert.equal((await resume({...request,expectedVersion:3})).body.outcome,'conflict');
 await f.f.call('execute',{command:{commandId:crypto.randomUUID(),action:'reopen',expectedVersion:3}});
 const requests=[{...request,expectedVersion:4},{...request,expectedVersion:4,runId:crypto.randomUUID()}],results=await Promise.all(requests.map(r=>resume(r)));
 assert.equal(results.filter(r=>r.body.outcome==='accepted').length,1);assert.equal(results.filter(r=>r.body.outcome==='conflict').length,1);
 const index=results.findIndex(r=>r.body.outcome==='accepted'),winner=requests[index];assert.equal((await f.reader(run.scope,winner.runId))!.controlEpoch,5);
 assert.equal((await resume(winner,{...f.f.actor('staff'),expectedMemberId:'staff-member'})).body.outcome,'conflict');
 await f.f.db.prepare("UPDATE session SET expires_at=0 WHERE id='owner-session'").run();assert.equal((await resume(winner)).body.outcome,'not_found');
});
test('AI resumption commits its run, receipt and projection together and replays after projection failure and restart',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.f.close);const run=await f.activate();await f.f.call('execute',{command:{commandId:crypto.randomUUID(),action:'takeover',expectedVersion:1}});
 const request={...run.request,runId:crypto.randomUUID(),previousRunId:run.request.runId,expectedVersion:2},resume=()=>f.f.call('ai-resume',{request,actor:f.actor});
 await f.f.call('faults',{value:{commit:true}});assert.equal((await resume()).status,500);assert.equal((await f.f.call('read')).body.view.state.version,2);assert.equal(await f.reader(run.scope,request.runId),null);
 await f.f.call('faults',{value:{project:true}});const result=await resume();assert.equal(result.body.outcome,'accepted');assert.equal((await f.f.call('read')).body.view.state.version,3);assert.equal(await f.f.db.prepare("SELECT version FROM conversation_control WHERE conversation_id='conv'").first('version'),2);
 await f.f.restart('false');await f.f.call('faults',{value:{}});await f.f.call('repair');assert.deepEqual((await resume()).body.receipt,result.body.receipt);
 const row=await f.f.db.prepare("SELECT actor_member_id AS actor,receipt FROM conversation_control_event WHERE action='ai_resume'").first<any>();assert.equal(row.actor,'owner-member');assert.deepEqual(JSON.parse(row.receipt),result.body.receipt);
});
test('a historical handoff remains readable after resumption without handing the new run off again',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.f.close);const run=await f.activate(),input={reason:'customer_request',summary:'Клиент просит человека.',neededInformation:[]};
 const handoff=()=>f.f.call('ai-handoff',{runId:run.request.runId,input}),original=await handoff();assert.equal(original.body.outcome,'accepted');
 const request={...run.request,runId:crypto.randomUUID(),previousRunId:run.request.runId,expectedVersion:2};assert.equal((await f.f.call('ai-resume',{request,actor:f.actor})).body.outcome,'accepted');
 const replay=await handoff();assert.equal(replay.body.outcome,'accepted');assert.deepEqual(replay.body.receipt,original.body.receipt);assert.equal(replay.body.state.reception,'ai');assert.equal(replay.body.state.version,3);
 assert.equal((await f.f.call('ai-handoff',{runId:run.request.runId,input:{...input,summary:'Changed'}})).body.outcome,'conflict');assert.equal(await f.f.db.prepare('SELECT count(*) AS n FROM conversation_control_event').first('n'),3);
 await f.f.restart('false');assert.deepEqual((await handoff()).body.receipt,original.body.receipt);
});
test('production budgets require current administrators, start disabled and audit each version atomically',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.f.close);const startsAt=Math.floor(Date.now()/86400000)*86400000;
 const command={id:crypto.randomUUID(),action:'create',startsAt,endsAt:startsAt+86400000,limitMicros:1000,maxRuns:2};
 assert.equal((await m.changeAiBudget(f.f.db,{...f.f.actor('staff'),expectedMemberId:'staff-member'},command)).outcome,'not_found');
 const created=await m.changeAiBudget(f.f.db,f.actor,command);assert.equal(created.outcome,'applied');assert.equal(created.budget!.enabled,false);
 assert.equal((await m.changeAiBudget(f.f.db,f.actor,command)).outcome,'existing');assert.equal((await m.changeAiBudget(f.f.db,f.actor,{...command,id:crypto.randomUUID()})).outcome,'overlap');
 const enable={id:crypto.randomUUID(),action:'set_enabled',budgetId:command.id,expectedRevision:0,enabled:true};
 await f.f.db.prepare("CREATE TRIGGER fail_ai_audit BEFORE INSERT ON ai_budget_audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END").run();
 await assert.rejects(()=>m.changeAiBudget(f.f.db,f.actor,enable));assert.equal((await m.readAiBudget(f.f.db,f.actor,command.id))!.enabled,false);await f.f.db.prepare('DROP TRIGGER fail_ai_audit').run();
 assert.equal((await m.changeAiBudget(f.f.db,f.actor,enable)).outcome,'applied');
 assert.equal((await m.changeAiBudget(f.f.db,f.actor,{...enable,id:crypto.randomUUID(),expectedRevision:1,enabled:false})).outcome,'applied');
 assert.equal((await m.changeAiBudget(f.f.db,f.actor,enable)).budget!.enabled,false,'old enable receipt cannot turn the budget back on');
 assert.equal(await m.readAiBudget(f.f.db,{...f.actor,orgId:'other-org'},command.id),null);
 await f.f.db.prepare("UPDATE member SET role='owner' WHERE id='staff-member'").run();await f.f.db.prepare("UPDATE member SET role='member' WHERE id='owner-member'").run();assert.equal((await m.changeAiBudget(f.f.db,f.actor,enable)).outcome,'not_found');
});
test('concurrent AI admission cannot spend the last run twice and identical replay keeps the original frozen plan',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.f.close);const id=await budget(m,f,1,330),runs=await Promise.all([f.activate(),f.activate('second')]);
 const reserve=(run:AiRun,c=config)=>m.reserveAiExecution(f.f.db,f.reader,run.scope,run.request.runId,id,c);
 const results=await Promise.all(runs.flatMap(run=>[reserve(run),reserve(run)]));assert.equal(results.filter(r=>r.outcome==='reserved').length,1);
 const winning=results.find(r=>r.outcome==='reserved')!.run!,run=runs.find(r=>r.request.runId===winning.id)!;
 assert.equal((await reserve(run)).outcome,'existing');assert.equal((await reserve(run,{...config,maxGenerations:2})).outcome,'conflict');
 assert.equal(winning.reservedMicros,330);assert.equal(winning.instanceId,`ai-support:${run.request.runId}`);assert.equal(winning.dispatchKey,run.request.runId);
 const model=JSON.stringify(winning.modelInput);assert.equal(model.includes(run.request.runId),false);assert.equal(model.includes(run.scope.controllerId),false);
 const funds=await m.readAiBudget(f.f.db,f.actor,id);assert.equal(funds!.reservedMicros,330);assert.equal(funds!.admittedRuns,1);
 await assert.rejects(()=>f.f.db.prepare("UPDATE ai_execution SET payload='{}' WHERE id=?").bind(winning.id).run());
});
test('failed run insertion rolls back the budget; current controller and policy are required for financial admission',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.f.close);const id=await budget(m,f),run=await f.activate();
 const reserve=()=>m.reserveAiExecution(f.f.db,f.reader,run.scope,run.request.runId,id,config);
 await f.f.db.prepare("CREATE TRIGGER fail_ai_run BEFORE INSERT ON ai_execution BEGIN SELECT RAISE(ABORT,'synthetic run failure'); END").run();await assert.rejects(reserve);
 assert.equal((await m.readAiBudget(f.f.db,f.actor,id))!.admittedRuns,0);await f.f.db.prepare('DROP TRIGGER fail_ai_run').run();
 assert.equal((await m.reserveAiExecution(f.f.db,f.reader,{...run.scope,organizationId:'foreign'},run.request.runId,id,config)).outcome,'unavailable');
 await f.f.call('execute',{command:{commandId:crypto.randomUUID(),action:'takeover',expectedVersion:1}});assert.equal((await reserve()).outcome,'unavailable');assert.equal((await m.readAiBudget(f.f.db,f.actor,id))!.reservedMicros,0);
});
test('generation permits and settlements are unique; closing releases only unused slots and late usage settles held unknown requests',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.f.close);const id=await budget(m,f),run=await f.activate();
 assert.equal((await m.reserveAiExecution(f.f.db,f.reader,run.scope,run.request.runId,id,config)).outcome,'reserved');await m.bindAiExecutionReceipt(f.f.db,run.scope,run.request.runId,receipt);
 const claim=(n:number)=>m.claimAiGeneration(f.f.db,f.reader,run.scope,run.request.runId,n),settle=(n:number,usage={input:10,output:5,cacheRead:0,cacheWrite:0})=>m.settleAiGeneration(f.f.db,run.scope,run.request.runId,n,receipt,usage);
 assert.equal((await Promise.all([claim(1),claim(1),claim(1)])).filter(Boolean).length,1);assert.equal(await claim(2),false,'an unknown previous provider call blocks another generation');
 await settle(1);await settle(1);await assert.rejects(()=>settle(1,{input:11,output:5,cacheRead:0,cacheWrite:0}));
 assert.equal((await m.readAiBudget(f.f.db,f.actor,id))!.reservedMicros,220);assert.equal((await m.readAiBudget(f.f.db,f.actor,id))!.spentMicros,15);
 assert.equal(await claim(2),true);assert.equal(await claim(4),false);
 const proof={kind:'runtime_closed',evidenceId:crypto.randomUUID(),instanceId:`ai-support:${run.request.runId}`,receipt,outcome:'aborted',executionClosed:true,providerPermits:2,verifiedAt:Date.now()};
 await m.closeAiExecution(f.f.db,run.scope,run.request.runId,proof);await m.closeAiExecution(f.f.db,run.scope,run.request.runId,proof);
 const closed=(await m.readAiExecution(f.f.db,run.scope,run.request.runId))!;assert.equal(closed.status,'unconfirmed');assert.equal(closed.remainingReservedMicros,110);assert.equal(await claim(3),false);
 await settle(2,{input:4,output:3,cacheRead:0,cacheWrite:0});assert.equal((await m.readAiExecution(f.f.db,run.scope,run.request.runId))!.status,'settled');
 const funds=(await m.readAiBudget(f.f.db,f.actor,id))!;assert.equal(funds.reservedMicros,0);assert.equal(funds.spentMicros,22);assert.equal(funds.admittedRuns,1);
 await assert.rejects(()=>m.bindAiExecutionReceipt(f.f.db,run.scope,run.request.runId,{...receipt,uid:'replacement'}));
});
test('zero-price requests still consume run quota and unknown calls cannot be released as never started',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.f.close);const id=await budget(m,f,1,0),run=await f.activate(),free={...config,model:{...config.model,pricing:{...config.model.pricing,inputMicrosPerMillion:0,outputMicrosPerMillion:0,cacheReadMicrosPerMillion:0,cacheWriteMicrosPerMillion:0}}};
 assert.equal((await m.reserveAiExecution(f.f.db,f.reader,run.scope,run.request.runId,id,free)).outcome,'reserved');assert.equal(await m.claimAiGeneration(f.f.db,f.reader,run.scope,run.request.runId,1),true);
 await assert.rejects(()=>m.closeAiExecution(f.f.db,run.scope,run.request.runId,{kind:'unstarted_closed',evidenceId:crypto.randomUUID(),instanceId:`ai-support:${run.request.runId}`,executionClosed:true,providerPermits:0,verifiedAt:Date.now()}));
 assert.equal((await m.readAiExecution(f.f.db,run.scope,run.request.runId))!.status,'open');assert.equal((await m.readAiBudget(f.f.db,f.actor,id))!.admittedRuns,1);
});
test('final financial SQL refuses a policy disabled after the controller read and a paused budget',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.f.close);const id=await budget(m,f),run=await f.activate();
 assert.equal((await m.reserveAiExecution(f.f.db,f.reader,run.scope,run.request.runId,id,config)).outcome,'reserved');
 assert.equal((await m.changeAiBudget(f.f.db,f.actor,{id:crypto.randomUUID(),action:'set_enabled',budgetId:id,expectedRevision:1,enabled:false})).outcome,'applied');
 assert.equal(await m.claimAiGeneration(f.f.db,f.reader,run.scope,run.request.runId,1),false);
 assert.equal((await m.changeAiBudget(f.f.db,f.actor,{id:crypto.randomUUID(),action:'set_enabled',budgetId:id,expectedRevision:2,enabled:true})).outcome,'applied');
 const raced=async(scope:ControlScope,runId:string)=>{const current=await f.reader(scope,runId);assert.ok(current);await changePolicy(f.f.db,f.actor,run.request.policyId,3,{action:'pause'},crypto.randomUUID());return current;};
 assert.equal(await m.claimAiGeneration(f.f.db,raced,run.scope,run.request.runId,1),false);assert.equal((await m.readAiExecution(f.f.db,run.scope,run.request.runId))!.generations.length,0);
});
test('known cost overruns are recorded honestly and block additional generations and new runs',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.f.close);const id=await budget(m,f,10,330),run=await f.activate();
 assert.equal((await m.reserveAiExecution(f.f.db,f.reader,run.scope,run.request.runId,id,config)).outcome,'reserved');await m.bindAiExecutionReceipt(f.f.db,run.scope,run.request.runId,receipt);
 assert.equal(await m.claimAiGeneration(f.f.db,f.reader,run.scope,run.request.runId,1),true);await m.settleAiGeneration(f.f.db,run.scope,run.request.runId,1,receipt,{input:400,output:0,cacheRead:0,cacheWrite:0});
 assert.equal((await m.readAiBudget(f.f.db,f.actor,id))!.spentMicros,400);assert.equal(await m.claimAiGeneration(f.f.db,f.reader,run.scope,run.request.runId,2),false);
 const other=await f.activate('second');assert.equal((await m.reserveAiExecution(f.f.db,f.reader,other.scope,other.request.runId,id,config)).outcome,'budget_unavailable');
});
test('settlement and closure failures roll back financial changes and concurrent identical usage charges once',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.f.close);const id=await budget(m,f),run=await f.activate();
 await m.reserveAiExecution(f.f.db,f.reader,run.scope,run.request.runId,id,config);await m.bindAiExecutionReceipt(f.f.db,run.scope,run.request.runId,receipt);assert.equal(await m.claimAiGeneration(f.f.db,f.reader,run.scope,run.request.runId,1),true);
 const settle=()=>m.settleAiGeneration(f.f.db,run.scope,run.request.runId,1,receipt,{input:10,output:5,cacheRead:0,cacheWrite:0});
 await f.f.db.prepare("CREATE TRIGGER fail_ai_usage BEFORE UPDATE ON ai_generation WHEN NEW.usage IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic settlement failure'); END").run();await assert.rejects(settle);
 assert.equal((await m.readAiBudget(f.f.db,f.actor,id))!.spentMicros,0);assert.equal((await m.readAiBudget(f.f.db,f.actor,id))!.reservedMicros,330);await f.f.db.prepare('DROP TRIGGER fail_ai_usage').run();
 await Promise.all([settle(),settle(),settle()]);assert.equal((await m.readAiBudget(f.f.db,f.actor,id))!.spentMicros,15);
 const proof={kind:'runtime_closed',evidenceId:crypto.randomUUID(),instanceId:`ai-support:${run.request.runId}`,receipt,outcome:'completed',executionClosed:true,providerPermits:1,verifiedAt:Date.now()};
 await f.f.db.prepare("CREATE TRIGGER fail_ai_close BEFORE UPDATE ON ai_execution WHEN NEW.closure IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic closure failure'); END").run();await assert.rejects(()=>m.closeAiExecution(f.f.db,run.scope,run.request.runId,proof));
 assert.equal((await m.readAiBudget(f.f.db,f.actor,id))!.reservedMicros,220);assert.equal((await m.readAiExecution(f.f.db,run.scope,run.request.runId))!.closure,null);await f.f.db.prepare('DROP TRIGGER fail_ai_close').run();
 await m.closeAiExecution(f.f.db,run.scope,run.request.runId,proof);assert.equal((await m.readAiBudget(f.f.db,f.actor,id))!.reservedMicros,0);
 await assert.rejects(()=>m.closeAiExecution(f.f.db,run.scope,run.request.runId,{...proof,outcome:'failed'}));
});
test('missing prices cannot reserve funds and a closed unstarted execution releases only money, never run quota',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.f.close);const id=await budget(m,f),run=await f.activate();
 assert.equal((await m.reserveAiExecution(f.f.db,f.reader,run.scope,run.request.runId,id,{...config,model:{...config.model,pricing:null}})).outcome,'pricing_unavailable');
 assert.equal((await m.readAiBudget(f.f.db,f.actor,id))!.admittedRuns,0);await m.reserveAiExecution(f.f.db,f.reader,run.scope,run.request.runId,id,config);
 const proof={kind:'unstarted_closed',evidenceId:crypto.randomUUID(),instanceId:`ai-support:${run.request.runId}`,executionClosed:true,providerPermits:0,verifiedAt:Date.now()};
 await m.closeAiExecution(f.f.db,run.scope,run.request.runId,proof);await m.closeAiExecution(f.f.db,run.scope,run.request.runId,proof);assert.equal(await m.claimAiGeneration(f.f.db,f.reader,run.scope,run.request.runId,1),false);
 const funds=(await m.readAiBudget(f.f.db,f.actor,id))!;assert.equal(funds.reservedMicros,0);assert.equal(funds.admittedRuns,1);assert.equal((await m.reserveAiExecution(f.f.db,f.reader,run.scope,run.request.runId,id,config)).outcome,'existing');
 await assert.rejects(()=>m.bindAiExecutionReceipt(f.f.db,run.scope,run.request.runId,receipt));
});
test('a downstream reader cannot mutate the captured financial scope',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.f.close);const id=await budget(m,f),run=await f.activate(),scope={...run.scope};
 const reader=async(target:ControlScope,runId:string)=>{const result=await f.reader(target,runId);target.organizationId='foreign';return result;};
 assert.equal((await m.reserveAiExecution(f.f.db,reader,scope,run.request.runId,id,config)).outcome,'reserved');assert.deepEqual(scope,run.scope);
 assert.equal(await m.claimAiGeneration(f.f.db,reader,scope,run.request.runId,1),true);assert.deepEqual(scope,run.scope);
});
test('execution inserts cannot bind one run payload to another financial identity',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.f.close);const id=await budget(m,f),run=await f.activate();await m.reserveAiExecution(f.f.db,f.reader,run.scope,run.request.runId,id,config);
 await assert.rejects(()=>f.f.db.prepare(`INSERT INTO ai_execution(id,organization_id,store_id,conversation_id,controller_id,budget_id,payload,payload_hash,config,per_generation_micros,reserved_micros,max_generations,created_at)
  SELECT ?,organization_id,store_id,conversation_id,controller_id,budget_id,payload,payload_hash,config,per_generation_micros,reserved_micros,max_generations,created_at FROM ai_execution WHERE id=?`).bind(crypto.randomUUID(),run.request.runId).run());
});
test('the native agent target and dispatch key are frozen in the persisted plan before dispatch',{timeout:30000},async t=>{
 const m=await api(),f=await fixture();t.after(f.f.close);const id=await budget(m,f),run=await f.activate();
 const result=await m.reserveAiExecution(f.f.db,f.reader,run.scope,run.request.runId,id,config);assert.equal(result.outcome,'reserved');
 const row=await f.f.db.prepare('SELECT payload FROM ai_execution WHERE id=?').bind(run.request.runId).first<{payload:string}>();
 assert.deepEqual(JSON.parse(row!.payload).target,{agent:'Support',instanceId:`ai-support:${run.request.runId}`,dispatchKey:run.request.runId});
 await f.f.restart('false');const restored=await m.readAiExecution(f.f.db,run.scope,run.request.runId);assert.equal(restored!.agent,'Support');assert.equal(restored!.instanceId,result.run!.instanceId);assert.equal(restored!.dispatchKey,result.run!.dispatchKey);
});
