import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readdirSync,readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {URL} from 'node:url';
import {hashPassword} from 'better-auth/crypto';
import {SqliteDatabase,migrateSqlite} from '../src/platform/node/database.ts';
import {createApp} from '../src/application.ts';
import {services} from '../src/modules/identity/services.ts';
import {encryptCredentials} from '../src/modules/stores/credentials.ts';
import {capabilityCodes,inspectOzonCapabilities} from '../src/modules/stores/ozon.ts';
import {storeDTO} from '../src/modules/stores/http.ts';
import {findStore} from '../src/modules/stores/storage.ts';
import {listOzonFbpPostings,readOzonFbpPosting,OzonReadError} from '../src/modules/orders/ozon.ts';
import {getDueFbpWork,commitFbpList} from '../src/modules/orders/storage.ts';
import {changePostingHistory,readPostingHistory} from '../src/modules/orders/history.ts';
import {claimSyncLease,setSyncSourceEnabled} from '../src/modules/sync/storage.ts';
import {runSyncPage,retrySyncFailure} from '../src/modules/sync/runner.ts';
import {listOrderPostings,readOrderPosting} from '../src/modules/commerce/storage.ts';
const credentials={clientId:'123456',apiKey:'synthetic-fbp-key'},scope={orgId:'org',storeId:'store'},actor={orgId:'org',actorUserId:'owner',sessionId:'session'};
const filter={since:'2026-10-01T00:00:00Z',to:'2026-10-08T00:00:00Z'};
const packet={posting_number:'FBP-1',order_id:'9000000000817031942',order_number:'FBP-order',status:'delivered',order_date:'2026-10-02T09:00:00Z',in_process_at:'2026-10-02T10:00:00Z',products:[{sku:'9000000000817031943',offer_id:'partner-article',name:'合作仓商品',quantity:2,price:{amount:'00012.3400',currency:'RUB'}}]};
const detail={...packet,status:7,substatus:'provider_specific_substatus',products:[{...packet.products[0],price:undefined,marketplace_seller_price:{amount:'12.34567890',currency:'RUB'}}]};
const allCaps=()=>capabilityCodes.map(code=>({code,status:['reply','proactive_chat'].includes(code)?'unknown':'available',reason:'read_verified'}));
async function fixture(){
 const db=new SqliteDatabase(':memory:');await migrateSqlite(db,'migrations');let wakes=0;
 const env={DB:db,APP_BASE_URL:'https://fbp.example.invalid',BETTER_AUTH_SECRET:'synthetic-fbp-auth-secret-at-least-thirty-two',STORE_CREDENTIAL_KEYS:JSON.stringify({test:btoa('f'.repeat(32))}),STORE_CREDENTIAL_ACTIVE_KEY:'test',STORE_COORDINATOR:{getByName:()=>({wake:async()=>{wakes++;}})} as never};
 const encrypted=await encryptCredentials(env,{...scope,platformStoreId:credentials.clientId,credentialVersion:1},{apiKey:credentials.apiKey});
 await db.batch([
 db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('org','Org','org',1)"),
 db.prepare("INSERT INTO user(id,name,email,email_verified) VALUES('owner','Owner','owner@fbp.invalid',1),('staff','Staff','staff@fbp.invalid',1)"),
 db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('owner-member','org','owner','owner',1),('staff-member','org','staff','member',1)"),
 db.prepare("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('session','token','owner',?,1,1)").bind(Date.now()+3600000),
 db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,credential_key_version,credential_nonce,credential_ciphertext,capabilities,expires_at,created_at,updated_at) VALUES('store','org','Store','123456','verified',?,?,?,?,?,1,1)").bind(encrypted.keyVersion,encrypted.nonce,encrypted.ciphertext,JSON.stringify(allCaps()),Date.now()+3600000),
 ]);return {db,env,wakes:()=>wakes};
}

test('FBP beta transport uses its own cursor-only list and posting envelope, retaining numeric status evidence',async()=>{
 let calls=0;
 const page=await listOzonFbpPostings(credentials,{...filter,cursor:'before'},async(input,init)=>{
  calls++;assert.equal(String(input),'https://api-seller.ozon.ru/v1/posting/fbp/list');assert.equal(init?.redirect,'manual');assert.deepEqual(JSON.parse(String(init?.body)),{filter,sort_by:'in_process_at',sort_dir:'ASC',cursor:'before',limit:50});return Response.json({postings:[packet],cursor:'after'});
 });assert.equal(page.hasNext,true);assert.equal(page.cursor,'after');assert.equal(page.postings[0].products[0].price,'00012.3400');assert.equal(page.postings[0].statusIsCode,false);assert.equal(page.postings[0].orderDate,packet.order_date);
 const normalized=await readOzonFbpPosting(credentials,{postingNumber:packet.posting_number},async(input,init)=>{
  calls++;assert.equal(String(input),'https://api-seller.ozon.ru/v1/posting/fbp/get');assert.deepEqual(JSON.parse(String(init?.body)),{posting_number:packet.posting_number});return Response.json({posting:{...detail,customer:{phone:'DO_NOT_RETAIN'},tracking_number:'not_in_fbp_contract'}});
 });assert.equal(normalized.status,'7');assert.equal(normalized.statusIsCode,true);assert.equal(normalized.substatus,detail.substatus);assert.equal(normalized.products[0].price,'12.34567890');assert.equal(normalized.trackingNumber,null);assert.equal(JSON.stringify(normalized).includes('DO_NOT_RETAIN'),false);assert.equal(calls,2);
 const numeric=await listOzonFbpPostings(credentials,filter,async()=>new Response(JSON.stringify({postings:[packet],cursor:''}).replace('"9000000000817031942"','9000000000817031942').replace('"9000000000817031943"','9000000000817031943')));assert.equal(numeric.postings[0].orderId,packet.order_id);assert.equal(numeric.postings[0].products[0].sku,packet.products[0].sku);assert.equal(numeric.hasNext,false);
 for(const value of [{postings:[packet],cursor:'before'},{postings:[],cursor:'next'},{result:[packet]},{postings:[packet],cursor:123}])await assert.rejects(listOzonFbpPostings(credentials,{...filter,cursor:'before'},async()=>Response.json(value)),error=>error instanceof OzonReadError&&error.code==='invalid_response');
 await assert.rejects(readOzonFbpPosting(credentials,{postingNumber:'different'},async()=>Response.json({posting:detail})),OzonReadError);
 await assert.rejects(readOzonFbpPosting(credentials,{postingNumber:packet.posting_number},async()=>Response.json({posting:{...detail,status:Number.MAX_SAFE_INTEGER+1}})),OzonReadError);
 await assert.rejects(listOzonFbpPostings(credentials,{...filter,limit:101},async()=>{throw Error('must not fetch');}),error=>error instanceof OzonReadError&&error.code==='invalid_request');
});

test('0058 preserves the populated authority/FK chain, historical cursors and old facts without enabling FBP',()=>{
 const db=new DatabaseSync(':memory:');try{
 db.exec('PRAGMA foreign_keys=ON');const dir=new URL('../migrations/',import.meta.url);for(const file of readdirSync(dir).filter(file=>file.endsWith('.sql')&&file<'0058').sort())db.exec(readFileSync(new URL(file,dir),'utf8'));
 db.exec(`INSERT INTO organization(id,name,slug,created_at) VALUES('org','Org','org',1);
 INSERT INTO store(id,organization_id,name,platform_store_id,created_at,updated_at) VALUES('store','org','Store','123',1,1);
 INSERT INTO store_coordinator(store_id,organization_id,fence,lease_source,lease_token,lease_until,blocked_until) VALUES('store','org',9,'fbs_postings','old',9999999999999,1234);
 INSERT INTO store_sync_source(store_id,organization_id,source,enabled,epoch,due_at,updated_at) VALUES('store','org','chat',1,3,1,1),('store','org','fbs_postings',1,4,1,1);
 INSERT INTO sync_cursor(organization_id,store_id,thread_id,stream,cursor,revision,due_at) VALUES('org','store','','discovery','chat-cursor',5,1);
 INSERT INTO posting_history_sync(store_id,organization_id,source,epoch,requested_from,requested_to,covered_from,since,"to",cursor,due_at,pages_read) VALUES('store','org','fbs_postings',4,1767225600000,1790812800000,1790812800000,1788220800000,1790812800000,'saved-history-cursor',1,3);
 INSERT INTO fbs_posting(posting_number,organization_id,store_id,order_id,order_number,detail_epoch,detail_generation,detail_due_at) VALUES('old','org','store','1','old-order',4,2,1);`);
 const history=db.prepare('SELECT * FROM posting_history_sync').all(),sources=db.prepare('SELECT * FROM store_sync_source').all(),cursors=db.prepare('SELECT * FROM sync_cursor').all();
 db.exec(readFileSync(new URL('0058_fbp_orders.sql',dir),'utf8'));assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.deepEqual(db.prepare('SELECT * FROM posting_history_sync').all(),history);assert.deepEqual(db.prepare('SELECT * FROM store_sync_source').all(),sources);assert.deepEqual(db.prepare('SELECT * FROM sync_cursor').all(),cursors);
 assert.equal(db.prepare('SELECT fence FROM store_coordinator').get()!.fence,10);assert.equal(db.prepare('SELECT lease_token FROM store_coordinator').get()!.lease_token,null);assert.equal(db.prepare('SELECT blocked_until FROM store_coordinator').get()!.blocked_until,1234);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fbs_posting').get()!.n,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fbp_posting').get()!.n,0);
 db.exec("INSERT INTO store_sync_source(store_id,organization_id,source,enabled,epoch,due_at,updated_at) VALUES('store','org','fbp_postings',1,1,1,1);UPDATE store SET status='paused'");assert.equal(db.prepare('SELECT SUM(enabled) AS n FROM store_sync_source').get()!.n,0);
 db.exec("DELETE FROM store WHERE id='store'");assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posting_history_sync').get()!.n,0);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});

test('FBP-only synchronization pages, hydrates, backfills and fences stale work independently',async t=>{
 const f=await fixture();t.after(()=>f.db.close());const {db,env}=f;assert.ok(await setSyncSourceEnabled(db,actor,'store','fbp_postings',0,true));
 const ready=()=>db.prepare("UPDATE store_sync_source SET due_at=CASE source WHEN 'fbp_postings' THEN 0 ELSE 9999999999999 END").run();const requests:{path:string;body:any}[]=[];
 const fetcher:typeof fetch=async(input,init)=>{const path=new URL(String(input)).pathname,body=JSON.parse(String(init?.body));requests.push({path,body});return path.endsWith('/get')?Response.json({posting:detail}):Response.json({postings:body.cursor?[]:[packet],cursor:body.cursor?'':'second'});};
 await ready();await runSyncPage(env,scope,{fetcher});await ready();await runSyncPage(env,scope,{fetcher});await db.prepare('UPDATE fbp_sync_window SET due_at=0').run();await ready();await runSyncPage(env,scope,{fetcher});
 assert.deepEqual(requests.map(row=>row.path),['/v1/posting/fbp/list','/v1/posting/fbp/get','/v1/posting/fbp/list']);assert.deepEqual(requests[0].body.filter,requests[2].body.filter);assert.equal(requests[2].body.cursor,'second');assert.equal(await db.prepare('SELECT detail_state FROM fbp_posting').first('detail_state'),'complete');
 const dto=await readOrderPosting(db,actor,'store',packet.posting_number,'fbp');assert.equal(dto?.status,'7');assert.equal(dto?.statusIsCode,true);assert.equal(dto?.products[0].price,'12.34567890');assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM fbs_posting').first('n'),0);assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM fbo_posting').first('n'),0);
 const from=new Date(Date.now()-365*86400000).toISOString().slice(0,10);assert.ok(await changePostingHistory(db,actor,'store','fbp_postings',{operation:'start',expectedEpoch:1,expectedHistoryRevision:0,since:from}));await ready();await runSyncPage(env,scope,{fetcher:async()=>Response.json({postings:[],cursor:''})});assert.equal((await readPostingHistory(db,actor,'store','fbp_postings'))?.pagesRead,1);
 await db.prepare("UPDATE posting_history_sync SET due_at=0 WHERE source='fbp_postings'").run();await ready();const lease=await claimSyncLease(db,{...scope,source:'fbp_postings',token:crypto.randomUUID()});assert.ok(lease);const work=await getDueFbpWork(db,lease);assert.equal(work?.kind,'list');assert.ok(await setSyncSourceEnabled(db,actor,'store','fbp_postings',1,false));if(work?.kind==='list')assert.equal(await commitFbpList(db,lease,work,{postings:[],cursor:null,hasNext:false}),false);
 assert.ok(await setSyncSourceEnabled(db,actor,'store','fbs_postings',0,true));assert.ok(await setSyncSourceEnabled(db,actor,'store','fbp_postings',2,true));await db.prepare('UPDATE fbp_posting SET detail_due_at=9999999999999').run();await ready();await runSyncPage(env,scope,{fetcher:async()=>new Response('',{status:403})});
 assert.equal(await db.prepare("SELECT enabled FROM store_sync_source WHERE source='fbs_postings'").first('enabled'),1);assert.equal(await db.prepare("SELECT enabled FROM store_sync_source WHERE source='fbp_postings'").first('enabled'),0);assert.equal(await db.prepare("SELECT last_error FROM store_sync_source WHERE source='fbp_postings'").first('last_error'),'fbp_list_permission_denied');assert.equal(retrySyncFailure({code:'permission_denied'},'fbp-detail',0,0).code,'fbp_details_permission_denied');
});

test('confirmed FBP identities suppress only exact legacy FBS duplicates without deleting old detail links',async t=>{
 const {db}=await fixture();t.after(()=>db.close());
 for(const [mode,number,order]of [['fbs','matched','1'],['fbp','matched','1'],['fbs','collision','2'],['fbp','collision','3'],['fbo','matched','4']]){
  const facts={postingNumber:number,orderId:order,orderNumber:`order-${order}`,status:'delivered',products:[],inProcessAt:null,shipmentDate:null,deliveringDate:null,trackingNumber:null};await db.prepare(`INSERT INTO ${mode}_posting(posting_number,organization_id,store_id,order_id,order_number,list_facts,list_observed_at,detail_epoch,detail_generation,detail_due_at) VALUES(?,'org','store',?,?,?,1,1,1,9999999999999)`).bind(number,order,facts.orderNumber,JSON.stringify(facts)).run();
 }
 const all=await listOrderPostings(db,actor,'store',undefined,25);assert.equal(all.totalPostings,4);assert.equal(all.totalOrders,4);assert.equal((await listOrderPostings(db,actor,'store',undefined,25,undefined,'fbs')).totalPostings,1);assert.equal((await listOrderPostings(db,actor,'store',undefined,25,undefined,'fbp')).totalPostings,2);assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM fbs_posting').first('n'),2);
 assert.equal((await readOrderPosting(db,actor,'store','matched','fbs'))?.orderId,'1');assert.equal((await readOrderPosting(db,actor,'store','matched','fbp'))?.fulfillmentType,'fbp');
 let edge:string|undefined,seen:string[]=[];do{const page=await listOrderPostings(db,actor,'store',edge,1);seen.push(...page.items.map(item=>`${item.fulfillmentType}:${item.postingNumber}`));edge=page.nextCursor??undefined;}while(edge);assert.equal(new Set(seen).size,4);
});

test('FBP requires its own capability; HTTP controls, history and receipts remain manager-scoped',async t=>{
 const f=await fixture();t.after(()=>f.db.close());const {db,env}=f,hash=await hashPassword('synthetic-fbp-password');for(const id of ['owner','staff'])await db.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password,updated_at) VALUES(?,?,'credential',?,?,1)").bind(id,id,id,hash).run();
 const cookies:Record<string,string>={};for(const id of ['owner','staff']){const response=await services(env as never)!.auth.api.signInEmail({body:{email:`${id}@fbp.invalid`,password:'synthetic-fbp-password'},asResponse:true});cookies[id]=response.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; ');}
 const app=createApp(),request=(path='/sync/fbp-postings',body?:unknown,user='owner',origin=env.APP_BASE_URL)=>app.request(`${env.APP_BASE_URL}/api/companies/org/stores/store${path}`,{method:body?'POST':'GET',headers:{cookie:cookies[user]??'',origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})},env as never);
 const legacy=allCaps().filter(row=>row.code!=='orders_fbp_read');await db.prepare('UPDATE store SET capabilities=?').bind(JSON.stringify(legacy)).run();const stored=await findStore(db,actor,'store',true);assert.ok(stored);const view=storeDTO(stored);assert.equal(view.capabilities.find(row=>row.code==='orders_fbo_read')?.status,'available');assert.equal(view.capabilities.find(row=>row.code==='orders_fbp_read')?.status,'unknown');
 assert.equal((await request('/sync/fbp-postings',{expectedEpoch:0,enabled:true})).status,409);assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM store_sync_source').first('n'),0);
 await db.prepare('UPDATE store SET capabilities=?').bind(JSON.stringify(allCaps())).run();assert.equal((await request('/sync/fbp-postings',{expectedEpoch:0,enabled:true},'staff')).status,403);assert.equal((await request('/sync/fbp-postings',{expectedEpoch:0,enabled:true},'owner','https://other.invalid')).status,403);
 let response=await request('/sync/fbp-postings',{expectedEpoch:0,enabled:true});assert.equal(response.status,200);assert.equal((await response.json() as any).sync.source,'fbp_postings');assert.equal(f.wakes(),1);assert.equal((await request('/sync/fbp-postings',{expectedEpoch:0,enabled:true})).status,409);assert.equal(f.wakes(),1);
 const since=new Date(Date.now()-365*86400000).toISOString().slice(0,10);response=await request('/sync/fbp-postings/history',{operation:'start',expectedEpoch:1,expectedHistoryRevision:0,since});assert.equal(response.status,200);assert.equal((await response.json() as any).history.source,'fbp_postings');
 const reread=await(await request()).json() as any;assert.equal(reread.sync.history.state,'active');assert.equal(reread.sync.history.commandRevision,1);assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM store_audit_event WHERE action='store.sync.fbp_postings.enable' AND outcome='succeeded'").first('n'),1);
 assert.equal((await request('/sync/fbp-postings/history',{operation:'cancel',expectedEpoch:1,expectedHistoryRevision:1},'staff')).status,403);
});

test('FBP capability evidence comes from a bounded beta list read, never another mode',async()=>{
 const paths:string[]=[];const evidence=await inspectOzonCapabilities(credentials,async input=>{const path=new URL(String(input)).pathname;paths.push(path);return path==='/v1/roles'?Response.json({roles:[]}):path==='/v3/product/list'?Response.json({result:{items:[]}}):path==='/v3/chat/list'?Response.json({chats:[]}):path==='/v1/posting/fbp/list'?new Response('',{status:403}):Response.json({postings:[]});});assert.equal(evidence.find(row=>row.code==='orders_fbp_read')?.status,'denied');assert.equal(evidence.find(row=>row.code==='orders_fbs_read')?.status,'available');assert.equal(paths.filter(path=>path==='/v1/posting/fbp/list').length,1);
});
