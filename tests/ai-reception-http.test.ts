import assert from 'node:assert/strict';
import {test} from 'node:test';
import {hashPassword} from 'better-auth/crypto';
import {createApp} from '../src/application.ts';
import {services} from '../src/modules/identity/services.ts';
import {conversationControlFixture} from './fixtures/conversation-control.ts';
import {createPolicy,changePolicy} from '../src/modules/reply-policies/storage.ts';
import {changeAiBudget,readAiExecution,reserveAiExecution,closeAiExecution} from '../src/modules/ai-runs/storage.ts';

const config={maxGenerations:2,model:{provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'support-v1',promptVersion:'support-v1',maxInputTokens:262144,maxOutputTokens:2048,
 pricing:{version:'synthetic',currency:'USD',inputMicrosPerMillion:1000000,outputMicrosPerMillion:1000000,cacheReadMicrosPerMillion:1000000,cacheWriteMicrosPerMillion:1000000}}};
async function fixture(){
 const f=await conversationControlFixture(undefined,{aiEnabled:'true'}),actor={...f.actor(),expectedMemberId:'owner-member'},policyId=crypto.randomUUID(),budgetId=crypto.randomUUID();
 try{
  await f.db.prepare("UPDATE store SET status='verified' WHERE id='store'").run();
  const policy={kind:'automatic' as const,name:'Support',storeIds:['store'],priority:50,stages:['presale' as const,'order' as const,'aftersale' as const],mode:'automatic' as const,language:'customer' as const,tone:'concise' as const,instructions:''};
  assert.ok(await createPolicy(f.db,actor,policyId,policy));assert.ok(await changePolicy(f.db,actor,policyId,1,{action:'test'},crypto.randomUUID()));assert.ok(await changePolicy(f.db,actor,policyId,2,{action:'publish'},crypto.randomUUID()));
  const startsAt=Math.floor(Date.now()/86400000)*86400000;
  assert.equal((await changeAiBudget(f.db,actor,{id:budgetId,action:'create',startsAt,endsAt:startsAt+86400000,limitMicros:2000000,maxRuns:10})).outcome,'applied');
  assert.equal((await changeAiBudget(f.db,actor,{id:crypto.randomUUID(),action:'set_enabled',budgetId,expectedRevision:0,enabled:true})).outcome,'applied');
  let loseResponse=false,afterRead:(()=>Promise<void>)|undefined;const calls:string[]=[];
  const rpc=async(op:string,name:string,scope:any,extra:any)=>{calls.push(op);const result=await f.call(op,{...extra,name},scope);if(result.status!==200)throw new Error('synthetic RPC failed');
   if(op==='ai-reception-resume'&&loseResponse){loseResponse=false;throw new Error('synthetic lost acknowledgement');}
   if(op==='ai-reception-read'&&afterRead){const hook=afterRead;afterRead=undefined;await hook();}return result.body;};
  const env={DB:f.db,APP_BASE_URL:'https://reception.example.invalid',BETTER_AUTH_SECRET:'synthetic-reception-auth-secret-at-least-thirty-two',AI_RECEPTION_ENABLED:'true',NVAPI_KEY:'synthetic-only',AI_RECEPTION_CONFIG_JSON:JSON.stringify(config),FLUE_SUPPORT_AGENT:{} as any,
   CONVERSATION_CONTROLLER:{idFromName:(id:string)=>id,get:(name:string)=>({readAiReception:(scope:any,actor:any,commandId?:string)=>rpc('ai-reception-read',name,scope,{actor,commandId}),resumeAiReception:(scope:any,actor:any,request:any)=>rpc('ai-reception-resume',name,scope,{actor,request})})} as any};
  const password='synthetic-test-password',hash=await hashPassword(password),cookies:Record<string,string>={};
  for(const user of ['owner','staff']){
   await f.db.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password,updated_at) VALUES (?,?,'credential',?,?,1)").bind(user,user,user,hash).run();
   const response=await services(env)!.auth.api.signInEmail({body:{email:`${user}@example.invalid`,password},asResponse:true});assert.equal(response.status,200);
   cookies[user]=response.headers.getSetCookie().map(x=>x.split(';',1)[0]).join('; ');
  }
  const app=createApp(),request=(suffix='/ai-reception',body?:unknown,options:{user?:string;member?:string|null;origin?:string;conversation?:string;company?:string}={})=>{
   const user=options.user??'owner',headers=new Headers({cookie:cookies[user]??'',origin:options.origin??env.APP_BASE_URL,'content-type':'application/json'});
   const member=options.member===undefined?`${user}-member`:options.member;if(member!==null)headers.set('X-DingBell-Member-Id',member);
   return app.request(`${env.APP_BASE_URL}/api/companies/${options.company??'org'}/conversations/${options.conversation??'conv'}${suffix}`,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)})},env);
  };
  return {...f,actor,env,policyId,budgetId,calls,request,command:{commandId:crypto.randomUUID(),expectedVersion:0},lose(){loseResponse=true;},afterRead(hook:()=>Promise<void>){afterRead=hook;}};
 }catch(error){await f.close();throw error;}
}
async function error(response:Response,status:number,code:string){assert.equal(response.status,status,await response.clone().text());assert.equal((await response.json() as any).error.code,code);}
test('public resumption waits for new input, derives its prior run and never spends or starts a model',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const before=await f.request();assert.equal(before.status,200);assert.equal((await before.json() as any).waiting,null);
 const response=await f.request('/ai-resumptions',f.command);assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('cache-control'),'no-store');const data=await response.json() as any;
 assert.equal(data.resumption.commandId,f.command.commandId);assert.equal(data.resumption.expectedVersion,0);assert.equal(data.resumption.appliedVersion,1);assert.equal(data.waiting.afterSequence,0);assert.equal(data.control.reception,'ai');
 assert.equal(JSON.stringify(data).includes('previousRunId'),false);assert.equal(JSON.stringify(data).includes(f.env.NVAPI_KEY),false);
 assert.equal(await f.db.prepare('SELECT count(*) n FROM ai_execution').first('n'),0);assert.equal(await f.db.prepare('SELECT reserved_micros FROM ai_budget').first('reserved_micros'),0);assert.equal(f.providerRequests.length,0);
 f.env.AI_RECEPTION_ENABLED='false';f.env.AI_RECEPTION_CONFIG_JSON='invalid';await f.db.prepare('UPDATE ai_budget SET enabled=0').run();
 assert.deepEqual((await(await f.request('/ai-resumptions',f.command)).json() as any).resumption,data.resumption);
 assert.equal((await f.call('execute',{command:{commandId:crypto.randomUUID(),expectedVersion:1,action:'takeover'}})).body.outcome,'accepted');
 const replay=await(await f.request(`/ai-resumptions/${f.command.commandId}`)).json() as any;assert.deepEqual(replay.resumption,data.resumption);assert.equal(replay.waiting,null);assert.equal(replay.control.reception,'human');
 assert.equal((await(await f.request('/ai-resumptions',f.command)).json() as any).control.version,2);
});
test('lost acknowledgements are recovered read-only with the same member-bound command',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);f.lose();await error(await f.request('/ai-resumptions',f.command),503,'OPERATION_UNCONFIRMED');
 const count=f.calls.filter(x=>x==='ai-reception-resume').length,data=await(await f.request(`/ai-resumptions/${f.command.commandId}`)).json() as any;assert.equal(data.resumption.appliedVersion,1);
 assert.equal(f.calls.filter(x=>x==='ai-reception-resume').length,count);assert.equal((await f.request('/ai-resumptions',f.command)).status,200);assert.equal(f.calls.filter(x=>x==='ai-reception-resume').length,count);
 await error(await f.request('/ai-resumptions',{...f.command,expectedVersion:1}),409,'COMMAND_CONFLICT');
 await error(await f.request(`/ai-resumptions/${crypto.randomUUID()}`),404,'RESUMPTION_NOT_FOUND');
 assert.equal(await f.db.prepare("SELECT count(*) n FROM conversation_control_event WHERE action='ai_listen'").first('n'),1);
});
test('configuration and full-run budget gates block new public resumption without changing control',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);f.env.AI_RECEPTION_ENABLED='false';await error(await f.request('/ai-resumptions',f.command),403,'AI_DISABLED');f.env.AI_RECEPTION_ENABLED='true';
 f.env.NVAPI_KEY='';await error(await f.request('/ai-resumptions',f.command),503,'AI_NOT_CONFIGURED');f.env.NVAPI_KEY='synthetic-only';
 f.env.AI_RECEPTION_CONFIG_JSON='{}';await error(await f.request('/ai-resumptions',f.command),503,'AI_NOT_CONFIGURED');f.env.AI_RECEPTION_CONFIG_JSON=JSON.stringify(config);
 await f.db.prepare('UPDATE ai_budget SET enabled=0').run();await error(await f.request('/ai-resumptions',f.command),412,'AI_BUDGET_UNAVAILABLE');
 await f.db.prepare('UPDATE ai_budget SET enabled=1,reserved_micros=1500000').run();await error(await f.request('/ai-resumptions',f.command),412,'AI_BUDGET_UNAVAILABLE');
 assert.equal((await f.call('read')).body.view.state.version,0);assert.equal(f.calls.filter(x=>x==='ai-reception-resume').length,0);
});
test('strict bodies and paths cannot supply model, budget, scope, membership or old-input authority',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);
 for(const patch of [{previousRunId:null},{messageId:'old'},{policyId:f.policyId},{budgetId:f.budgetId},{stage:'presale'},{language:'ru'},{controlEpoch:0},{afterSequence:0},{mode:'current'},{actorMemberId:'staff-member'}])await error(await f.request('/ai-resumptions',{...f.command,...patch}),400,'INVALID_REQUEST');
 for(const suffix of ['/ai-resumptions?x=1','/ai-resumptions/not-uuid','/ai-reception?x=1'])await error(await f.request(suffix,suffix.includes('?')&&suffix.startsWith('/ai-resumptions')?f.command:undefined),400,'INVALID_REQUEST');
 await error(await f.request('/ai-resumptions',f.command,{member:null}),400,'INVALID_REQUEST');await error(await f.request('/ai-resumptions',f.command,{member:'%6fwner-member'}),400,'INVALID_REQUEST');
 await error(await f.request('/ai-resumptions',f.command,{origin:'https://elsewhere.invalid'}),403,'ORIGIN_REJECTED');assert.equal((await f.call('read')).body.view.state.version,0);
});
test('current membership and store access protect both commands and historical receipts',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);assert.equal((await f.request('/ai-resumptions',f.command,{user:'staff'})).status,200);
 await error(await f.request(`/ai-resumptions/${f.command.commandId}`),404,'NOT_FOUND');await error(await f.request('/ai-resumptions',f.command),404,'NOT_FOUND');
 await error(await f.request('/ai-resumptions',{commandId:crypto.randomUUID(),expectedVersion:1},{user:'staff',member:'former-member'}),404,'NOT_FOUND');
 await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();await error(await f.request(`/ai-resumptions/${f.command.commandId}`,undefined,{user:'staff'}),404,'NOT_FOUND');
 await error(await f.request('/ai-reception',undefined,{company:'other-org'}),404,'NOT_FOUND');
});
test('late permission revocation hides an already-read reception result',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);f.afterRead(async()=>{await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();});
 await error(await f.request('/ai-reception',undefined,{user:'staff'}),404,'NOT_FOUND');assert.ok(f.calls.includes('ai-reception-read'));
});
test('public resumption waits for old financial closure and does not replay its old question',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);await f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES('old','org','store','conv','old','Customer','inbound','[\"Вопрос\"]',0,0,1,1,'incremental')").run();
 const runId=crypto.randomUUID(),request={runId,expectedVersion:0,messageId:'old',policyId:f.policyId,stage:'presale',language:'ru'};assert.equal((await f.call('ai-start',{request})).body.outcome,'accepted');
 const reader=async(scope:any,id:string)=>(await f.call('ai-read',{runId:id},scope)).body;assert.equal((await reserveAiExecution(f.db,reader,f.scope,runId,f.budgetId,config)).outcome,'reserved');
 assert.equal((await f.call('execute',{command:{commandId:crypto.randomUUID(),expectedVersion:1,action:'takeover'}})).body.outcome,'accepted');const command={...f.command,expectedVersion:2};
 await error(await f.request('/ai-resumptions',command),412,'AI_RECEPTION_UNAVAILABLE');
 await closeAiExecution(f.db,f.scope,runId,{kind:'unstarted_closed',providerPermits:0,evidenceId:crypto.randomUUID(),instanceId:`ai-support:${runId}`,executionClosed:true,verifiedAt:Date.now()});
 const resumed=await f.request('/ai-resumptions',command);assert.equal(resumed.status,200);assert.equal((await resumed.json() as any).waiting.afterSequence,1);
 assert.equal(await reader(f.scope,runId),null);assert.ok((await readAiExecution(f.db,f.scope,runId))!.closure);assert.equal(await f.db.prepare('SELECT count(*) n FROM ai_execution').first('n'),1);
});
test('a newly observed conversation stays read-only, and revoked initialization cannot report successful resumption',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);await f.db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES('fresh','org','store','fresh','BUYER_SELLER','Opened',1,1)").run();
 const view=await f.request('/ai-reception',undefined,{user:'staff',conversation:'fresh'});assert.equal(view.status,200);assert.equal((await view.json() as any).control.version,0);
 assert.equal(await f.db.prepare("SELECT count(*) n FROM conversation_control WHERE conversation_id='fresh'").first('n'),0);
 let initialization=false,revoked=false;const db=f.db;
 f.env.DB=new Proxy(db,{get(target,key){
  if(key==='prepare')return(sql:string)=>{if(sql.startsWith('INSERT INTO conversation_control('))initialization=true;return target.prepare(sql);};
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(initialization&&!revoked){revoked=true;await db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();}return target.batch(statements);};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 await error(await f.request('/ai-resumptions',f.command,{user:'staff',conversation:'fresh'}),404,'NOT_FOUND');assert.equal(revoked,true);
 assert.equal(await db.prepare("SELECT count(*) n FROM conversation_control WHERE conversation_id='fresh'").first('n'),0);
});
test('historical public commands remain bound to their original boundary after a newer run and resumption',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const first=await(await f.request('/ai-resumptions',f.command)).json() as any;
 const at=Date.now()+1;await f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES('new','org','store','conv','new','Customer','inbound','[\"Новый вопрос\"]',0,0,?,?,'incremental')").bind(at,at).run();
 const runId=crypto.randomUUID();assert.equal((await f.call('ai-start',{request:{runId,expectedVersion:1,messageId:'new',policyId:f.policyId,stage:'presale',language:'ru'}})).body.outcome,'accepted');
 assert.equal((await f.call('ai-handoff',{runId,input:{reason:'customer_request',summary:'Клиент просит человека.',neededInformation:[]}})).body.outcome,'accepted');
 const second={commandId:crypto.randomUUID(),expectedVersion:3};assert.equal((await f.request('/ai-resumptions',second)).status,200);
 const replay=await(await f.request('/ai-resumptions',f.command)).json() as any;assert.deepEqual(replay.resumption,first.resumption);assert.equal(replay.control.version,4);assert.equal(replay.waiting.commandId,second.commandId);assert.equal(replay.waiting.afterSequence,1);
});
test('parallel public commands commit one version and repeating the accepted ID cannot create another transition',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const commands=[f.command,{commandId:crypto.randomUUID(),expectedVersion:0}],results=await Promise.all(commands.map(c=>f.request('/ai-resumptions',c)));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);const accepted=commands[results.findIndex(r=>r.status===200)]!;
 const repeated=await Promise.all(Array.from({length:4},()=>f.request('/ai-resumptions',accepted)));assert.ok(repeated.every(r=>r.status===200));assert.equal((await f.call('read')).body.view.state.version,1);
 assert.equal(await f.db.prepare("SELECT count(*) n FROM conversation_control_event WHERE action='ai_listen'").first('n'),1);
});
