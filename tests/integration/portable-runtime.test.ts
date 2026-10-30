import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Miniflare, Response as MFResponse } from 'miniflare';
import { hashPassword } from 'better-auth/crypto';
import { createTranslationBudget, setTranslationBudgetEnabled } from '../../src/modules/translations/storage.ts';

test('production Cloudflare Pi adapter executes translation and settles its original receipt exactly once', {timeout:90000},async context=>{
 const directory=await mkdtemp(join(tmpdir(),'dingbell-production-pi-'));let calls=0;
 const config={provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'nvidia-nemotron-super-v1',promptVersion:'ru-translation-v1',maxInputTokens:262144,maxOutputTokens:512,pricing:{version:'synthetic',currency:'USD',inputMicrosPerMillion:100,outputMicrosPerMillion:200,cacheReadMicrosPerMillion:50,cacheWriteMicrosPerMillion:100}};
 const built=JSON.parse(await readFile('dist/dingbell/wrangler.json','utf8')) as {main:string};
 const modules=await Promise.all((await readdir('dist/dingbell',{recursive:true})).filter(file=>file.endsWith('.js')).map(async file=>({type:'ESModule' as const,path:resolve('dist/dingbell',file),contents:await readFile(resolve('dist/dingbell',file),'utf8')})));
 modules.sort((a,b)=>Number(b.path===resolve('dist/dingbell',built.main))-Number(a.path===resolve('dist/dingbell',built.main)));
 const mf=new Miniflare({modules,modulesRoot:resolve('dist/dingbell'),compatibilityDate:'2026-06-01',compatibilityFlags:['nodejs_compat'],
  bindings:{APP_BASE_URL:'http://localhost',BETTER_AUTH_SECRET:crypto.randomUUID()+crypto.randomUUID(),TRANSLATION_ENABLED:'true',TRANSLATION_CONFIG_JSON:JSON.stringify(config),NVAPI_KEY:'synthetic-never-real'},
  d1Databases:{DB:'portable-runtime'},d1Persist:join(directory,'d1'),durableObjectsPersist:join(directory,'objects'),
  durableObjects:{PI_AGENT:{className:'PiAgentObject',useSQLite:true},CONVERSATION_CONTROLLER:{className:'ConversationController',useSQLite:true},STORE_COORDINATOR:{className:'StoreCoordinator',useSQLite:true}},
  outboundService:async (request:Request)=>{
   assert.equal(request.url,'https://integrate.api.nvidia.com/v1/chat/completions');assert.equal(request.headers.get('authorization'),'Bearer synthetic-never-real');calls++;
   return new MFResponse('data: '+JSON.stringify({id:'synthetic',object:'chat.completion.chunk',created:1,model:config.model,choices:[{index:0,delta:{role:'assistant',content:'Здравствуйте!'},finish_reason:'stop'}]})+'\n\ndata: '+JSON.stringify({choices:[],usage:{prompt_tokens:12,completion_tokens:4,total_tokens:16}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  },
 });
 context.after(async()=>{await mf.dispose();await rm(directory,{recursive:true,force:true});});
 const db=await mf.getD1Database('DB') as unknown as D1Database;
 for(const name of (await readdir('migrations')).filter(name=>name.endsWith('.sql')).sort()){
  for(const statement of (await readFile(join('migrations',name),'utf8')).split('--> statement-breakpoint').filter(value=>value.trim()))await db.prepare(statement).run();
 }
 const password=crypto.randomUUID()+'Aa1!',now=Date.now();
 await db.batch([
  db.prepare("INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES('owner','Owner','owner@example.invalid',1,1,1)"),
  db.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES('account','owner','credential','owner',?,1,1)").bind(await hashPassword(password)),
  db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('org','Org','org',1)"),
  db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('owner-member','org','owner','owner',1)"),
  db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES('store','org','Store','1','verified',1,1)"),
  db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES('conv','org','store','thread','BUYER_SELLER','Opened',1,1)"),
 ]);
 let cookie='';
 const request=(path:string,method='GET',body?:unknown)=>mf.dispatchFetch('http://localhost'+path,{method,headers:{origin:'http://localhost',cookie,'x-dingbell-member-id':'owner-member',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const login=await request('/api/auth/sign-in/email','POST',{email:'owner@example.invalid',password});assert.equal(login.status,200,await login.clone().text());cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
 const session=await db.prepare("SELECT id FROM session WHERE user_id='owner'").first<{id:string}>();assert.ok(session);
 const actor={orgId:'org',actorUserId:'owner',sessionId:session.id};
 assert.equal((await request('/api/companies/org/conversations/conv/commands','POST',{commandId:crypto.randomUUID(),action:'claim',expectedVersion:0})).status,200);
 await createTranslationBudget(db,actor,{id:'budget',startsAt:now-1000,endsAt:now+3600000,limitMicros:1000000});await setTranslationBudgetEnabled(db,actor,'budget',0,true);
 const path='/api/companies/org/conversations/conv/reply-previews',input={requestId:crypto.randomUUID(),source:'你好',sourceRevision:1};
 let response=await request(path,'POST',input);assert.equal(response.status,200,await response.clone().text());
 let body=await response.json() as {preview:{status:string;translation:string;usageStatus:string}};
 const until=Date.now()+15000;while(body.preview.status!=='ready'&&Date.now()<until){await delay(100);response=await request(path+'/'+input.requestId);assert.equal(response.status,200,await response.clone().text());body=await response.json() as typeof body;}

 assert.equal(body.preview.status,'ready',JSON.stringify(body));assert.equal(body.preview.translation,'Здравствуйте!');assert.equal(body.preview.usageStatus,'settled');assert.equal(calls,1);
 assert.deepEqual(await(await request(path,'POST',input)).json(),body);assert.equal(calls,1);
 assert.equal((await request(path,'POST',{...input,source:'changed'})).status,409);assert.equal(calls,1);
 assert.equal((await request('/agents/pi/raw')).status,404);assert.equal((await request('/__internal/authority','POST',{})).status,404);
});
