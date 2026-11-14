import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {URL} from 'node:url';
import {Miniflare} from 'miniflare';
import {listOzonFboPostings,readOzonFboPosting,OzonReadError} from '../src/modules/orders/ozon.ts';
import {encryptCredentials} from '../src/modules/stores/credentials.ts';
import {applyMigrations} from './fixtures/migrations.ts';
import {runSyncPage,retrySyncFailure} from '../src/modules/sync/runner.ts';
import {setSyncSourceEnabled,claimSyncLease} from '../src/modules/sync/storage.ts';
import {getDueFboWork,commitFboList} from '../src/modules/orders/storage.ts';

const credentials={clientId:'123456',apiKey:'synthetic-fbo-key'};
const window={since:'2026-10-01T00:00:00Z',to:'2026-10-08T00:00:00Z'};
const posting={posting_number:'12345-0001-1',order_id:'9000000000817031942',order_number:'12345-0001',status:'delivered',created_at:'2026-10-01T11:59:00Z',in_process_at:'2026-10-01T12:00:00Z',products:[{sku:'9000000000817031943',offer_id:'article',name:'FBO 商品',quantity:2,price:'123.4500',currency:'RUB'}]};
const page=(cursor:string|null=null)=>Response.json({postings:[posting],has_next:cursor!==null,cursor});
const scope={orgId:'org',storeId:'store'},actor={...scope,actorUserId:'admin',sessionId:'session'};
const folder=new URL('../migrations/',import.meta.url);
const files=readdirSync(folder).filter(name=>name.endsWith('.sql')).sort();

test('FBO v3 cursor lists and v2 details normalize only verified common facts',async()=>{
 const list=await listOzonFboPostings(credentials,{...window,cursor:'before'},async(input,init)=>{
  assert.equal(String(input),'https://api-seller.ozon.ru/v3/posting/fbo/list');
  assert.equal(init?.redirect,'manual');assert.deepEqual(JSON.parse(String(init?.body)),{filter:window,cursor:'before',limit:50});
  return page('after');
 });
 assert.equal(list.cursor,'after');assert.equal(list.postings[0].products[0].currency,'RUB');assert.equal(list.postings[0].createdAt,posting.created_at);assert.equal(list.postings[0].orderDate,null);
 const details=await readOzonFboPosting(credentials,{postingNumber:posting.posting_number},async(input,init)=>{
  assert.equal(String(input),'https://api-seller.ozon.ru/v2/posting/fbo/get');
  assert.deepEqual(JSON.parse(String(init?.body)),{posting_number:posting.posting_number,with:{financial_data:true}});
  return Response.json({result:{...posting,products:[{...posting.products[0],currency:undefined,currency_code:'RUB'}],shipment_date:'not a FBO field',customer:{phone:'DO_NOT_RETAIN'}}});
 });
 assert.deepEqual(details,list.postings[0]);assert.equal(details.shipmentDate,null);assert.equal(details.trackingNumber,null);
 assert.equal(JSON.stringify(details).includes('DO_NOT_RETAIN'),false);
 const numeric=await listOzonFboPostings(credentials,window,async()=>new Response(JSON.stringify({postings:[posting],has_next:false}).replace('"9000000000817031942"','9000000000817031942').replace('"9000000000817031943"','9000000000817031943')));
 assert.equal(numeric.postings[0].orderId,posting.order_id);assert.equal(numeric.postings[0].products[0].sku,posting.products[0].sku);
 for(const body of [{postings:[posting],has_next:true,cursor:'before'},{result:[posting]},{postings:[],has_next:true,cursor:'next'}])await assert.rejects(listOzonFboPostings(credentials,{...window,cursor:'before'},async()=>Response.json(body)),e=>e instanceof OzonReadError&&e.code==='invalid_response');
 await assert.rejects(readOzonFboPosting(credentials,{postingNumber:'other'},async()=>Response.json({result:posting})),e=>e instanceof OzonReadError&&e.code==='invalid_response');
 let calls=0;await assert.rejects(listOzonFboPostings(credentials,{...window,since:window.to},async()=>{calls++;return page();}));assert.equal(calls,0);
 assert.equal(retrySyncFailure({code:'permission_denied'},'fbo-list',0,0).code,'fbo_list_permission_denied');
 assert.equal(retrySyncFailure({code:'permission_denied'},'fbo-detail',0,0).disable,true);
});

test('order-center migration preserves populated sync authority, cursors and FBS facts with foreign keys enabled',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('PRAGMA foreign_keys=ON');for(const file of files.filter(name=>name<'0055'))db.exec(readFileSync(new URL(file,folder),'utf8'));
  db.exec(`INSERT INTO organization(id,name,slug,created_at) VALUES('org','Org','org',1);
   INSERT INTO store(id,organization_id,name,platform_store_id,created_at,updated_at) VALUES('store','org','Store','123',1,1);
   INSERT INTO store_coordinator(store_id,organization_id,fence,lease_source,lease_token,lease_until,blocked_until) VALUES('store','org',7,'chat','old',9999999999999,123456);
   INSERT INTO store_sync_source(store_id,organization_id,source,enabled,epoch,due_at,last_success_at,updated_at) VALUES('store','org','chat',1,3,100,50,1),('store','org','fbs_postings',1,5,200,90,1);
   INSERT INTO sync_cursor(organization_id,store_id,thread_id,stream,cursor,revision,due_at) VALUES('org','store','','discovery','saved-cursor',9,123);
   INSERT INTO fbs_posting(posting_number,organization_id,store_id,order_id,order_number,detail_epoch,detail_generation,detail_due_at) VALUES('same','org','store','1','order',5,2,123);`);
  const before=db.prepare('SELECT * FROM sync_cursor').get();
  db.exec(readFileSync(new URL('0055_order_center.sql',folder),'utf8'));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.deepEqual(db.prepare('SELECT * FROM sync_cursor').get(),before);
  const coordinator=db.prepare('SELECT * FROM store_coordinator').get()!;assert.equal(coordinator.fence,8);assert.equal(coordinator.lease_token,null);assert.equal(coordinator.blocked_until,123456);
  assert.equal(db.prepare("SELECT epoch FROM store_sync_source WHERE source='fbs_postings'").get()!.epoch,5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fbs_posting').get()!.n,1);
  db.exec("INSERT INTO store_sync_source(store_id,organization_id,source,enabled,epoch,due_at,updated_at) VALUES('store','org','fbo_postings',1,1,0,1)");
  db.exec("UPDATE store SET status='paused'");assert.equal(db.prepare('SELECT SUM(enabled) AS n FROM store_sync_source').get()!.n,0);
  db.exec("DELETE FROM store WHERE id='store'");assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_cursor').get()!.n,0);
 }finally{db.close();}
});

test('FBO durable sync uses independent windows, retries, permissions and source fencing on real D1',{timeout:60_000},async t=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("fbo")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});t.after(()=>mf.dispose());
 const db=await mf.getD1Database('DB') as unknown as D1Database;
 await applyMigrations(db,{files});
 const env={DB:db,STORE_CREDENTIAL_KEYS:JSON.stringify({v1:btoa('a'.repeat(32))}),STORE_CREDENTIAL_ACTIVE_KEY:'v1'};
 const secret=await encryptCredentials(env,{...scope,platformStoreId:credentials.clientId,credentialVersion:1},{apiKey:credentials.apiKey});
 await db.batch([
  db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('org','Org','org',1)"),
  db.prepare("INSERT INTO user(id,name,email,email_verified) VALUES('admin','Admin','fbo@example.invalid',1)"),
  db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('member','org','admin','admin',1)"),
  db.prepare("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('session','token','admin',?,1,1)").bind(Date.now()+3600000),
  db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,credential_key_version,credential_nonce,credential_ciphertext,capabilities,expires_at,created_at,updated_at) VALUES('store','org','Store','123456','verified',?,?,?,?,?,1,1)").bind(secret.keyVersion,secret.nonce,secret.ciphertext,JSON.stringify(['auth','orders_fbs_read','orders_fbo_read'].map(code=>({code,status:'available'}))),Date.now()+3600000),
 ]);
 assert.ok(await setSyncSourceEnabled(db,actor,'store','fbo_postings',0,true));
 assert.ok(await setSyncSourceEnabled(db,actor,'store','fbs_postings',0,true));
 const ready=()=>db.prepare("UPDATE store_sync_source SET due_at=CASE source WHEN 'fbo_postings' THEN 0 ELSE 9999999999999 END").run();
 const requests:{path:string;body:any}[]=[];
 const fetcher:typeof fetch=async(input,init)=>{const path=new URL(String(input)).pathname,body=JSON.parse(String(init?.body));requests.push({path,body});return path.endsWith('/list')?body.cursor?Response.json({postings:[],has_next:false}):page('second'):Response.json({result:{...posting,products:[{...posting.products[0],currency:undefined,currency_code:'RUB'}]}});};
 await ready();await runSyncPage(env,scope,{fetcher});await ready();await runSyncPage(env,scope,{fetcher});
 await db.prepare('UPDATE fbo_sync_window SET due_at=0').run();await ready();await runSyncPage(env,scope,{fetcher});
 const lists=requests.filter(r=>r.path.endsWith('/list'));assert.equal(lists.length,2);assert.deepEqual(lists[0].body.filter,lists[1].body.filter);assert.equal(lists[1].body.cursor,'second');
 const record=await db.prepare('SELECT * FROM fbo_posting').first<any>();assert.equal(record.detail_state,'complete');assert.equal(JSON.parse(record.detail_facts).products[0].currency,'RUB');assert.equal(JSON.parse(record.detail_facts).createdAt,posting.created_at);
 assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM fbs_posting').first('n'),0);
 const old=record.detail_facts;
 for(let index=0;index<3;index++){await db.prepare('UPDATE fbo_posting SET detail_due_at=0').run();await ready();await runSyncPage(env,scope,{fetcher:async()=>new Response('',{status:503})});}
 const failed=await db.prepare('SELECT detail_state,detail_attempt,detail_facts FROM fbo_posting').first<any>();assert.equal(failed.detail_state,'error');assert.equal(failed.detail_attempt,3);assert.equal(failed.detail_facts,old);
 assert.ok(await setSyncSourceEnabled(db,actor,'store','fbo_postings',1,false));assert.ok(await setSyncSourceEnabled(db,actor,'store','fbo_postings',2,true));
 assert.equal(await db.prepare('SELECT detail_state FROM fbo_posting').first('detail_state'),'pending');assert.equal(await db.prepare('SELECT cursor FROM fbo_sync_window').first('cursor'),null);
 await db.prepare("UPDATE fbo_sync_window SET state='active',due_at=0").run();await ready();
 const lease=await claimSyncLease(db,{...scope,source:'fbo_postings',token:crypto.randomUUID()});assert.ok(lease);const work=await getDueFboWork(db,lease);assert.equal(work?.kind,'list');
 await setSyncSourceEnabled(db,actor,'store','fbo_postings',3,false);
 if(work?.kind==='list')assert.equal(await commitFboList(db,lease,work,{postings:[],cursor:null,hasNext:false}),false);
 assert.ok(await setSyncSourceEnabled(db,actor,'store','fbo_postings',4,true));await db.prepare("UPDATE fbo_sync_window SET last_kind='details',due_at=0").run();await ready();await runSyncPage(env,scope,{fetcher:async()=>new Response('',{status:403})});
 const states=(await db.prepare('SELECT source,enabled,last_error FROM store_sync_source').all<any>()).results;
 assert.equal(states.find(s=>s.source==='fbo_postings').enabled,0);assert.equal(states.find(s=>s.source==='fbo_postings').last_error,'fbo_list_permission_denied');assert.equal(states.find(s=>s.source==='fbs_postings').enabled,1);
});
