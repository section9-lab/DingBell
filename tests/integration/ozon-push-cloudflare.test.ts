import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath,URL} from 'node:url';
import {Miniflare,Response as MFResponse} from 'miniflare';
import {encryptCredentials} from '../../src/modules/stores/credentials.ts';
import {capabilityCodes} from '../../src/modules/stores/ozon.ts';
import {newPushToken,sealPushSecret} from '../../src/modules/ozon-push/security.ts';

// Run after npm run build. No Vite dev fixture, real credentials or external Ozon calls.
test('compiled Cloudflare Push uses the real coordinator, preserves int64 and suppresses simulated automation',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../',import.meta.url)),directory=await mkdtemp(join(tmpdir(),'dingbell-compiled-push-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const at=Date.now(),thread=crypto.randomUUID(),endpoint=crypto.randomUUID(),token=newPushToken(),id='9223372036854775806',calls:string[]=[];
 const bindings={APP_BASE_URL:'http://127.0.0.1',STORE_CREDENTIAL_ACTIVE_KEY:'v1',STORE_CREDENTIAL_KEYS:JSON.stringify({v1:Buffer.alloc(32,14).toString('base64')}),OUTBOUND_ENABLED:'false',AI_OUTBOUND_ENABLED:'false',AI_RECEPTION_ENABLED:'false'};
 const workerDirectory=resolve(root,process.env.DINGBELL_TEST_DIST??'dist','dingbell');
 // Explicit modules also include the SDK's Node-only dynamic-import branches;
 // Miniflare's static scanner cannot infer those paths, even though CF never invokes them.
 const files=(await readdir(workerDirectory,{recursive:true})).filter(name=>name.endsWith('.js')).sort((a,b)=>a==='index.js'?-1:b==='index.js'?1:a.localeCompare(b));
 const modules=await Promise.all(files.map(async name=>({type:'ESModule' as const,path:join(workerDirectory,name),contents:await readFile(join(workerDirectory,name),'utf8')})));
 const options={modules,modulesRoot:workerDirectory,compatibilityDate:'2026-06-01',compatibilityFlags:['nodejs_compat'],bindings,
  d1Databases:{DB:'compiled-push'},d1Persist:join(directory,'d1'),
  durableObjects:{STORE_COORDINATOR:{className:'StoreCoordinator',useSQLite:true},CONVERSATION_CONTROLLER:{className:'ConversationController',useSQLite:true},PI_AGENT:{className:'PiAgentObject',useSQLite:true}},durableObjectsPersist:join(directory,'do'),
  outboundService:async (request:Request)=>{const url=new URL(request.url);calls.push(url.pathname);assert.equal(url.origin,'https://api-seller.ozon.ru');assert.equal(url.pathname,'/v3/chat/history');assert.equal(request.headers.get('Api-Key'),'synthetic-compiled-key');
   return new MFResponse(`{"has_next":false,"messages":[{"message_id":${id},"created_at":"${new Date(at).toISOString()}","user":{"id":"4","type":"Customer"},"data":["Compiled canonical source"],"is_image":false,"is_read":false}]}`,{headers:{'content-type':'application/json'}});},
 };
 const mf=new Miniflare(options);
 try{
  const db=await mf.getD1Database('DB');
  for(const name of(await readdir(join(root,'migrations'))).filter(name=>name.endsWith('.sql')).sort()){
   const statements=(await readFile(join(root,'migrations',name),'utf8')).split('--> statement-breakpoint').map(sql=>sql.trim()).filter(Boolean);
   await db.batch(statements.map(sql=>db.prepare(sql)));
  }
  const credentials=await encryptCredentials(bindings,{orgId:'org',storeId:'store',platformStoreId:'1',credentialVersion:1},{apiKey:'synthetic-compiled-key'});
  const secret=await sealPushSecret(bindings,'org','store',endpoint,1,token);
  await db.batch([
   db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('org','Synthetic','synthetic',1)"),
   db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at,credential_key_version,credential_nonce,credential_ciphertext,checked_at,expires_at,capabilities) VALUES('store','org','Synthetic','1','verified',1,1,?,?,?,?,?,?)").bind(credentials.keyVersion,credentials.nonce,credentials.ciphertext,at,at+3600000,JSON.stringify(capabilityCodes.map(code=>({code,status:'available',reason:'synthetic'})))),
   db.prepare("INSERT INTO store_coordinator(store_id,organization_id) VALUES('store','org')"),
   db.prepare("INSERT INTO store_sync_source(store_id,organization_id,source,enabled,epoch,credential_version,due_at,updated_at) VALUES('store','org','chat',1,1,1,?,?)").bind(at,at),
   db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES('conv','org','store',?,'BUYER_SELLER','Opened',?,?)").bind(thread,at,at),
   db.prepare("INSERT INTO store_push_endpoint(store_id,organization_id,endpoint_id,revision,generation,mode,seller_id,secret_hash,key_version,nonce,ciphertext,cutover_at,created_at,updated_at) VALUES('store','org',?,1,1,'active','1',?,?,?,?,?,?,?)").bind(endpoint,secret.secretHash,secret.keyVersion,secret.nonce,secret.ciphertext,at-100,at,at),
  ]);
  const url=`http://127.0.0.1/api/ozon/push/${endpoint}/${token}`;
  let response=await mf.dispatchFetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message_type:'TYPE_PING'})});
  assert.equal(response.status,200);assert.equal((await response.json() as {version:string}).version,'1');
  const body=JSON.stringify({message_type:'TYPE_NEW_MESSAGE',seller_id:'1',chat_id:thread,message_id:id,chat_type:'BUYER_SELLER',data:['Untrusted callback text']});
  const send=()=>mf.dispatchFetch(url,{method:'POST',headers:{'content-type':'application/json','X-DingBell-Local-Simulation':'1'},body});
  response=await send();assert.equal(response.status,200);
  const deadline=Date.now()+15000;let state:{state:string;last_error:string|null}|null=null;
  do{state=await db.prepare('SELECT state,last_error FROM ozon_push_event').first();if(state?.state==='completed')break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<deadline);
  assert.equal(state?.state,'completed',JSON.stringify(state));
  const message=await db.prepare('SELECT platform_message_id,content,ingest_mode FROM message').first<{platform_message_id:string;content:string;ingest_mode:string}>();assert.ok(message);
  assert.equal(message.platform_message_id,id);assert.match(message.content,/Compiled canonical source/);assert.doesNotMatch(message.content,/Untrusted callback/);assert.equal(message.ingest_mode,'backfill');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM ozon_push_live_message').first<{n:number}>())?.n,0);
  const health=await db.prepare('SELECT last_received_at,last_simulation_at FROM store_push_endpoint').first<{last_received_at:number|null;last_simulation_at:number}>();assert.equal(health?.last_received_at,null);assert.ok(health&&health.last_simulation_at>=at);
  assert.equal((await send()).status,200);await new Promise(resolve=>setTimeout(resolve,150));assert.deepEqual(calls,['/v3/chat/history']);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM ozon_push_event').first<{n:number}>())?.n,1);
  await mf.setOptions({...options,bindings:{...bindings,APP_BASE_URL:'https://public.example.invalid'}});
  assert.equal((await send()).status,403,'a public deployment must reject, not promote, a simulated request');
  const publicDb=await mf.getD1Database('DB');assert.equal((await publicDb.prepare('SELECT COUNT(*) AS n FROM ozon_push_event').first<{n:number}>())?.n,1);
  assert.deepEqual(calls,['/v3/chat/history']);
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
