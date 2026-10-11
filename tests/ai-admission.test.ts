import assert from 'node:assert/strict';
import {test} from 'node:test';
import {conversationControlFixture} from './fixtures/conversation-control.ts';
import {createPolicy,changePolicy} from '../src/modules/reply-policies/storage.ts';
import {changeAiBudget,readAiExecution} from '../src/modules/ai-runs/storage.ts';
import {executeAiRun,type SupportRuntime} from '../src/modules/ai-runs/execution.ts';
const config={maxGenerations:2,model:{provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'support-v1',promptVersion:'support-v1',maxInputTokens:262144,maxOutputTokens:2048,
 pricing:{version:'synthetic',currency:'USD',inputMicrosPerMillion:1000000,outputMicrosPerMillion:1000000,cacheReadMicrosPerMillion:1000000,cacheWriteMicrosPerMillion:1000000}}};
async function fixture(){
 const f=await conversationControlFixture(undefined,{aiEnabled:'true'}),actor={...f.actor(),expectedMemberId:'owner-member'};
 try{
  await f.db.prepare("UPDATE store SET status='verified' WHERE id='store'").run();
  await f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES('question','org','store','conv','1','Customer','inbound','[\"Мне нужен человек.\"]',0,0,1,1,'incremental')").run();
  const policy=async(priority=50,mode:'suggest'|'automatic'='automatic',stages:('presale'|'order'|'aftersale')[]=['presale'])=>{
   const id=crypto.randomUUID(),value={kind:'automatic' as const,name:'Support',storeIds:['store'],priority,stages,mode,language:'customer' as const,tone:'concise' as const,instructions:''};
   assert.ok(await createPolicy(f.db,actor,id,value));assert.ok(await changePolicy(f.db,actor,id,1,{action:'test'},crypto.randomUUID()));assert.ok(await changePolicy(f.db,actor,id,2,{action:'publish'},crypto.randomUUID()));return {id,value};
  };
  const budget=async(limitMicros=528384,maxRuns=1)=>{
   const id=crypto.randomUUID(),startsAt=Math.floor(Date.now()/86400000)*86400000;
   assert.equal((await changeAiBudget(f.db,actor,{id,action:'create',startsAt,endsAt:startsAt+86400000,limitMicros,maxRuns})).outcome,'applied');
   assert.equal((await changeAiBudget(f.db,actor,{id:crypto.randomUUID(),action:'set_enabled',budgetId:id,expectedRevision:0,enabled:true})).outcome,'applied');return id;
  };
  const request=(policyId:string)=>({runId:crypto.randomUUID(),expectedVersion:0,messageId:'question',policyId,stage:'presale',language:'ru'});
  const env={DB:f.db,AI_RECEPTION_ENABLED:'true',NVAPI_KEY:'synthetic-only',FLUE_SUPPORT_AGENT:{} as any,AI_RECEPTION_CONFIG_JSON:JSON.stringify(config),
   CONVERSATION_CONTROLLER:{idFromName:(id:string)=>id,get:()=>({readAiWork:async(scope:any,runId:string)=>(await f.call('ai-work-read',{runId},scope)).body})} as any};
  return {...f,actor,policy,budget,request,env};
 }catch(error){await f.close();throw error;}
}
async function matching(){const m=await import('../src/modules/reply-policies/matching.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.selectReplyPolicy,'function','the server must choose a published policy by priority');return m!;}
async function budgets(){const m=await import('../src/modules/ai-runs/budget.ts');assert.equal(typeof (m as any).selectAiBudget,'function','runtime must select the scoped current budget');return m as typeof m&{selectAiBudget:(db:D1Database,scope:any,amount:number)=>Promise<string|null>};}
test('new runs must use the highest published matching policy; drafts cannot silently change selection',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const low=await f.policy(20),high=await f.policy(80),m=await matching();
 assert.equal((await m.selectReplyPolicy(f.db,f.scope,'presale'))!.id,high.id);assert.equal((await m.selectReplyPolicy(f.db,f.scope,'presale'))!.revision,1);
 assert.equal(await m.selectReplyPolicy(f.db,f.scope,'order'),null);assert.equal(await m.selectReplyPolicy(f.db,{...f.scope,organizationId:'other-org'},'presale'),null);
 assert.ok(await changePolicy(f.db,f.actor,high.id,3,{action:'draft',config:{...high.value,priority:0}},crypto.randomUUID()));assert.equal((await m.selectReplyPolicy(f.db,f.scope,'presale'))!.id,high.id);
 assert.equal((await f.call('ai-start',{request:f.request(low.id)})).body.outcome,'unavailable');assert.equal((await f.call('ai-start',{request:f.request(high.id)})).body.outcome,'accepted');
});
test('a higher suggestion-only policy suppresses automatic fallback and waiting admission',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const low=await f.policy(20),high=await f.policy(80,'suggest');
 assert.equal((await f.call('ai-start',{request:f.request(low.id)})).body.outcome,'unavailable');
 const listen=()=>f.call('ai-listen',{actor:f.actor,request:{commandId:crypto.randomUUID(),expectedVersion:0,previousRunId:null}});
 assert.equal((await listen()).body.outcome,'unavailable');assert.equal((await f.call('read')).body.view.state.version,0);
 assert.ok(await changePolicy(f.db,f.actor,high.id,3,{action:'pause'},crypto.randomUUID()));assert.equal((await listen()).body.outcome,'accepted');
});
test('publishing a higher priority policy affects new runs without rewriting an admitted run or its replay',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const low=await f.policy(20),request=f.request(low.id),started=await f.call('ai-start',{request});assert.equal(started.body.outcome,'accepted');
 await f.policy(80);assert.deepEqual((await f.call('ai-read',{runId:request.runId})).body,started.body.receipt.run);assert.deepEqual((await f.call('ai-start',{request})).body.receipt,started.body.receipt);
});
test('budget selection respects current scope, full-run amount, enablement and quota even at explicit zero price',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const m=await budgets();assert.equal(await m.selectAiBudget(f.db,f.scope,528384),null);
 const id=await f.budget();assert.equal(await m.selectAiBudget(f.db,f.scope,528384),id);assert.equal(await m.selectAiBudget(f.db,f.scope,528385),null);assert.equal(await m.selectAiBudget(f.db,{...f.scope,storeId:'other'},0),null);
 await f.db.prepare('UPDATE ai_budget SET reserved_micros=1 WHERE id=?').bind(id).run();assert.equal(await m.selectAiBudget(f.db,f.scope,528384),null);
 await f.db.prepare('UPDATE ai_budget SET enabled=0 WHERE id=?').bind(id).run();assert.equal(await m.selectAiBudget(f.db,f.scope,0),null);
 await f.db.prepare('UPDATE ai_budget SET enabled=1,admitted_runs=max_runs WHERE id=?').bind(id).run();assert.equal(await m.selectAiBudget(f.db,f.scope,0),null);
 await assert.rejects(()=>m.selectAiBudget(f.db,f.scope,-1));await assert.rejects(()=>m.selectAiBudget(f.db,f.scope,1.5));
});
test('execution chooses server prices and budget once before touching the native runtime',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const p=await f.policy(),id=await f.budget(),request=f.request(p.id);assert.equal((await f.call('ai-start',{request})).body.outcome,'accepted');
 const prepared:any[]=[];const runtime={lookup:async()=>null,inspect:async()=>null,prepare:async(run:any)=>{prepared.push(run);throw new Error('stop before any synthetic provider call');}} as unknown as SupportRuntime;
 const result=await executeAiRun(f.env,f.scope,request.runId,{runtime});assert.equal(result.status,'unconfirmed');assert.equal(prepared.length,1);
 const run=(await readAiExecution(f.db,f.scope,request.runId))!;assert.equal(run.budgetId,id);assert.deepEqual(run.config,config);assert.equal(run.reservedMicros,528384);
 await f.db.prepare('UPDATE ai_budget SET enabled=0 WHERE id=?').bind(id).run();await executeAiRun({...f.env,AI_RECEPTION_ENABLED:'false',AI_RECEPTION_CONFIG_JSON:'invalid'},f.scope,request.runId,{runtime});
 assert.deepEqual(await readAiExecution(f.db,f.scope,request.runId),run);assert.equal(prepared.length,1);assert.equal(await f.db.prepare('SELECT admitted_runs FROM ai_budget WHERE id=?').bind(id).first('admitted_runs'),1);
});
test('disabled, missing, malformed or insufficient server configuration never reserves funds or touches runtime',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const p=await f.policy(),id=await f.budget(528383),request=f.request(p.id);assert.equal((await f.call('ai-start',{request})).body.outcome,'accepted');
 let touched=0;const runtime={lookup:async()=>{touched++;throw new Error('unexpected native call');}} as unknown as SupportRuntime;
 for(const patch of [{},{AI_RECEPTION_ENABLED:'false'},{NVAPI_KEY:''},{AI_RECEPTION_CONFIG_JSON:undefined},{AI_RECEPTION_CONFIG_JSON:'bad'},{FLUE_SUPPORT_AGENT:undefined}]){
  assert.equal((await executeAiRun({...f.env,...patch},f.scope,request.runId,{runtime})).status,'unavailable');
 }
 assert.equal(touched,0);assert.equal(await readAiExecution(f.db,f.scope,request.runId),null);assert.equal(await f.db.prepare('SELECT admitted_runs FROM ai_budget WHERE id=?').bind(id).first('admitted_runs'),0);
});
test('an ambiguous highest priority fails closed rather than choosing by policy ID',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const first=await f.policy(80);assert.ok(await changePolicy(f.db,f.actor,first.id,3,{action:'pause'},crypto.randomUUID()));
 const second=await f.policy(80);await f.db.prepare('UPDATE reply_policy SET enabled=1 WHERE id=?').bind(first.id).run();
 assert.equal(await(await matching()).selectReplyPolicy(f.db,f.scope,'presale'),null);assert.equal((await f.call('ai-start',{request:f.request(second.id)})).body.outcome,'unavailable');
});
test('concurrent execution admission consumes one server-selected budget reservation',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const p=await f.policy(),id=await f.budget(),request=f.request(p.id);assert.equal((await f.call('ai-start',{request})).body.outcome,'accepted');
 const runtime={lookup:async()=>null,inspect:async()=>null,prepare:async()=>{throw new Error('stop before external calls');}} as unknown as SupportRuntime;
 const results=await Promise.all(Array.from({length:4},()=>executeAiRun(f.env,f.scope,request.runId,{runtime})));assert.ok(results.some(r=>r.status==='unconfirmed'));
 assert.equal(await f.db.prepare('SELECT count(*) n FROM ai_execution').first('n'),1);const budget=await f.db.prepare('SELECT admitted_runs AS runs,reserved_micros AS reserved FROM ai_budget WHERE id=?').bind(id).first<any>();assert.deepEqual(budget,{runs:1,reserved:528384});
});
