import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { createNodeApplication as sourceApplication } from '../src/platform/node/application.ts';
import type { MailMessage } from '../src/modules/mail/types.ts';
import { ensureControlDirectory } from '../src/modules/conversations/control-storage.ts';
import { createTranslationBudget, setTranslationBudgetEnabled, reserveTranslation, readTranslationRun } from '../src/modules/translations/storage.ts';
import { submitReplyPreview, readReplyPreview } from '../src/modules/translations/service.ts';
import { setTimeout as delay } from 'node:timers/promises';

const createNodeApplication:typeof sourceApplication=process.env.DINGBELL_TEST_COMPILED==='true'
  ? (await import(new URL('../dist/node/server/application.mjs',import.meta.url).href) as {createNodeApplication:typeof sourceApplication}).createNodeApplication : sourceApplication;

test('Node application preserves real identity, tenant boundaries and transactional SQL after restart', { timeout: 30_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'dingbell-node-'));
  const options = { dataDirectory: directory, migrationsDirectory: resolve('migrations'), variables: {
    APP_BASE_URL: 'http://127.0.0.1:39417', BETTER_AUTH_SECRET: crypto.randomUUID()+crypto.randomUUID(),
    BOOTSTRAP_SECRET: crypto.randomUUID()+crypto.randomUUID(),
  } };
  let app = await createNodeApplication(options);
  context.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const request = (path: string, method = 'GET', body?: unknown, cookie = '') => app.fetch(new Request(new URL(path, options.variables.APP_BASE_URL), {
    method, headers: { origin: options.variables.APP_BASE_URL, cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  await assert.rejects(createNodeApplication(options), /DINGBELL_WRITER_ALREADY_RUNNING/);
  assert.equal((await request('/api/health')).status, 200);
  assert.equal((await request('/api/companies')).status, 401);
  assert.equal((await request('/api/bootstrap')).status, 200);
  const db = app.database, password = crypto.randomUUID()+'Aa1!';
  await db.batch([
    db.prepare("INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES('user','Fixture','fixture@example.invalid',1,1,1)"),
    db.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES('account','user','credential','user',?,1,1)").bind(await hashPassword(password)),
    db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('org','Fixture','fixture',1),('other','Other','other',1)"),
    db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('owner','org','user','owner',1)"),
  ]);
  // The duplicate fails after a first write; a partial batch must not survive.
  await assert.rejects(db.batch([
    db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('rollback','Rollback','rollback',1)"),
    db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('org','Duplicate','duplicate',1)"),
  ]));
  assert.equal(await db.prepare("SELECT id FROM organization WHERE id='rollback'").first(), null);
  const login = await request('/api/auth/sign-in/email', 'POST', { email: 'fixture@example.invalid', password });
  assert.equal(login.status, 200, await login.clone().text());
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie.includes('session_token='));
  const companies = await request('/api/companies', 'GET', undefined, cookie);
  assert.equal(companies.status, 200);
  assert.deepEqual((await companies.json() as { companies: { id: string }[] }).companies.map(value => value.id), ['org']);
  assert.equal((await request('/api/companies/other/settings', 'GET', undefined, cookie)).status, 404);
  const settings = await request('/api/companies/org/settings', 'GET', undefined, cookie);
  assert.equal(settings.status, 200);
  const current = await settings.json() as { version: number };
  const saved = await request('/api/companies/org/settings', 'POST', { expectedVersion: current.version, timeZone: 'Asia/Shanghai' }, cookie);
  assert.equal(saved.status, 200, await saved.clone().text()); const expected = await saved.json();
  await app.tick(); await app.close(); app = await createNodeApplication(options);
  assert.deepEqual(await (await request('/api/companies/org/settings', 'GET', undefined, cookie)).json(), expected);
  assert.equal((await request('/api/companies/other/settings', 'GET', undefined, cookie)).status, 404);
});

test('Node first-owner installation uses public verification and survives a resumed setup', { timeout: 30_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(),'dingbell-node-owner-')), mails: MailMessage[] = [];
  const variables = { APP_BASE_URL: 'http://127.0.0.1:39417', BETTER_AUTH_SECRET: crypto.randomUUID()+crypto.randomUUID(), BOOTSTRAP_SECRET: crypto.randomUUID()+crypto.randomUUID() };
  const app = await createNodeApplication({ dataDirectory:directory,migrationsDirectory:resolve('migrations'),variables,dependencies:{ mailer:async mail => { mails.push(mail); return {id:'synthetic'}; } } });
  context.after(async () => { await app.close(); await rm(directory,{recursive:true,force:true}); });
  const request = (path:string,body:unknown,privileged=false) => app.fetch(new Request(new URL(path,variables.APP_BASE_URL),{method:'POST',headers:{origin:variables.APP_BASE_URL,'content-type':'application/json',...(privileged?{authorization:`Bearer ${variables.BOOTSTRAP_SECRET}`}:{})},body:JSON.stringify(body)}));
  const claim={claimId:crypto.randomUUID(),email:'owner@example.invalid',name:'Owner',organizationName:'Portable company'}, password=crypto.randomUUID()+'Aa1!';
  assert.equal((await request('/api/bootstrap/claim',claim,true)).status,201);
  assert.equal((await request('/api/bootstrap/resume',{claimId:claim.claimId,password},true)).status,202);
  assert.equal(mails.length,1);
  const link=mails[0]!.text.match(/https?:\/\/\S+/)?.[0]; assert.ok(link);
  const token=new URLSearchParams(new URL(link).hash.slice(1)).get('token'); assert.ok(token);
  assert.equal((await request('/api/auth/verify-email',{token})).status,200);
  const completed=await request('/api/bootstrap/resume',{claimId:claim.claimId,password},true);
  assert.equal(completed.status,200,await completed.clone().text());
  assert.equal((await app.database.prepare("SELECT role FROM member").first<{role:string}>())?.role,'owner');
  assert.equal((await request('/api/bootstrap/resume',{claimId:claim.claimId,password},true)).status,410);
  assert.equal((await request('/api/auth/sign-in/email',{email:claim.email,password})).status,200);
});

test('Node Pi translation preserves original receipt and settles the original budget without repeated provider calls', { timeout:30_000 }, async context => {
  const directory=await mkdtemp(join(tmpdir(),'dingbell-node-pi-'));
  let calls=0;
  const config={provider:'nvidia' as const,model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'nvidia-nemotron-super-v1',promptVersion:'ru-translation-v1',maxInputTokens:262144,maxOutputTokens:512,
    pricing:{version:'synthetic',currency:'USD' as const,inputMicrosPerMillion:100,outputMicrosPerMillion:200,cacheReadMicrosPerMillion:50,cacheWriteMicrosPerMillion:100}};
  const options={dataDirectory:directory,migrationsDirectory:resolve('migrations'),variables:{TRANSLATION_ENABLED:'true',NVAPI_KEY:'synthetic-never-real',TRANSLATION_CONFIG_JSON:JSON.stringify(config)},
    providerFetch:async(input: Parameters<typeof fetch>[0],init?:RequestInit)=>{
      assert.equal(String(input),'https://integrate.api.nvidia.com/v1/chat/completions');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic-never-real');calls++;
      const records=[{id:'synthetic',object:'chat.completion.chunk',created:1,model:config.model,choices:[{index:0,delta:{role:'assistant',content:'Здравствуйте!'},finish_reason:'stop'}]},
        {choices:[],usage:{prompt_tokens:12,completion_tokens:4,total_tokens:16}}];
      return new Response(records.map(item=>`data: ${JSON.stringify(item)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    }};
  let app=await createNodeApplication(options);context.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const db=app.database;
  db.sqlite.exec(`INSERT INTO organization(id,name,slug,created_at) VALUES('org','Org','org',1);
    INSERT INTO user(id,name,email,email_verified) VALUES('owner','Owner','owner@example.invalid',1);
    INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('owner-member','org','owner','owner',1);
    INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('owner-session','token','owner',${Date.now()+3600000},1,1);
    INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES('store','org','Store','1','verified',1,1);
    INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES('conv','org','store','thread','BUYER_SELLER','Opened',1,1);`);
  const actor={orgId:'org',actorUserId:'owner',sessionId:'owner-session'};
  const scope=(await ensureControlDirectory(db,actor,'conv',Date.now()))!.scope;
  const controller=app.env.CONVERSATION_CONTROLLER!.getByName(scope.controllerId);
  assert.equal((await controller.execute(scope,actor,{commandId:crypto.randomUUID(),action:'claim',expectedVersion:0})).outcome,'accepted');
  await createTranslationBudget(db,actor,{id:'budget',startsAt:Date.now()-1000,endsAt:Date.now()+3600000,limitMicros:1000000});
  await setTranslationBudgetEnabled(db,actor,'budget',0,true);
  const input={requestId:crypto.randomUUID(),source:'你好',sourceRevision:1},target={conversationId:'conv',expectedMemberId:'owner-member'};
  const native=app.env.AGENT_RUNTIME!.translation, originalPrepare=native.prepare, originalDispatch=native.dispatch;
  let executionError:unknown;
  native.prepare=async(...args)=>{try{return await originalPrepare(...args);}catch(error){executionError=error;throw error;}};
  native.dispatch=async(...args)=>{try{return await originalDispatch(...args);}catch(error){executionError=error;throw error;}};
  let result=await submitReplyPreview(app.env,actor,target,input);
  assert.ifError(executionError);
  const deadline=Date.now()+10000;
  while(result.outcome==='found'&&['pending','unconfirmed'].includes(result.preview.status)&&Date.now()<deadline){await delay(30);result=await readReplyPreview(app.env,actor,target,input.requestId);}
  assert.equal(result.outcome,'found',JSON.stringify(result));
  if(result.outcome==='found'){assert.equal(result.preview.status,'ready',JSON.stringify(result));assert.equal(result.preview.translation,'Здравствуйте!');assert.equal(result.preview.usageStatus,'settled');}
  assert.equal(calls,1);
  const before=await readTranslationRun(db,actor,{...target,requestId:input.requestId,storeId:'store'});assert.ok(before);assert.ok(before.receipt?.uid.startsWith('pi_'));
  await app.close();app=await createNodeApplication(options);
  const replay=await submitReplyPreview(app.env,actor,target,input);assert.deepEqual(replay,result);assert.equal(calls,1);
  const after=await readTranslationRun(app.database,actor,{...target,requestId:input.requestId,storeId:'store'});assert.deepEqual(after?.receipt,before.receipt);
  const conflict=await submitReplyPreview(app.env,actor,target,{...input,source:'different'});assert.equal(conflict.outcome,'conflict');assert.equal(calls,1);
});

for(const mode of ['sent','unknown'] as const)test(`Node sender preserves a ${mode} outcome across concurrent replay and process restart`,{timeout:30000},async context=>{
 const {encryptCredentials}=await import('../src/modules/stores/credentials.ts');
 const directory=await mkdtemp(join(tmpdir(),'dingbell-node-send-'));let calls=0;
 const variables={OUTBOUND_ENABLED:'true',STORE_CREDENTIAL_ACTIVE_KEY:'test',STORE_CREDENTIAL_KEYS:JSON.stringify({test:btoa('t'.repeat(32))})};
 const options={dataDirectory:directory,migrationsDirectory:resolve('migrations'),variables,commerceFetch:async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  calls++;assert.equal(String(input),'https://api-seller.ozon.ru/v1/chat/send/message');assert.equal(new Headers(init?.headers).get('api-key'),'synthetic-api-key');assert.deepEqual(JSON.parse(String(init?.body)),{chat_id:'thread',text:'Здравствуйте!'});
  if(mode==='unknown')throw new Error('Synthetic lost provider acknowledgement');return Response.json({result:'success'});
 }};
 let app=await createNodeApplication(options);context.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
 app.database.sqlite.exec(`INSERT INTO organization(id,name,slug,created_at) VALUES('org','Org','org',1);
 INSERT INTO user(id,name,email,email_verified) VALUES('owner','Owner','owner@example.invalid',1);
 INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('owner-member','org','owner','owner',1);
 INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('owner-session','token','owner',${Date.now()+3600000},1,1);
 INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES('store','org','Store','1','verified',1,1);
 INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES('conv','org','store','thread','BUYER_SELLER','Opened',1,1);`);
 const envelope=await encryptCredentials(variables,{orgId:'org',storeId:'store',platformStoreId:'1',credentialVersion:1},{apiKey:'synthetic-api-key'});
 await app.database.prepare("UPDATE store SET outbound_enabled=1,credential_key_version=?,credential_nonce=?,credential_ciphertext=?,capabilities=?,checked_at=?,expires_at=? WHERE id='store'").bind(envelope.keyVersion,envelope.nonce,envelope.ciphertext,JSON.stringify([{code:'auth',status:'available'},{code:'reply',status:'available'}]),Date.now(),Date.now()+3600000).run();
 const actor={orgId:'org',actorUserId:'owner',sessionId:'owner-session',expectedMemberId:'owner-member'},scope=(await ensureControlDirectory(app.database,actor,'conv',Date.now()))!.scope;
 let controller=app.env.CONVERSATION_CONTROLLER!.getByName(scope.controllerId);
 assert.equal((await controller.execute(scope,actor,{commandId:crypto.randomUUID(),action:'claim',expectedVersion:0})).outcome,'accepted');
 const command={commandId:crypto.randomUUID(),action:'send_reply' as const,expectedVersion:1,body:'Здравствуйте!'};
 const results=await Promise.all(Array.from({length:6},()=>controller.execute(scope,actor,command)));for(const result of results)assert.equal(result.outcome,'accepted',JSON.stringify(result));
 const until=Date.now()+12000;let saved=await controller.readReply(scope,actor,command.commandId);
 while(saved.outcome==='found'&&['queued','sending'].includes(saved.reply.status)&&Date.now()<until){await app.tick();await delay(30);saved=await controller.readReply(scope,actor,command.commandId);}
 assert.equal(saved.outcome,'found');if(saved.outcome==='found')assert.equal(saved.reply.status,mode,JSON.stringify(saved));assert.equal(calls,1);
 await app.close();app=await createNodeApplication(options);controller=app.env.CONVERSATION_CONTROLLER!.getByName(scope.controllerId);
 await controller.execute(scope,actor,command);await app.tick();assert.equal(calls,1);assert.deepEqual(await controller.readReply(scope,actor,command.commandId),saved);
});
