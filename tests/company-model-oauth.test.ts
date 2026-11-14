import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {conversationsFixture} from './fixtures/conversations.ts';
import {readCompanyCredential} from '../src/modules/company-model/storage.ts';
import {resolveSupportConfiguration,frozenCompanyProvider} from '../src/modules/company-model/runtime.ts';

const base='/api/companies/company/settings/ai-model';
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const sse=(choice:unknown)=>new Response(`data: ${JSON.stringify({choices:[choice]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
const probeChoice={index:0,delta:{tool_calls:[{index:0,id:'probe',type:'function',function:{name:'connection_probe',arguments:'{"ok":true}'}}]},finish_reason:'tool_calls'};
async function fixture(send:typeof fetch){
 const f=await conversationsFixture({modelFetch:send});
 Object.assign(f.env,{STORE_CREDENTIAL_KEYS:JSON.stringify({v1:Buffer.alloc(32,10).toString('base64')}),STORE_CREDENTIAL_ACTIVE_KEY:'v1',AGENT_RUNTIME:{}});
 const request=(suffix='',body?:unknown,actor='owner')=>f.app.request(f.env.APP_BASE_URL+base+suffix,{method:body===undefined?'GET':'POST',
  headers:{cookie:f.cookies[actor]??'',origin:f.env.APP_BASE_URL,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},f.env as never);
 return {...f,request};
}
function kimiFetch(state:{pending:boolean;refresh?:boolean;chats:number}){
 return async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input);
  if(url==='https://auth.kimi.com/api/oauth/device_authorization')return json({device_code:'synthetic-device-code',user_code:'KIMI-CODE',
   verification_uri:'https://kimi.example/device',verification_uri_complete:'https://kimi.example/device?code=1',expires_in:600,interval:1});
  if(url==='https://auth.kimi.com/api/oauth/token'){
   const body=new URLSearchParams(String(init?.body));
   if(body.get('grant_type')==='refresh_token'){state.refresh=true;return json({access_token:'kimi-refreshed-access',refresh_token:'kimi-refreshed-refresh',expires_in:3600});}
   if(state.pending){state.pending=false;return json({error:'authorization_pending'},400);}
   return json({access_token:'kimi-access-token',refresh_token:'kimi-refresh-token',expires_in:1});
  }
  if(url==='https://api.kimi.com/coding/v1/chat/completions'){
   state.chats++;assert.equal(new Headers(init?.headers).get('authorization'),`Bearer ${state.refresh?'kimi-refreshed-access':'kimi-access-token'}`);
   return sse(probeChoice);
  }
  assert.fail(`unexpected provider request: ${url}`);
 };
}
test('kimi device login stores an encrypted OAuth credential and never returns tokens to the browser',{timeout:30000},async t=>{
 const state={pending:true,chats:0,refresh:false},f=await fixture(kimiFetch(state) as typeof fetch);t.after(f.close);
 const started=await f.request('/oauth/start',{provider:'kimi-coding'});assert.equal(started.status,200,await started.clone().text());
 const session=await started.json() as any;assert.equal(session.status,'pending');assert.equal(session.userCode,'KIMI-CODE');assert.equal(session.provider,'kimi-coding');
 assert.equal(JSON.stringify(session).includes('synthetic-device-code'),false);
 assert.equal(await f.DB.prepare('SELECT count(*) n FROM company_ai_model_auth_session').first('n'),1);
 assert.equal(JSON.stringify(await f.DB.prepare('SELECT * FROM company_ai_model_auth_session').all()).includes('synthetic-device-code'),false);
 await f.DB.prepare('UPDATE company_ai_model_auth_session SET next_poll_at=0').run();
 const waiting=await f.request('/oauth/'+session.sessionId);assert.equal(waiting.status,200);assert.equal((await waiting.json() as any).status,'pending');
 await f.DB.prepare('UPDATE company_ai_model_auth_session SET next_poll_at=0').run();
 const complete=await f.request('/oauth/'+session.sessionId);assert.equal(complete.status,200);const done=await complete.json() as any;
 assert.equal(done.status,'complete');assert.equal(JSON.stringify(done).includes('kimi-access-token'),false);assert.equal(JSON.stringify(done).includes('kimi-refresh-token'),false);
 const row=await readCompanyCredential(f.DB,'company','kimi-coding');assert.ok(row);assert.equal(row.authType,'oauth');assert.equal(row.ciphertext.includes('kimi-access-token'),false);
 assert.equal(row.expiresAt! > Date.now(),true);
});
test('oauth model revisions save without an API key and resolve a refreshable bearer token',{timeout:30000},async t=>{
 const state={pending:false,chats:0,refresh:false},f=await fixture(kimiFetch(state) as typeof fetch);t.after(f.close);
 const command={expectedVersion:0,provider:'kimi-coding',baseUrl:'https://api.kimi.com/coding/v1',model:'kimi-for-coding',authType:'oauth' as const,execution:null};
 const missing=await f.request('',command);assert.equal(missing.status,400);
 assert.equal((await missing.json() as any).error.code,'OAUTH_LOGIN_REQUIRED');
 const started=await f.request('/oauth/start',{provider:'kimi-coding'});const session=await started.json() as any;
 await f.DB.prepare('UPDATE company_ai_model_auth_session SET next_poll_at=0').run();
 assert.equal((await(await f.request('/oauth/'+session.sessionId)).json() as any).status,'complete');
 const saved=await f.request('',command);assert.equal(saved.status,200,await saved.clone().text());
 const view=await saved.json() as any;assert.equal(view.authType,'oauth');assert.equal(view.hasKey,true);assert.equal(JSON.stringify(view).includes('kimi-access-token'),false);
 const config=await resolveSupportConfiguration(f.env,'company');assert.ok(config);assert.equal(config.config.model.provider,'openai-compatible');
 const provider=await frozenCompanyProvider(f.env,config.config.model,'company','synthetic-session',kimiFetch(state) as typeof fetch);
 assert.equal(provider.apiKey,'kimi-refreshed-access');assert.equal(provider.endpoint,'https://api.kimi.com/coding/v1/chat/completions');assert.equal(state.refresh,true);
 const tested=await f.request('/test',{expectedVersion:1});assert.equal(tested.status,200,await tested.clone().text());
 assert.equal((await tested.json() as any).test.status,'passed');assert.equal(state.chats,1);
});
test('oauth login requires a current manager and cannot be started by another company',{timeout:30000},async t=>{
 const state={pending:false,chats:0,refresh:false},f=await fixture(kimiFetch(state) as typeof fetch);t.after(f.close);
 const staff=await f.request('/oauth/start',{provider:'kimi-coding'},'staff');assert.equal(staff.status,403);
 const other=await f.request('/oauth/start',{provider:'kimi-coding'},'other');assert.equal(other.status,404);
});
test('oauth session polling is bounded by the provider interval and expiry',{timeout:30000},async t=>{
 const state={pending:true,chats:0,refresh:false},f=await fixture(kimiFetch(state) as typeof fetch);t.after(f.close);
 const started=await f.request('/oauth/start',{provider:'kimi-coding'});const session=await started.json() as any;
 const early=await f.request('/oauth/'+session.sessionId);assert.equal((await early.json() as any).status,'pending');
 await f.DB.prepare('UPDATE company_ai_model_auth_session SET expires_at=0,next_poll_at=0').run();
 const expired=await f.request('/oauth/'+session.sessionId);assert.equal((await expired.json() as any).status,'expired');
 await delay(5);
});
