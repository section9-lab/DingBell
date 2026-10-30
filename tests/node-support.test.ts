import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {createNodeApplication as createSourceApplication} from '../src/platform/node/application.ts';
const createNodeApplication:typeof createSourceApplication=process.env.DINGBELL_TEST_COMPILED==='true'?(await import(new URL('../dist/node/server/application.mjs',import.meta.url).href)).createNodeApplication:createSourceApplication;
import {createPolicy,changePolicy} from '../src/modules/reply-policies/storage.ts';
import {ensureControlDirectory} from '../src/modules/conversations/control-storage.ts';
import {changeAiBudget,reserveAiExecution,readAiExecution} from '../src/modules/ai-runs/storage.ts';
import {executeAiRun,reconcileAiExecution,aiRunReader} from '../src/modules/ai-runs/execution.ts';

const config={maxGenerations:1,model:{provider:'nvidia' as const,model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'support-v1',promptVersion:'support-v1',maxInputTokens:262144,maxOutputTokens:512,pricing:{version:'synthetic',currency:'USD' as const,inputMicrosPerMillion:100,outputMicrosPerMillion:200,cacheReadMicrosPerMillion:50,cacheWriteMicrosPerMillion:100}}};
for(const mode of ['handoff','cancel-before-dispatch'] as const)test(`Node Support ${mode} keeps its budget, original execution and tool authority`,{timeout:30000},async context=>{
 const directory=await mkdtemp(join(tmpdir(),'dingbell-node-support-'));let calls=0;
 const options:Parameters<typeof createNodeApplication>[0]={dataDirectory:directory,migrationsDirectory:resolve('migrations'),variables:{AI_RECEPTION_ENABLED:'true',NVAPI_KEY:'synthetic-never-real',AI_RECEPTION_CONFIG_JSON:JSON.stringify(config)},providerFetch:async(input,init)=>{
  assert.equal(String(input),'https://integrate.api.nvidia.com/v1/chat/completions');calls++;
  const body=JSON.parse(String(init?.body)) as {tools:{function:{name:string}}[]};assert.deepEqual(body.tools.map(tool=>tool.function.name),['request_handoff']);
  const chunks=[{id:'synthetic',object:'chat.completion.chunk',created:1,model:config.model.model,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call-handoff',type:'function',function:{name:'request_handoff',arguments:JSON.stringify({reason:'customer_request',neededInformation:[]})}}]},finish_reason:'tool_calls'}]},{choices:[],usage:{prompt_tokens:24,completion_tokens:12,total_tokens:36}}];
  return new Response(chunks.map(value=>'data: '+JSON.stringify(value)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }};let app=await createNodeApplication(options);
 context.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
 const db=app.database,now=Date.now(),startsAt=Math.floor(now/86400000)*86400000;db.sqlite.exec(`INSERT INTO organization(id,name,slug,created_at) VALUES('org','Org','org',1);
 INSERT INTO user(id,name,email,email_verified) VALUES('owner','Owner','owner@example.invalid',1);
 INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('owner-member','org','owner','owner',1);
 INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('owner-session','token','owner',${now+3600000},1,1);
 INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES('store','org','Store','1','verified',1,1);
 INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES('conv','org','store','thread','BUYER_SELLER','Opened',1,1);
 INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES('message','org','store','conv','message','Customer','inbound','["Мне нужен человек."]',0,0,1,1,'incremental');`);
 const actor={orgId:'org',actorUserId:'owner',sessionId:'owner-session',expectedMemberId:'owner-member'},policyId=crypto.randomUUID(),budgetId=crypto.randomUUID();
 const policy={kind:'automatic' as const,name:'Support',storeIds:['store'],priority:50,stages:['presale' as const],mode:'automatic' as const,language:'customer' as const,tone:'concise' as const,instructions:''};
 assert.ok(await createPolicy(db,actor,policyId,policy));assert.ok(await changePolicy(db,actor,policyId,1,{action:'test'},crypto.randomUUID()));assert.ok(await changePolicy(db,actor,policyId,2,{action:'publish'},crypto.randomUUID()));
 assert.equal((await changeAiBudget(db,actor,{id:budgetId,action:'create',startsAt,endsAt:startsAt+86400000,limitMicros:1000000,maxRuns:10})).outcome,'applied');
 assert.equal((await changeAiBudget(db,actor,{id:crypto.randomUUID(),action:'set_enabled',budgetId,expectedRevision:0,enabled:true})).outcome,'applied');
 const scope=(await ensureControlDirectory(db,actor,'conv',now))!.scope,controller=app.env.CONVERSATION_CONTROLLER!.getByName(scope.controllerId),id=crypto.randomUUID();
 const started=await controller.startAi(scope,{runId:id,expectedVersion:0,messageId:'message',policyId,stage:'presale',language:'ru'});assert.equal(started.outcome,'accepted',JSON.stringify(started));
 if(mode==='cancel-before-dispatch'){
  const reserved=await reserveAiExecution(db,aiRunReader(app.env),scope,id,budgetId,config);assert.ok(reserved.run);await app.env.AGENT_RUNTIME!.support.prepare(reserved.run);
  assert.equal(await app.env.AGENT_RUNTIME!.support.lookup(reserved.run),null,'Preparation must not pretend that a submission was admitted');
  const takeover=await controller.execute(scope,actor,{commandId:crypto.randomUUID(),action:'takeover',expectedVersion:1});assert.equal(takeover.outcome,'accepted',JSON.stringify(takeover));
  await reconcileAiExecution(app.env,scope,id);const run=await readAiExecution(db,scope,id);assert.equal(run?.closure?.kind,'unstarted_closed',JSON.stringify(run));assert.equal(calls,0);
 }else{
  let result=await executeAiRun(app.env,scope,id);const deadline=Date.now()+12000;
  while(!['completed','failed'].includes(result.status)&&Date.now()<deadline){await delay(30);result=await executeAiRun(app.env,scope,id);}
  assert.equal(result.status,'completed',JSON.stringify(await readAiExecution(db,scope,id)));assert.equal(calls,1);
  const run=await readAiExecution(db,scope,id);assert.equal(run?.status,'settled');assert.equal(run?.closure?.kind,'runtime_closed');assert.ok(run?.receipt?.uid.startsWith('pi_'));
  const view=await controller.read(scope,actor);assert.equal(view.outcome,'found');if(view.outcome==='found')assert.equal(view.view.state.reception,'paused');
  await executeAiRun(app.env,scope,id);assert.equal(calls,1);
  const saved=await readAiExecution(db,scope,id);await app.close();app=await createNodeApplication(options);
  assert.deepEqual(await readAiExecution(app.database,scope,id),saved);assert.equal((await executeAiRun(app.env,scope,id)).status,'completed');assert.equal(calls,1);
 }
});
