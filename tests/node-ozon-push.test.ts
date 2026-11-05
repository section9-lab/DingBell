import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {hashPassword} from 'better-auth/crypto';
import {createNodeApplication} from '../src/platform/node/application.ts';
import {encryptCredentials} from '../src/modules/stores/credentials.ts';
import {capabilityCodes} from '../src/modules/stores/ozon.ts';

test('the real local coordinator resumes a durable Push after restart and promptly delivers later live input without a cron tick',{timeout:60_000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'dingbell-node-push-'));
 const variables={APP_BASE_URL:'http://127.0.0.1:39417',BETTER_AUTH_SECRET:crypto.randomUUID()+crypto.randomUUID(),STORE_CREDENTIAL_ACTIVE_KEY:'v1',STORE_CREDENTIAL_KEYS:JSON.stringify({v1:Buffer.alloc(32,13).toString('base64')})};
 let messageId='104',createdAt=new Date().toISOString();const requests:string[]=[];
 const commerceFetch=(async(input,init)=>{const path=new URL(String(input)).pathname;requests.push(path);assert.equal(path,'/v3/chat/history');assert.equal(new Headers(init?.headers).get('Client-Id'),'123');assert.equal(new Headers(init?.headers).get('Api-Key'),'synthetic-push-key');return Response.json({has_next:false,messages:[{message_id:messageId,created_at:createdAt,user:{id:'4',type:'Customer'},data:[`Canonical local message ${messageId}`],is_image:false,is_read:false}]});}) as typeof fetch;
 const options={dataDirectory:directory,migrationsDirectory:resolve('migrations'),variables,commerceFetch};let app=await createNodeApplication(options);
 t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
 const db=app.database,now=Date.now(),password=crypto.randomUUID()+'Aa1!',envelope=await encryptCredentials(variables,{orgId:'org',storeId:'store',platformStoreId:'123',credentialVersion:1},{apiKey:'synthetic-push-key'});
 await db.batch([
  db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('org','Local Push','local-push',1)"),
  db.prepare("INSERT INTO user(id,name,email,email_verified) VALUES('user','Owner','owner@example.invalid',1)"),
  db.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password,updated_at) VALUES('account','user','credential','user',?,1)").bind(await hashPassword(password)),
  db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('owner','org','user','owner',1)"),
  db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,credential_key_version,credential_nonce,credential_ciphertext,checked_at,expires_at,capabilities,created_at,updated_at) VALUES('store','org','Local store','123','verified',?,?,?,?,?,?,1,1)").bind(envelope.keyVersion,envelope.nonce,envelope.ciphertext,now,now+86400000,JSON.stringify(capabilityCodes.map(code=>({code,status:'available',reason:'synthetic'})))),
  db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES('conversation','org','store','node-thread','BUYER_SELLER','Opened',1,1)"),
 ]);
 const request=(path:string,body:unknown,cookie='')=>app.fetch(new Request(new URL(path,variables.APP_BASE_URL),{method:'POST',headers:{origin:variables.APP_BASE_URL,cookie,'content-type':'application/json'},body:JSON.stringify(body)}));
 const login=await request('/api/auth/sign-in/email',{email:'owner@example.invalid',password});assert.equal(login.status,200);const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
 assert.equal((await request('/api/companies/org/stores/store/sync',{enabled:true,expectedEpoch:0},cookie)).status,200);
 const prepared=await request('/api/companies/org/stores/store/push',{operation:'prepare',expectedRevision:0,sellerId:'999'},cookie);assert.equal(prepared.status,200);const {push}=await prepared.json() as {push:{callbackUrl:string}};
 assert.equal((await request(push.callbackUrl,{message_type:'TYPE_PING'})).status,200);assert.equal((await request('/api/companies/org/stores/store/push',{operation:'activate',expectedRevision:1},cookie)).status,200);
 const body=()=>({message_type:'TYPE_NEW_MESSAGE',seller_id:'999',chat_type:'BUYER_SELLER',chat_id:'node-thread',message_id:messageId,created_at:createdAt});
 createdAt=new Date().toISOString();assert.equal((await request(push.callbackUrl,body())).status,200);await app.drain();assert.equal(requests.length,0,'the receiver does not synchronously call Ozon');
 await app.close();app=await createNodeApplication(options);await delay(30);await app.tick();
 async function delivered(id:string){for(let attempt=0;attempt<100;attempt++){const row=await app.database.prepare("SELECT e.processed_at AS processed FROM ingest_event e JOIN message m ON m.id=e.message_id WHERE m.platform_message_id=?").bind(id).first<{processed:number|null}>();if(row?.processed!==null&&row?.processed!==undefined)return;await delay(25);}assert.fail('Committed input was not delivered promptly.');}
 await delivered('104');assert.deepEqual(requests,['/v3/chat/history']);
 messageId='105';createdAt=new Date().toISOString();assert.equal((await request(push.callbackUrl,body())).status,200);await app.drain();await delay(1050);await app.tick();await delivered('105');
 assert.deepEqual(requests,['/v3/chat/history','/v3/chat/history']);assert.equal((await request(push.callbackUrl,body())).status,200);await app.drain();await app.tick();assert.equal(requests.length,2);
 const receipts=(await app.database.prepare("SELECT delivery_outcome AS outcome FROM ingest_event ORDER BY created_at").all<{outcome:string}>()).results;assert.deepEqual(receipts.map(row=>row.outcome),['accepted','accepted']);
});
