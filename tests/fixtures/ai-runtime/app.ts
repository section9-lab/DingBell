import {Hono} from 'hono';
import {getAgentByName} from 'agents';
import {init} from '@flue/runtime';
import {Support} from '../../../src/agents/support.ts';
import {createApp} from '../../../src/application.ts';
import {createPolicy,changePolicy} from '../../../src/modules/reply-policies/storage.ts';
import {ensureControlDirectory} from '../../../src/modules/conversations/control-storage.ts';
import {getConversationController} from '../../../src/modules/conversations/control-bindings.ts';
import {changeAiBudget,reserveAiExecution,readAiExecution} from '../../../src/modules/ai-runs/storage.ts';
import {parseSupportConfiguration} from '../../../src/modules/ai-runs/configuration.ts';
import {executeAiRun,readExecutedAiRun,aiRunReader,reconcileConversationAi} from '../../../src/modules/ai-runs/execution.ts';
import workerEvents from '../../../src/cloudflare.ts';
import {createSupportRuntime} from '../../../src/modules/ai-runs/runtime.ts';
import {prepareKnowledge} from '../../../src/modules/knowledge/content.ts';
import {writeKnowledge,publishKnowledge} from '../../../src/modules/knowledge/storage.ts';
import {knowledgeManifest,indexKnowledge,knowledgeProfile} from '../../../src/modules/knowledge/vectorize.ts';
import {encryptCredentials} from '../../../src/modules/stores/credentials.ts';
const actor={orgId:'org',actorUserId:'owner',sessionId:'owner-session',expectedMemberId:'owner-member'};
const policyId='12345678-1234-4234-8234-123456789abc';
const config=parseSupportConfiguration({model:{provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'support-v1',promptVersion:'support-v1',maxInputTokens:262144,maxOutputTokens:2048,
 pricing:{version:'synthetic',currency:'USD',inputMicrosPerMillion:100,outputMicrosPerMillion:200,cacheReadMicrosPerMillion:50,cacheWriteMicrosPerMillion:100}},maxGenerations:3}).config;
const app=new Hono<{Bindings:Record<string,any>}>();
app.get('/api/health',c=>c.json({service:'support-runtime-fixture'}));
app.use('/test/*',async(c,next)=>{if(c.req.header('authorization')!==`Bearer ${c.env.TEST_TOKEN}`)return c.text('denied',403);await next();});
app.post('/test/safety',c=>c.json({syntheticKey:c.env.NVAPI_KEY==='synthetic-never-real'}));
app.post('/test/reply-store',async c=>{
 const now=Date.now(),key=await encryptCredentials(c.env,{orgId:'org',storeId:'store',platformStoreId:'1',credentialVersion:1},{apiKey:'synthetic-ozon-key'});
 await c.env.DB.prepare("UPDATE store SET outbound_enabled=1,credential_key_version=?,credential_nonce=?,credential_ciphertext=?,capabilities=?,checked_at=?,expires_at=? WHERE id='store'")
  .bind(key.keyVersion,key.nonce,key.ciphertext,JSON.stringify([{code:'auth',status:'available'},{code:'reply',status:'available'}]),now,now+3600000).run();return c.json({ok:true});
});
app.post('/test/sql',async c=>{const body=await c.req.json<any>(),db=c.env.DB as D1Database;return c.json(body.batch?await db.batch(body.batch.map((sql:string)=>db.prepare(sql))):await db.prepare(body.sql).bind(...body.params??[]).all());});
app.post('/test/knowledge-source',async c=>{
 const db=c.env.DB as D1Database,id=crypto.randomUUID(),scope={kind:'guide' as const,storeId:'store',productRef:null,language:'ru' as const};
 await db.prepare('CREATE TABLE IF NOT EXISTS synthetic_knowledge_calls(id INTEGER PRIMARY KEY,kind TEXT,payload TEXT)').run();
 await db.prepare('CREATE TABLE IF NOT EXISTS synthetic_knowledge_vectors(id TEXT PRIMARY KEY,vector TEXT)').run();
 const prepared=await prepareKnowledge('org',id,1,scope,{title:'Synthetic dimensions',source:{format:'text',content:'Ширина — 26 см.'}});
 if(!await writeKnowledge(db,actor,id,scope,prepared,0,crypto.randomUUID()))throw new Error('synthetic knowledge seed');
 const index={async upsert(vectors:VectorizeVector[]){await db.batch(vectors.map(vector=>db.prepare('INSERT INTO synthetic_knowledge_vectors(id,vector) VALUES(?,?)').bind(vector.id,JSON.stringify(vector))));return {mutationId:'synthetic'};}} as unknown as Vectorize;
 await indexKnowledge(index,await knowledgeManifest('org',id,1,scope,prepared),prepared.chunks.map(()=>Array.from({length:1024},(_,i)=>i===0?1:0)),true);
 await db.prepare("UPDATE knowledge_revision SET status='ready',index_profile=?,mutation_id='draft',tested_at=1,published_profile=?,published_mutation_id='published',published_at=2 WHERE document_id=?").bind(knowledgeProfile.id,knowledgeProfile.id,id).run();
 if(!await publishKnowledge(db,actor,id,1))throw new Error('synthetic knowledge publication');return c.json({id,chunkId:prepared.chunks[0].id});
});
app.post('/test/setup',async c=>{
 const p={kind:'automatic' as const,name:'Support',storeIds:['store'],priority:50,stages:['presale' as const],mode:'automatic' as const,language:'customer' as const,tone:'concise' as const,instructions:''};
 if(!await createPolicy(c.env.DB,actor,policyId,p)||!await changePolicy(c.env.DB,actor,policyId,1,{action:'test'},crypto.randomUUID())||!await changePolicy(c.env.DB,actor,policyId,2,{action:'publish'},crypto.randomUUID()))throw new Error('synthetic support policy failed');
 const start=Math.floor(Date.now()/86400000)*86400000;
 await changeAiBudget(c.env.DB,actor,{id:policyId,action:'create',startsAt:start,endsAt:start+86400000,limitMicros:100000000,maxRuns:100});
 await changeAiBudget(c.env.DB,actor,{id:crypto.randomUUID(),action:'set_enabled',budgetId:policyId,expectedRevision:0,enabled:true});return c.json({ok:true});
});
app.post('/test/reserve',async c=>{
 const body=await c.req.json<any>(),id=crypto.randomUUID(),db=c.env.DB as D1Database;
 await db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES(?,'org','store',?,'BUYER_SELLER','Opened',1,1)").bind(id,id).run();
 await db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES(?,'org','store',?,?,'Customer','inbound',?,0,0,1,1,'incremental')").bind(id,id,id,JSON.stringify([body.reply?'Какая ширина?':'Мне нужен человек.'])).run();
 const scope=(await ensureControlDirectory(db,actor,id,Date.now()))!.scope,request={runId:crypto.randomUUID(),expectedVersion:0,messageId:id,policyId,stage:'presale',language:'ru'};
 const result=await getConversationController(c.env,scope.controllerId).startAi(scope,request);if(result.outcome!=='accepted')throw new Error('synthetic support admission failed');
 if(body.unreserved)return c.json({scope,runId:request.runId});
 return c.json(await reserveAiExecution(db,aiRunReader(c.env),scope,request.runId,policyId,{...config,maxGenerations:body.maxGenerations??3,model:{...config.model,...body.model}}));
});
app.post('/test/intake',async c=>{
 const body=await c.req.json<any>(),id=crypto.randomUUID(),db=c.env.DB as D1Database,now=Date.now();
 await db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES(?,'org','store',?,'BUYER_SELLER','Opened',1,1)").bind(id,id).run();
 await db.batch([
  db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES(?,'org','store',?,?,'Customer','inbound','[\"Какая ширина?\"]',0,0,?,?,'incremental')").bind(id,id,id,now,now),
  db.prepare("INSERT INTO ingest_event(id,organization_id,store_id,conversation_id,message_id,state,live_observed_at,trace_id,created_at) VALUES(?,'org','store',?,?,'pending',?,'synthetic',?)").bind(id,id,id,now,now),
 ]);
 const scope=(await ensureControlDirectory(db,actor,id,now))!.scope,request={runId:crypto.randomUUID(),expectedVersion:0,messageId:id};
 if(body.queued)return c.json({scope,eventId:id});
 const result=await getConversationController(c.env,scope.controllerId).startAiIntake(scope,request);if(result.outcome!=='accepted')throw new Error('synthetic intake admission failed');
 return c.json({scope,runId:request.runId});
});
app.post('/test/:operation',async c=>{
 const body=await c.req.json<any>(),{scope,runId}=body,runtime=createSupportRuntime(c.env),original=runtime.dispatch;
 if(body.loseReceipt)runtime.dispatch=async run=>{await original(run);throw new Error('synthetic lost support receipt');};
 if(body.failAbort)runtime.abort=async()=>{throw new Error('synthetic unavailable abort');};
 if(body.failLookup)runtime.lookup=async()=>{throw new Error('synthetic lookup must not be called');};
 const operation=c.req.param('operation');
 if(operation==='reply-read')return c.json(await getConversationController(c.env,scope.controllerId).readReply(scope,actor,body.intentId));
 if(operation==='reply-enqueue')return c.json(await getConversationController(c.env,scope.controllerId).enqueueAiReply(scope,runId));
 if(operation==='classified')return c.json(await getConversationController(c.env,scope.controllerId).readClassifiedInput(scope));
 if(operation==='advance'){
  const controller=getConversationController(c.env,scope.controllerId),next=await controller.readClassifiedInput(scope);if(!next)return c.json(null);
  const result=await controller.startAi(scope,next.request);return c.json({result,scope,runId:next.request.runId});
 }
 if(operation==='cron'){await c.env.DB.batch([c.env.DB.prepare('UPDATE conversation_control SET repair_due_at=0'),c.env.DB.prepare('UPDATE ai_execution SET repair_due_at=0 WHERE repair_due_at IS NOT NULL'),c.env.DB.prepare('UPDATE ai_dispatch SET due_at=0 WHERE due_at IS NOT NULL')]);await workerEvents.scheduled({} as ScheduledController,{...c.env,AI_RECEPTION_CONFIG_JSON:JSON.stringify(body.knowledge||body.answer||body.reply?{...config,model:{...config.model,promptVersion:body.reply?'support-reply-v1':body.answer?'support-answer-v1':'support-knowledge-v1'}}:config)});return c.json({ok:true});}
 if(operation==='reconcile')return c.json(await reconcileConversationAi(c.env,scope,{runtime}));
 if(operation==='execute')return c.json(await executeAiRun({...c.env,AI_RECEPTION_CONFIG_JSON:JSON.stringify(config)},scope,runId,{runtime}));
 if(operation==='read')return c.json(await readExecutedAiRun(c.env,scope,runId,{runtime}));
 const run=await readAiExecution(c.env.DB,scope,runId);if(!run)return c.json({error:'missing'},404);
 if(operation==='run')return c.json(run);
 if(operation==='inspect')return c.json(await runtime.inspect(run));
 if(operation==='prepare'){await runtime.prepare(run);return c.json({ok:true});}
 if(operation==='close'){await runtime.close(run);return c.json({ok:true});}
 if(operation==='abort'){await runtime.abort(run);return c.json({ok:true});}
 if(operation==='resume'){
  const controller=getConversationController(c.env,scope.controllerId),state=(await controller.read(scope,actor));if(state.outcome!=='found')throw new Error('synthetic control missing');
  const request={...run.payload.run.request,runId:crypto.randomUUID(),previousRunId:run.id,expectedVersion:state.view.state.version};
  const result=await controller.resumeAi(scope,actor,request);if(result.outcome!=='accepted')return c.json(result,409);
  return c.json(await reserveAiExecution(c.env.DB,aiRunReader(c.env),scope,request.runId,policyId,config));
 }
 if(operation==='destroy'){await(await getAgentByName(c.env.FLUE_SUPPORT_AGENT,run.instanceId)).destroy();return c.json({ok:true});}
 if(operation==='takeover')return c.json(await getConversationController(c.env,scope.controllerId).execute(scope,actor,{commandId:crypto.randomUUID(),action:'takeover',expectedVersion:1}));
 if(operation==='control')return c.json(await getConversationController(c.env,scope.controllerId).read(scope,actor));
 if(operation==='dispatch-raw')return c.json(await init(Support,{id:run.instanceId,uid:null}).dispatch({message:JSON.stringify(run.modelInput),initialData:{runId},idempotencyKey:run.dispatchKey}));
 if(operation==='dispatch-altered')return c.json(await init(Support,{id:run.instanceId,uid:null}).dispatch({message:'altered input',initialData:{runId},idempotencyKey:run.dispatchKey}));
 return c.json({error:'unknown'},400);
});
const production=createApp();app.all('*',c=>production.fetch(c.req.raw,c.env,c.executionCtx));
app.onError(error=>Response.json({error:error.message},{status:500}));export default app;
