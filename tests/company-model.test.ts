import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationsFixture } from './fixtures/conversations.ts';
import { modelBaseUrl,openModelKey } from '../src/modules/company-model/security.ts';
import { readCompanyModel } from '../src/modules/company-model/storage.ts';
import { resolveSupportConfiguration,companySupportConfigurationView } from '../src/modules/company-model/runtime.ts';

const base='/api/companies/company/settings/ai-model';
const command={expectedVersion:0,baseUrl:'https://api.openai.com/v1',model:'synthetic-customer-model',apiKey:'synthetic-private-model-key',execution:null};
const prices={maxInputTokens:32768,maxOutputTokens:1024,inputMicrosPerMillion:200000,outputMicrosPerMillion:800000,cacheReadMicrosPerMillion:100000,cacheWriteMicrosPerMillion:200000};
function success(){const chunks=[{choices:[{index:0,delta:{tool_calls:[{index:0,id:'probe',type:'function',function:{name:'connection_probe',arguments:'{"ok":true}'}}]},finish_reason:'tool_calls'}]}, {choices:[],usage:{prompt_tokens:20,completion_tokens:8,total_tokens:28}}];return new Response(chunks.map(c=>`data: ${JSON.stringify(c)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}
async function fixture(fetcher:typeof fetch=async()=>{assert.fail('Unexpected provider call');}){
 const f=await conversationsFixture({modelFetch:fetcher});
 const env=Object.assign(f.env,{STORE_CREDENTIAL_KEYS:JSON.stringify({v1:Buffer.alloc(32,8).toString('base64')}),STORE_CREDENTIAL_ACTIVE_KEY:'v1'});
 const request=(suffix='',body?:unknown,actor='owner',origin=env.APP_BASE_URL)=>f.app.request(env.APP_BASE_URL+base+suffix,{method:body===undefined?'GET':'POST',headers:{cookie:f.cookies[actor]??'',origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},env as never);
 return {...f,env,request};
}
test('model URL policy rejects private destinations, ambiguous URLs, endpoints and arbitrary gateways',()=>{
 for(const value of ['http://api.openai.com/v1','https://127.0.0.1/v1','https://[::1]/v1','https://localhost/v1','https://secret.internal/v1','https://api.openai.com:444/v1',
  'https://user:key@api.openai.com/v1','https://api.openai.com/v1?key=secret','https://api.openai.com/v1#fragment','https://api.openai.com/v1/../v2',
  'https://api.openai.com/%76%31','https://api.openai.com/v1/chat/completions','https://api.openai.com.evil.invalid/v1','https://gateway.customer.com/v1'])assert.equal(modelBaseUrl(value,{}),null,value);
 assert.equal(modelBaseUrl('https://api.openai.com/v1/',{}),'https://api.openai.com/v1');
 assert.equal(modelBaseUrl('https://gateway.customer.com/v1',{AI_MODEL_ALLOWED_HOSTS:'gateway.customer.com'}),'https://gateway.customer.com/v1');
 assert.equal(modelBaseUrl('https://secret.internal/v1',{AI_MODEL_ALLOWED_HOSTS:'secret.internal'}),null);
});
test('company model settings encrypt secrets, preserve keys without returning them, audit and retain immutable revisions',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);
 const empty=await f.request();assert.equal(empty.status,200);assert.equal((await empty.json() as any).version,0);assert.equal(empty.headers.get('cache-control'),'no-store');
 const save=await f.request('',command);assert.equal(save.status,200,await save.clone().text());const data=await save.json() as any;
 assert.equal(data.version,1);assert.equal(data.hasKey,true);assert.equal(data.test,null);assert.equal(data.execution,null);assert.equal(JSON.stringify(data).includes(command.apiKey),false);
 const row=(await readCompanyModel(f.DB,'company'))!;assert.equal(row.ciphertext.includes(command.apiKey),false);
 assert.equal(await openModelKey(f.env,'company',1,row.baseUrl,row.model,row),command.apiKey);
 for(const company of ['other-company','company-x'])await assert.rejects(openModelKey(f.env,company,1,row.baseUrl,row.model,row));
 await assert.rejects(openModelKey(f.env,'company',2,row.baseUrl,row.model,row));
 const {apiKey:_key,...withoutKey}=command;
 const next=await f.request('',{...withoutKey,expectedVersion:1,model:'synthetic-next-model'});assert.equal(next.status,200);
 const saved=(await readCompanyModel(f.DB,'company'))!;assert.equal(saved.revision,2);assert.equal(await openModelKey(f.env,'company',2,saved.baseUrl,saved.model,saved),command.apiKey);
 assert.ok(await readCompanyModel(f.DB,'company',1));
 assert.equal((await f.request('',command)).status,409);
 await assert.rejects(f.DB.prepare("UPDATE company_ai_model_revision SET model='changed' WHERE organization_id='company'").run(),/COMPANY_AI_MODEL_IMMUTABLE/);
 const audit=await f.DB.prepare('SELECT * FROM company_ai_model_audit').all();assert.equal(audit.results.length,4);assert.equal(JSON.stringify(audit).includes(command.apiKey),false);
 assert.equal((await f.request('',{...withoutKey,expectedVersion:2,baseUrl:'https://api.deepseek.com/v1'})).status,400);
});
test('company model routes enforce current managers, verified sessions, origin and strict input without provider I/O',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);
 assert.equal((await f.request('',undefined,'anonymous')).status,401);
 assert.equal((await f.request('',undefined,'other')).status,404);
 assert.equal((await f.request('',undefined,'staff')).status,403);
 assert.equal((await f.request('',command,'staff')).status,403);
 assert.equal((await f.request('',command,'owner','https://untrusted.invalid')).status,403);
 for(const body of [{...command,extra:'no'},{...command,expectedVersion:-1},{...command,apiKey:''},{...command,model:''},{...command,execution:{...prices,outputMicrosPerMillion:-1}},{...command,execution:{...prices,maxInputTokens:1}}])assert.equal((await f.request('',body)).status,400);
 assert.equal((await f.request('?url=https://untrusted.invalid')).status,400);
 assert.equal((await f.request('',{...command,baseUrl:'https://untrusted.invalid/v1'})).status,400);
 const {apiKey:_key,...missing}=command;assert.equal((await f.request('',missing)).status,400);
 await f.DB.prepare("UPDATE user SET email_verified=0 WHERE id='owner'").run();assert.equal((await f.request('',command)).status,401);
 assert.equal(await f.DB.prepare('SELECT count(*) n FROM company_ai_model_revision').first('n'),0);
});
test('saved model connection tests are explicit, bounded, single-attempt and never leak upstream errors or keys',{timeout:30000},async t=>{
 let calls=0,fail=false;
 const f=await fixture(async(input,init)=>{calls++;assert.equal(String(input),'https://api.openai.com/v1/chat/completions');assert.equal(init?.redirect,'manual');assert.equal(new Headers(init?.headers).get('authorization'),`Bearer ${command.apiKey}`);
  const body=JSON.parse(String(init?.body));assert.equal(body.model,command.model);assert.equal(Object.hasOwn(body,'max_tokens'),false);assert.equal(body.stream,true);assert.equal(body.tools[0].function.name,'connection_probe');assert.equal(JSON.stringify(body).includes('Здравствуйте'),false);
  return fail?new Response('raw-secret-provider-error',{status:302,headers:{location:'http://127.0.0.1/'}}):success();});t.after(f.close);
 assert.equal((await f.request('',command)).status,200);assert.equal(calls,0);
 const probe=await f.request('/test',{expectedVersion:1});assert.equal(probe.status,200,await probe.clone().text());assert.equal((await probe.json() as any).test.status,'passed');assert.equal(calls,1);
 assert.equal((await f.request('/test',{expectedVersion:1})).status,429);assert.equal(calls,1);
 await f.DB.prepare('UPDATE company_ai_model_test SET next_test_at=0').run();fail=true;
 const result=await f.request('/test',{expectedVersion:1});assert.equal(result.status,200);const text=await result.text();assert.equal(JSON.parse(text).test.status,'failed');assert.equal(JSON.parse(text).test.failureCode,'redirect_refused');assert.equal(JSON.parse(text).test.providerStatus,302);assert.equal(text.includes('raw-secret-provider-error'),false);assert.equal(text.includes(command.apiKey),false);assert.equal(calls,2);
 assert.equal((await f.request('/test',{expectedVersion:2})).status,409);assert.equal(calls,2);
});
test('provider 403 diagnostics survive rereads and clear before the next explicit test',{timeout:30000},async t=>{
 let blocked=true,calls=0;
 const f=await fixture(async()=>{calls++;const pending=await f.DB.prepare('SELECT failure_code,provider_status,status FROM company_ai_model_test').first<any>();assert.equal(pending.status,'pending');assert.equal(pending.failure_code,null);assert.equal(pending.provider_status,null);return blocked?new Response('private-provider-details '+command.apiKey,{status:403}):success();});t.after(f.close);
 assert.equal((await f.request('',command)).status,200);
 let response=await f.request('/test',{expectedVersion:1});assert.equal(response.status,200);let result=await response.json() as any;assert.equal(result.test.status,'failed');assert.equal(result.test.failureCode,'forbidden');assert.equal(result.test.providerStatus,403);assert.equal(JSON.stringify(result).includes(command.apiKey),false);
 const reread=await(await f.request()).json() as any;assert.deepEqual(reread.test,result.test);
 assert.equal((await f.request('/test',{expectedVersion:1})).status,429);assert.equal(calls,1);
 await f.DB.prepare('UPDATE company_ai_model_test SET next_test_at=0').run();blocked=false;
 response=await f.request('/test',{expectedVersion:1});result=await response.json() as any;assert.equal(result.test.status,'passed');assert.equal(result.test.failureCode,null);assert.equal(result.test.providerStatus,200);assert.equal(calls,2);
});

test('audit loss prevents model changes and paid connection probes before provider I/O',{timeout:30000},async t=>{
 let calls=0;const f=await fixture(async()=>{calls++;return success();});t.after(f.close);
 const real=f.DB;
 f.env.DB=new Proxy(real,{get(target,property){if(property==='prepare')return(sql:string)=>{if(sql.includes('INSERT INTO company_ai_model_audit'))throw new Error('synthetic audit failure');return target.prepare(sql);};const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
 assert.equal((await f.request('',command)).status,503);assert.equal(await real.prepare('SELECT count(*) n FROM company_ai_model_revision').first('n'),0);
 f.env.DB=real;assert.equal((await f.request('',command)).status,200);
 const saved=(await readCompanyModel(real,'company'))!;
 f.env.DB=new Proxy(real,{get(target,property){if(property==='prepare')return(sql:string)=>{if(sql.includes('INSERT INTO company_ai_model_audit'))throw new Error('synthetic audit failure');return target.prepare(sql);};const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
 assert.equal((await f.request('/test',{expectedVersion:1})).status,503);assert.equal(calls,0);assert.equal((await readCompanyModel(real,'company'))?.revision,saved.revision);
});

test('model catalogs accept unsaved URL/key drafts, preserve saved secrets and never save or test a model',{timeout:30000},async t=>{
 let calls=0;
 const f=await fixture(async(input,init)=>{calls++;assert.equal(String(input),'https://api.openai.com/v1/models');assert.equal(init?.method,'GET');assert.equal(init?.redirect,'manual');assert.equal(new Headers(init?.headers).get('authorization'),`Bearer ${command.apiKey}`);return Response.json({data:[{id:'chat-b',name:'not-returned'},{id:'chat-a'},{id:'chat-a'}]});});t.after(f.close);
 const {model:_model,execution:_execution,...draft}=command;
 let response=await f.request('/models',draft);assert.equal(response.status,200,await response.clone().text());const catalog=await response.json() as any;
 assert.deepEqual(catalog,{companyId:'company',version:0,baseUrl:command.baseUrl,models:['chat-a','chat-b'],truncated:false});assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(JSON.stringify(catalog).includes(command.apiKey),false);
 assert.equal(await f.DB.prepare('SELECT COUNT(*) AS n FROM company_ai_model_revision').first('n'),0);assert.equal(await f.DB.prepare('SELECT COUNT(*) AS n FROM company_ai_model_test').first('n'),0);
 assert.equal((await f.request('/models',draft)).status,429);assert.equal(calls,1);
 assert.equal((await f.request('',command)).status,200);
 await f.DB.prepare("UPDATE rate_limit SET last_request=0 WHERE key LIKE 'dingbell:company-model:catalog:%'").run();
 response=await f.request('/models',{expectedVersion:1,baseUrl:command.baseUrl+'/'});assert.equal(response.status,200);assert.equal((await response.json() as any).version,1);assert.equal(calls,2);
 assert.equal((await readCompanyModel(f.DB,'company'))?.revision,1);assert.equal(await f.DB.prepare('SELECT COUNT(*) AS n FROM company_ai_model_test').first('n'),0);
 const limiter=await f.DB.prepare("SELECT * FROM rate_limit WHERE key LIKE 'dingbell:company-model:catalog:%'").all();assert.equal(JSON.stringify(limiter).includes(command.apiKey),false);
 assert.equal((await f.request('/models',{expectedVersion:1,baseUrl:'https://api.deepseek.com/v1'})).status,400);assert.equal(calls,2);
});

test('model catalog authorization, strict inputs and version guards fail before provider I/O',{timeout:30000},async t=>{
 let calls=0;const f=await fixture(async()=>{calls++;return Response.json({data:[]});});t.after(f.close);
 const draft={expectedVersion:0,baseUrl:command.baseUrl,apiKey:command.apiKey};
 for(const [who,status] of [['anonymous',401],['other',404],['staff',403]] as const)assert.equal((await f.request('/models',draft,who)).status,status);
 assert.equal((await f.request('/models',draft,'owner','https://untrusted.invalid')).status,403);
 for(const body of [{...draft,model:'not-accepted'},{...draft,expectedVersion:-1},{...draft,apiKey:''},{...draft,apiKey:'bad\nkey'},{...draft,baseUrl:'http://127.0.0.1/v1'},{...draft,baseUrl:'https://gateway.customer.com/v1'},{expectedVersion:0,baseUrl:command.baseUrl}])assert.equal((await f.request('/models',body)).status,400);
 assert.equal((await f.request('/models?url=other',draft)).status,400);assert.equal((await f.request('/models',{...draft,expectedVersion:1})).status,409);assert.equal(calls,0);
 await f.DB.prepare("UPDATE user SET email_verified=0 WHERE id='owner'").run();assert.equal((await f.request('/models',draft)).status,401);assert.equal(calls,0);
});

test('model catalog permits serialize concurrent requests and discard facts after access or configuration changes',{timeout:30000},async t=>{
 let calls=0,change:'none'|'revoke'|'revision'='none';
 const f=await fixture(async()=>{calls++;if(change==='revoke')await f.DB.prepare("UPDATE user SET email_verified=0 WHERE id='owner'").run();if(change==='revision')assert.equal((await f.request('',command)).status,200);return Response.json({data:[{id:'must-not-leak'}]});});t.after(f.close);
 const draft={expectedVersion:0,baseUrl:command.baseUrl,apiKey:command.apiKey};
 const responses=await Promise.all([f.request('/models',draft),f.request('/models',draft)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,429]);assert.equal(calls,1);
 await f.DB.prepare("UPDATE rate_limit SET last_request=0 WHERE key LIKE 'dingbell:company-model:catalog:%'").run();change='revoke';
 let response=await f.request('/models',draft);assert.equal(response.status,404);assert.equal((await response.text()).includes('must-not-leak'),false);
 await f.DB.prepare("UPDATE user SET email_verified=1 WHERE id='owner'").run();await f.DB.prepare("UPDATE rate_limit SET last_request=0 WHERE key LIKE 'dingbell:company-model:catalog:%'").run();change='revision';
 response=await f.request('/models',draft);assert.equal(response.status,409);assert.equal((await response.text()).includes('must-not-leak'),false);
});

test('company models require reviewed prices before new direct-reply execution',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);assert.equal((await f.request('',command)).status,200);
 const env=Object.assign(f.env,{AGENT_RUNTIME:{} as any,CONVERSATION_CONTROLLER:{} as any,AI_OUTBOUND_ENABLED:'true',OUTBOUND_ENABLED:'true'});
 assert.equal(await resolveSupportConfiguration(env,'company'),null);
 const unavailable=await companySupportConfigurationView(env,'company');
 assert.equal(unavailable.enabled,false);assert.equal(unavailable.pricesConfigured,false);assert.equal(unavailable.runReservationMicros,null);
 const result=await f.request('',{...command,expectedVersion:1,execution:{...prices,maxGenerations:2}});assert.equal(result.status,200);
 const cost=await resolveSupportConfiguration(env,'company');assert.ok(cost);assert.equal(cost.config.model.provider,'openai-compatible');assert.equal(cost.config.model.model,command.model);assert.equal(cost.config.model.connection?.revision,2);
 assert.equal(cost.config.model.promptVersion,'support-reply-v2');assert.equal(cost.config.maxGenerations,2);assert.ok(cost.total>0);assert.equal(JSON.stringify(cost).includes(command.apiKey),false);
 assert.equal((await companySupportConfigurationView(env,'company')).enabled,true);
 assert.equal(await resolveSupportConfiguration({...env,AGENT_RUNTIME:undefined},'company'),null);
 assert.equal((await f.request('',{...command,expectedVersion:2,execution:{...prices,maxGenerations:2}})).status,200);
 assert.equal((await resolveSupportConfiguration(env,'company'))?.config.model.promptVersion,'support-reply-v2');
 assert.equal((await resolveSupportConfiguration(env,'company'))?.config.maxGenerations,2);
});
