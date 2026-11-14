import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Miniflare} from 'miniflare';
import {applyMigrations} from './fixtures/migrations.ts';
import * as v from 'valibot';
import {hashPassword} from 'better-auth/crypto';
import {SqliteDatabase,migrateSqlite} from '../src/platform/node/database.ts';
import {createApp} from '../src/application.ts';
import {services} from '../src/modules/identity/services.ts';
import {capabilityCodes} from '../src/modules/stores/ozon.ts';
import {orderHistoryCommandSchema,type PostingSource} from '../src/shared/order-history.ts';
import {changePostingHistory,readPostingHistory} from '../src/modules/orders/history.ts';
import {getDueFbsWork,getDueFboWork,getDueFbpWork,commitFbsList,commitFboList,commitFbpList,commitFbsDetails} from '../src/modules/orders/storage.ts';
import {claimSyncLease,setSyncSourceEnabled} from '../src/modules/sync/storage.ts';
import type {FbsListWork} from '../src/modules/orders/types.ts';
import type {OzonFbsPosting} from '../src/modules/orders/ozon.ts';
const actor={orgId:'org',actorUserId:'owner',sessionId:'session'},day=86400000,scope={orgId:'org',storeId:'store'};
const since=new Date(Date.now()-400*day).toISOString().slice(0,10);
const posting:OzonFbsPosting={postingNumber:'same-history-parcel',orderId:'1',orderNumber:'historical-order',status:'delivered',products:[{sku:'1',offerId:'old-product',name:'历史商品',quantity:1,price:'10.00',currency:'RUB'}],inProcessAt:since+'T00:00:00.000Z',shipmentDate:null,deliveringDate:null,trackingNumber:null};
const start=(expectedHistoryRevision=0,expectedEpoch=1,from=since)=>({operation:'start' as const,expectedHistoryRevision,expectedEpoch,since:from});
const cancel=(expectedHistoryRevision=1,expectedEpoch=1)=>({operation:'cancel' as const,expectedHistoryRevision,expectedEpoch});
const list=(source:PostingSource)=>source==='fbs_postings'?getDueFbsWork:source==='fbo_postings'?getDueFboWork:getDueFbpWork;
const commit=(source:PostingSource)=>source==='fbs_postings'?commitFbsList:source==='fbo_postings'?commitFboList:commitFbpList;
async function seed(db:D1Database){
 await db.batch([
 db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('org','Org','org',1),('other','Other','other',1)"),
 db.prepare("INSERT INTO user(id,name,email,email_verified) VALUES('owner','Owner','owner@example.invalid',1),('staff','Staff','staff@example.invalid',1)"),
 db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('owner-member','org','owner','owner',1),('staff-member','org','staff','member',1)"),
 db.prepare("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES('session','token','owner',?,1,1)").bind(Date.now()+3600000),
 db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,credential_key_version,credential_nonce,credential_ciphertext,capabilities,expires_at,created_at,updated_at) VALUES('store','org','Store','12345','verified','synthetic','synthetic','synthetic',?,?,1,1)").bind(JSON.stringify(capabilityCodes.map(code=>({code,status:['auth','orders_fbs_read','orders_fbo_read','orders_fbp_read'].includes(code)?'available':'unknown',reason:'read_verified'}))),Date.now()+3600000),
 ]);
 for(const source of ['fbs_postings','fbo_postings','fbp_postings'] as const)assert.ok(await setSyncSourceEnabled(db,actor,'store',source,0,true));
}
async function fixture(){const db=new SqliteDatabase(':memory:');await migrateSqlite(db,'migrations');await seed(db);return db;}
async function claim(db:D1Database,source:PostingSource){await db.prepare('UPDATE store_sync_source SET due_at=0 WHERE source=?').bind(source).run();const lease=await claimSyncLease(db,{...scope,source,token:crypto.randomUUID()});assert.ok(lease);return lease;}
async function historical(db:D1Database,source:PostingSource){const mode=source==='fbs_postings'?'fbs':source==='fbo_postings'?'fbo':'fbp';await db.prepare(`UPDATE ${mode}_sync_window SET due_at=? WHERE store_id='store'`).bind(Date.now()+3600000).run();await db.prepare(`UPDATE ${mode}_posting SET detail_due_at=? WHERE store_id='store'`).bind(Date.now()+3600000).run();await db.prepare('UPDATE posting_history_sync SET due_at=0 WHERE source=?').bind(source).run();const lease=await claim(db,source),work=await list(source)(db,lease);assert.equal(work?.kind,'list');assert.equal((work as FbsListWork).lane,'history');return {lease,work:work as FbsListWork};}

test('history commands validate real UTC dates and protect source scope, manager intent and revisions',async t=>{
 const db=await fixture();t.after(()=>db.close());
 for(const date of ['1999-12-31','2026-02-30','2025-2-01','invalid'])assert.equal(v.safeParse(orderHistoryCommandSchema,start(0,1,date)).success,false);
 assert.equal(v.safeParse(orderHistoryCommandSchema,{...start(),apiKey:'not-accepted'}).success,false);
 assert.equal(await changePostingHistory(db,{...actor,orgId:'other'},'store','fbs_postings',start()),null);
 assert.equal(await changePostingHistory(db,{...actor,actorUserId:'staff'},'store','fbs_postings',start()),null);
 assert.equal(await changePostingHistory(db,actor,'store','fbs_postings',cancel(0)),null);
 await assert.rejects(changePostingHistory(db,actor,'store','fbs_postings',start(0,1,'2099-01-01')),RangeError);
 const recent=await db.prepare('SELECT * FROM fbs_sync_window').first();
 const task=await changePostingHistory(db,actor,'store','fbs_postings',start());assert.equal(task?.state,'active');assert.equal(task?.commandRevision,1);assert.equal(task?.requestedFrom,since+'T00:00:00.000Z');
 assert.deepEqual(await db.prepare('SELECT * FROM fbs_sync_window').first(),recent);
 assert.equal(await readPostingHistory(db,actor,'store','fbo_postings'),null);
 assert.equal(await changePostingHistory(db,actor,'store','fbs_postings',start()),null);
 assert.equal(await changePostingHistory(db,actor,'store','fbs_postings',start(1,2)),null);
 assert.equal(await db.prepare('SELECT SUM(pages_read) AS n FROM posting_history_sync').first('n'),0);
 await db.prepare("UPDATE store_coordinator SET blocked_until=? WHERE store_id='store'").bind(Date.now()+60000).run();
 assert.ok(await changePostingHistory(db,actor,'store','fbo_postings',start()));
 const due=Number(await db.prepare("SELECT due_at FROM store_sync_source WHERE source='fbo_postings'").first('due_at'));
 assert.ok(due>=Date.now()+59000);
 await db.prepare("UPDATE member SET role='owner' WHERE id='staff-member'").run();
 await db.prepare("UPDATE member SET role='member' WHERE id='owner-member'").run();
 assert.equal(await changePostingHistory(db,actor,'store','fbs_postings',cancel()),null);
});

test('historical pages stay frozen, deduplicate facts and scan backwards through empty windows on real D1',{timeout:60000},async t=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("history")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});t.after(()=>mf.dispose());const db=await mf.getD1Database('DB') as unknown as D1Database;
 await applyMigrations(db);await seed(db);
 for(const source of ['fbs_postings','fbo_postings','fbp_postings'] as const){
  await changePostingHistory(db,actor,'store',source,start());const mode=source==='fbs_postings'?'fbs':source==='fbo_postings'?'fbo':'fbp',recent=await db.prepare(`SELECT since,"to",cursor,history_start,last_completed_to,generation,revision FROM ${mode}_sync_window`).first();
  const first=await historical(db,source);assert.ok(Date.parse(first.work.to)-Date.parse(first.work.since)<=31*day);
  assert.ok(await commit(source)(db,first.lease,first.work,{postings:[posting],hasNext:true,cursor:'A'}));
  let task=await readPostingHistory(db,actor,'store',source);assert.equal(task?.coveredFrom,task?.requestedTo);assert.equal(task?.commandRevision,1);
  const second=await historical(db,source);assert.equal(second.work.since,first.work.since);assert.equal(second.work.to,first.work.to);assert.equal(second.work.cursor,'A');
  await assert.rejects(commit(source)(db,second.lease,second.work,{postings:[posting],hasNext:true,cursor:'A'}),/cursor_stalled/);
  assert.ok(await commit(source)(db,second.lease,second.work,{postings:[posting],hasNext:false,cursor:null}));
  task=await readPostingHistory(db,actor,'store',source);assert.equal(task?.coveredFrom,first.work.since);assert.equal(task?.commandRevision,1);
  let previous=Date.parse(first.work.since),pages=2;
  while(task?.state==='active'){
   assert.ok(pages<20);const next=await historical(db,source),from=Date.parse(next.work.since),to=Date.parse(next.work.to);
   assert.ok(from<previous);assert.ok(to>=previous&&to<=previous+3600000);assert.ok(to-from<=31*day);
   assert.ok(await commit(source)(db,next.lease,next.work,{postings:[],hasNext:false,cursor:null}));previous=from;pages++;task=await readPostingHistory(db,actor,'store',source);
  }
  assert.equal(task?.state,'complete');assert.equal(task?.coveredFrom,since+'T00:00:00.000Z');assert.equal(task?.pagesRead,pages);assert.ok(pages>=12);
  assert.equal(await db.prepare(`SELECT COUNT(*) AS n FROM ${mode}_posting`).first('n'),1);assert.equal(await db.prepare(`SELECT COUNT(*) AS n FROM ${mode}_posting_observation`).first('n'),1);
  assert.deepEqual(await db.prepare(`SELECT since,"to",cursor,history_start,last_completed_to,generation,revision FROM ${mode}_sync_window`).first(),recent);
  const older=new Date(Date.parse(since)-60*day).toISOString().slice(0,10);const extended=await changePostingHistory(db,actor,'store',source,start(1,1,older));assert.equal(extended?.coveredFrom,task?.coveredFrom);assert.equal(extended?.state,'active');assert.equal(extended?.pagesRead,pages);assert.ok(Date.parse(extended!.windowTo)<=Date.parse(task!.coveredFrom)+3600000);
 }
});

test('cancel, source pause and resume fence in-flight pages without losing their historical cursor',async t=>{
 const db=await fixture();t.after(()=>db.close());await changePostingHistory(db,actor,'store','fbs_postings',start());
 let job=await historical(db,'fbs_postings');await commitFbsList(db,job.lease,job.work,{postings:[posting],hasNext:true,cursor:'A'});
 job=await historical(db,'fbs_postings');const before=await readPostingHistory(db,actor,'store','fbs_postings');
 assert.equal((await changePostingHistory(db,actor,'store','fbs_postings',cancel()))?.state,'cancelled');assert.equal(await commitFbsList(db,job.lease,job.work,{postings:[{...posting,postingNumber:'must-not-import'}],hasNext:false,cursor:null}),false);
 assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM fbs_posting WHERE posting_number='must-not-import'").first('n'),0);
 assert.equal(await db.prepare("SELECT enabled FROM store_sync_source WHERE source='fbs_postings'").first('enabled'),1);
 assert.ok(await changePostingHistory(db,actor,'store','fbs_postings',start(2)));
 assert.ok(await setSyncSourceEnabled(db,actor,'store','fbs_postings',1,false));assert.ok(await setSyncSourceEnabled(db,actor,'store','fbs_postings',2,true));
 job=await historical(db,'fbs_postings');assert.equal(job.work.epoch,3);assert.equal(job.work.cursor,'A');assert.equal(job.work.since,before?.windowSince);assert.equal(job.work.to,before?.windowTo);assert.ok(await commitFbsList(db,job.lease,job.work,{postings:[],hasNext:false,cursor:null}));
 assert.equal(await db.prepare("SELECT epoch FROM store_sync_source WHERE source='fbo_postings'").first('epoch'),1);
});

test('history snapshots, pending details and coverage roll back as one transaction',async t=>{
 const db=await fixture();t.after(()=>db.close());await changePostingHistory(db,actor,'store','fbs_postings',start());const job=await historical(db,'fbs_postings'),before=await readPostingHistory(db,actor,'store','fbs_postings');
 await db.exec("CREATE TRIGGER history_failure BEFORE UPDATE ON posting_history_sync WHEN NEW.pages_read>OLD.pages_read BEGIN SELECT RAISE(ABORT,'HISTORY_FAILURE'); END");
 await assert.rejects(commitFbsList(db,job.lease,job.work,{postings:[posting],hasNext:false,cursor:null}),/HISTORY_FAILURE/);
 assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM fbs_posting').first('n'),0);assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM fbs_posting_observation').first('n'),0);assert.deepEqual(await readPostingHistory(db,actor,'store','fbs_postings'),before);
 await db.exec('DROP TRIGGER history_failure');assert.ok(await commitFbsList(db,job.lease,job.work,{postings:[posting],hasNext:false,cursor:null}));
});

test('live lists, historical lists and details each receive turns under the same source lease',async t=>{
 const db=await fixture();t.after(()=>db.close());await changePostingHistory(db,actor,'store','fbs_postings',start());
 await db.prepare("INSERT INTO fbs_posting(posting_number,organization_id,store_id,order_id,order_number,detail_epoch,detail_generation,detail_due_at) VALUES('same-history-parcel','org','store','1','historical-order',1,1,0)").run();
 const turns:string[]=[];
 for(let index=0;index<6;index++){
  await db.prepare("UPDATE fbs_sync_window SET state='active',due_at=0").run();await db.prepare('UPDATE posting_history_sync SET due_at=0').run();await db.prepare('UPDATE fbs_posting SET detail_due_at=0').run();const lease=await claim(db,'fbs_postings'),work=await getDueFbsWork(db,lease);assert.ok(work);
  if(work.kind==='details'){turns.push('details');assert.ok(await commitFbsDetails(db,lease,work,posting));}else{turns.push(work.lane??'live');assert.ok(await commitFbsList(db,lease,work,{postings:[],hasNext:false,cursor:null}));}
 }
 assert.deepEqual(turns,['live','history','details','live','history','details']);
});

test('history HTTP controls are audited, manager-only, strict and rereadable after a failed wake',async t=>{
 const db=await fixture();t.after(()=>db.close());const password='synthetic-history-password',hash=await hashPassword(password);
 for(const id of ['owner','staff'])await db.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password,updated_at) VALUES(?,?,'credential',?,?,1)").bind(id,id,id,hash).run();
 let failWake=false,wakes=0;const env={DB:db,APP_BASE_URL:'https://history.example.invalid',BETTER_AUTH_SECRET:'synthetic-history-identity-secret-more-than-32-characters',STORE_CREDENTIAL_KEYS:JSON.stringify({test:btoa('s'.repeat(32))}),STORE_CREDENTIAL_ACTIVE_KEY:'test',STORE_COORDINATOR:{getByName:()=>({wake:async()=>{wakes++;if(failWake)throw Error('synthetic lost wake');}})}};
 const cookies:Record<string,string>={};for(const id of ['owner','staff']){const response=await services(env as never)!.auth.api.signInEmail({body:{email:`${id}@example.invalid`,password},asResponse:true});cookies[id]=response.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; ');}
 const app=createApp(),request=(body?:unknown,user='owner',origin=env.APP_BASE_URL,company='org')=>app.request(`${env.APP_BASE_URL}/api/companies/${company}/stores/store/sync/fbs-postings${body?'/history':''}`,{method:body?'POST':'GET',headers:{cookie:cookies[user]??'',origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})},env as never);
 assert.equal((await request(start(),'staff')).status,403);assert.equal((await request(start(),'owner','https://elsewhere.invalid')).status,403);assert.equal((await request(start(),'owner',env.APP_BASE_URL,'other')).status,404);
 assert.equal((await request({...start(),unexpected:true})).status,400);assert.equal((await request(start(0,1,'2026-02-30'))).status,400);
 const secret=await db.prepare('SELECT credential_ciphertext,credential_version FROM store').first();
 failWake=true;let response=await request(start());assert.equal(response.status,200);let body=await response.json() as any;assert.equal(body.history.commandRevision,1);assert.equal(body.wakePending,true);assert.equal(wakes,1);
 assert.equal((await request(start())).status,409);assert.equal(wakes,1);
 response=await request();body=await response.json() as any;assert.equal(body.sync.history.state,'active');assert.equal(body.sync.history.source,'fbs_postings');assert.equal(body.sync.history.commandRevision,1);
 assert.deepEqual(await db.prepare('SELECT credential_ciphertext,credential_version FROM store').first(),secret);
 assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM store_audit_event WHERE action='store.history.fbs_postings.start' AND outcome='succeeded'").first('n'),1);
 delete (env as any).STORE_COORDINATOR;response=await request(cancel());assert.equal(response.status,200);assert.equal((await response.json() as any).history.state,'cancelled');
 assert.equal((await request(start(2))).status,503);
});
