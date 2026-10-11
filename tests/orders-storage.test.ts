import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { getDueFbsWork,commitFbsList,commitFbsDetails,commitFbsDetailFailure,getFbsCounts } from '../src/modules/orders/storage.ts';
import { prepareFbsSyncSeed } from '../src/modules/orders/sync-seed.ts';
import type { FbsDetailsWork,FbsListWork } from '../src/modules/orders/types.ts';
import type { OzonFbsPosting } from '../src/modules/orders/ozon.ts';
import { claimSyncLease,setSyncSourceEnabled,releaseSyncLease } from '../src/modules/sync/storage.ts';
import type { SyncLease } from '../src/modules/sync/types.ts';

test('FBS persistence separates frozen windows, postings and source observations', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    const folder = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(folder).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, folder), 'utf8'));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    for (const name of ['fbs_sync_window', 'fbs_posting', 'fbs_posting_observation']) assert.ok(tables.includes(name), `${name} must be persisted`);
  } finally { db.close(); }
});

test('FBS windows and observations commit under real D1 source fences', {timeout:90_000}, async context=>{
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  context.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB') as unknown as D1Database;
  const folder=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(folder).filter(name=>name.endsWith('.sql')).sort())for(const sql of readFileSync(new URL(name,folder),'utf8').split('--> statement-breakpoint').map(part=>part.trim()).filter(Boolean))await db.prepare(sql).run();
  const actor={orgId:'fbs-org',actorUserId:'fbs-admin',sessionId:'fbs-session'};
  await db.batch([
    db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES ('fbs-org','FBS','fbs',1),('other-fbs-org','Other','other-fbs',1)"),
    db.prepare("INSERT INTO user(id,name,email,email_verified) VALUES ('fbs-admin','Admin','fbs@example.invalid',1)"),
    db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('fbs-member','fbs-org','fbs-admin','admin',1)"),
    db.prepare("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES ('fbs-session','fbs-token','fbs-admin',?,1,1)").bind(Date.now()+3_600_000),
  ]);
  const day=86_400_000, hour=3_600_000;
  const caps=JSON.stringify(['auth','chats_read','products_read','orders_fbs_read'].map(code=>({code,status:'available',reason:'read_verified'})));
  const posting=(postingNumber='order-1-1',status='delivered'):OzonFbsPosting=>({postingNumber,orderId:'9000000000817031942',orderNumber:'order-1',status,
    products:[{sku:'9000000000817031941',offerId:'offer-01',name:'Синтетический товар',quantity:1,price:'00012.3400',currency:'RUB'},
      {sku:'9000000000817031941',offerId:'offer-02',name:null,quantity:2,price:'999999999999999999.00000001',currency:'RUB'}],
    inProcessAt:null,shipmentDate:null,deliveringDate:null,trackingNumber:null});
  async function add(id:string,enable=true){
    await db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,credential_key_version,credential_nonce,credential_ciphertext,capabilities,expires_at,created_at,updated_at) VALUES (?,?,'FBS',?,'verified','synthetic','synthetic','synthetic',?,?,1,1)").bind(id,actor.orgId,id,caps,Date.now()+3_600_000).run();
    if(enable)assert.ok(await setSyncSourceEnabled(db,actor,id,'fbs_postings',0,true));
    return id;
  }
  async function lease(storeId:string):Promise<SyncLease>{
    await db.prepare("UPDATE store_sync_source SET due_at=1 WHERE store_id=? AND source='fbs_postings'").bind(storeId).run();
    const result=await claimSyncLease(db,{orgId:actor.orgId,storeId,source:'fbs_postings',token:crypto.randomUUID()});assert.ok(result);return result;
  }
  async function listWork(storeId:string,now=Date.now()){
    await db.prepare("UPDATE fbs_sync_window SET due_at=1,last_kind='details' WHERE store_id=?").bind(storeId).run();
    const claimed=await lease(storeId),work=await getDueFbsWork(db,claimed,now);assert.equal(work?.kind,'list');return {lease:claimed,work:work as FbsListWork};
  }
  async function list(storeId:string,postings=[posting()],hasNext=false,cursor:string|null=null,now=Date.now()){
    const job=await listWork(storeId,now);assert.ok(await commitFbsList(db,job.lease,job.work,{postings,cursor,hasNext},now));return job;
  }
  async function detailWork(storeId:string){
    await db.prepare('UPDATE fbs_sync_window SET due_at=? WHERE store_id=?').bind(Date.now()+3_600_000,storeId).run();
    await db.prepare("UPDATE fbs_posting SET detail_due_at=1 WHERE store_id=? AND detail_state<>'error'").bind(storeId).run();
    const claimed=await lease(storeId),work=await getDueFbsWork(db,claimed);assert.equal(work?.kind,'details');return {lease:claimed,work:work as FbsDetailsWork};
  }
  async function details(storeId:string,value?:OzonFbsPosting){const job=await detailWork(storeId);assert.ok(await commitFbsDetails(db,job.lease,job.work,value??posting(job.work.postingNumber)));return job;}
  async function count(storeId:string,source?:string){return db.prepare(`SELECT count(*) AS n FROM fbs_posting_observation WHERE store_id=?${source?' AND source=?':''}`).bind(storeId,...(source?[source]:[])).first<number>('n');}

  await context.test('new stores have no invented coverage; guarded enable freezes exactly thirty days',async()=>{
    const id=await add('fbs-seed',false);
    assert.deepEqual(await getFbsCounts(db,actor,id),{postingCount:0,readyCount:0,pendingCount:0,failedCount:0,historyStart:null,windowSince:null,windowTo:null,lastCompletedTo:null});
    const before=Date.now();
    await db.batch(prepareFbsSyncSeed(db,{orgId:actor.orgId,storeId:id},1,{sql:'0=1',values:[]}));
    assert.equal(await db.prepare('SELECT cursor FROM fbs_sync_window WHERE store_id=?').bind(id).first(),null);
    assert.ok(await setSyncSourceEnabled(db,actor,id,'fbs_postings',0,true));
    const row=await db.prepare('SELECT since,"to",history_start,last_completed_to FROM fbs_sync_window WHERE store_id=?').bind(id).first<any>();
    assert.ok(row);assert.equal(row.to-row.since,30*day);assert.equal(row.history_start,row.since);assert.equal(row.last_completed_to,null);assert.ok(row.to>=before&&row.to<=Date.now());
  });
  await context.test('pagination freezes the whole window and advances its completion only with the terminal page',async()=>{
    const id=await add('fbs-pages'),first=await list(id,[posting()],true,'A');
    assert.equal((await getFbsCounts(db,actor,id))?.lastCompletedTo,null);
    const second=await listWork(id);assert.equal(second.work.since,first.work.since);assert.equal(second.work.to,first.work.to);assert.equal(second.work.cursor,'A');
    assert.ok(await commitFbsList(db,second.lease,second.work,{postings:[posting(),posting('order-1-2')],cursor:null,hasNext:false}));
    assert.equal(await commitFbsList(db,second.lease,second.work,{postings:[],cursor:null,hasNext:false}),false);
    const stats=await getFbsCounts(db,actor,id);assert.equal(stats?.postingCount,2);assert.equal(stats?.pendingCount,2);assert.equal(stats?.lastCompletedTo,Date.parse(first.work.to));
    assert.equal(await count(id,'list'),2);
  });
  await context.test('a long outage catches up in bounded overlapping windows without jumping to now',async()=>{
    const id=await add('fbs-outage'),now=Date.now(),completed=now-90*day;
    await db.prepare("UPDATE fbs_sync_window SET history_start=?,since=?,\"to\"=?,last_completed_to=?,state='waiting',due_at=1 WHERE store_id=?").bind(completed-30*day,completed-30*day,completed,completed,id).run();
    let previous=completed;
    for(let index=0;index<3;index++){
      const job=await listWork(id,now);
      assert.equal(Date.parse(job.work.since),previous-hour);assert.equal(Date.parse(job.work.to),Math.min(now,previous-hour+31*day));
      assert.ok(await commitFbsList(db,job.lease,job.work,{postings:[],cursor:null,hasNext:false},now));previous=Date.parse(job.work.to);
      assert.equal((await getFbsCounts(db,actor,id))?.lastCompletedTo,previous);
    }
    assert.equal(previous,now);
    assert.ok(Number(await db.prepare('SELECT due_at FROM fbs_sync_window WHERE store_id=?').bind(id).first('due_at'))>=now+300_000);
  });
  await context.test('window preparation rejects old leases and waits through a backward clock',async()=>{
    const id=await add('fbs-clock');await list(id,[]);
    const before=await db.prepare('SELECT * FROM fbs_sync_window WHERE store_id=?').bind(id).first<any>();
    await db.prepare('UPDATE fbs_sync_window SET due_at=1 WHERE store_id=?').bind(id).run();
    const claimed=await lease(id);assert.equal(await getDueFbsWork(db,claimed,before.last_completed_to-1000),null);
    assert.ok(Number(await db.prepare("SELECT due_at FROM store_sync_source WHERE store_id=? AND source='fbs_postings'").bind(id).first('due_at'))>before.last_completed_to);
    assert.equal(await db.prepare('SELECT generation FROM fbs_sync_window WHERE store_id=?').bind(id).first('generation'),before.generation);
    await db.prepare('UPDATE store_coordinator SET lease_until=1 WHERE store_id=?').bind(id).run();
    assert.equal(await getDueFbsWork(db,claimed,before.last_completed_to+10000),null);
    assert.equal(await db.prepare('SELECT generation FROM fbs_sync_window WHERE store_id=?').bind(id).first('generation'),before.generation);
  });
  await context.test('no-work checks preserve the future schedule without releasing the caller lease or reporting success',async()=>{
    const id=await add('fbs-no-work'),future=Date.now()+3_600_000;
    await db.prepare('UPDATE fbs_sync_window SET due_at=? WHERE store_id=?').bind(future,id).run();
    const claimed=await lease(id);assert.equal(await getDueFbsWork(db,claimed),null);
    const state=await db.prepare("SELECT due_at,last_success_at FROM store_sync_source WHERE store_id=? AND source='fbs_postings'").bind(id).first<any>();
    assert.equal(state.due_at,future);assert.equal(state.last_success_at,null);
    assert.equal(await db.prepare('SELECT lease_token FROM store_coordinator WHERE store_id=?').bind(id).first('lease_token'),claimed.token);
  });
  await context.test('preparing the next window is atomic and never consumes its caller lease',async()=>{
    const id=await add('fbs-prepare-rollback');await list(id,[]);
    await db.prepare('UPDATE fbs_sync_window SET due_at=1 WHERE store_id=?').bind(id).run();
    const before=await db.prepare('SELECT since,"to",generation,revision,last_completed_to FROM fbs_sync_window WHERE store_id=?').bind(id).first();
    const claimed=await lease(id);
    await db.prepare("CREATE TRIGGER synthetic_fbs_prepare_failure BEFORE UPDATE ON fbs_sync_window WHEN NEW.store_id='fbs-prepare-rollback' AND OLD.state='waiting' AND NEW.state='active' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_PREPARE_FAILURE'); END").run();
    await assert.rejects(getDueFbsWork(db,claimed),/SYNTHETIC_PREPARE_FAILURE/);
    assert.deepEqual(await db.prepare('SELECT since,"to",generation,revision,last_completed_to FROM fbs_sync_window WHERE store_id=?').bind(id).first(),before);
    assert.deepEqual(await db.prepare('SELECT commit_token,lease_token FROM store_coordinator WHERE store_id=?').bind(id).first(),{commit_token:null,lease_token:claimed.token});
    await db.prepare('DROP TRIGGER synthetic_fbs_prepare_failure').run();
    assert.equal((await getDueFbsWork(db,claimed))?.kind,'list');
    assert.equal(await db.prepare('SELECT lease_token FROM store_coordinator WHERE store_id=?').bind(id).first('lease_token'),claimed.token);
  });
  await context.test('list failure rolls back observations, pending details and window completion together',async()=>{
    const id=await add('fbs-list-rollback'),job=await listWork(id);
    await db.prepare("CREATE TRIGGER synthetic_fbs_list_failure BEFORE INSERT ON fbs_posting_observation WHEN NEW.store_id='fbs-list-rollback' AND NEW.posting_number='order-1-2' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_FBS_FAILURE'); END").run();
    await assert.rejects(commitFbsList(db,job.lease,job.work,{postings:[posting(),posting('order-1-2')],cursor:null,hasNext:false}),/SYNTHETIC_FBS_FAILURE/);
    const stats=await getFbsCounts(db,actor,id);assert.equal(stats?.postingCount,0);assert.equal(stats?.lastCompletedTo,null);assert.equal(await count(id),0);
    assert.equal((await getDueFbsWork(db,job.lease))?.kind,'list');
  });
  await context.test('source observations remain separate and never rank unknown or apparently older statuses',async()=>{
    const id=await add('fbs-observations');await list(id);await details(id);
    await list(id,[posting('order-1-1','awaiting_deliver')]);
    let row=await db.prepare('SELECT list_facts,detail_facts FROM fbs_posting WHERE store_id=?').bind(id).first<any>();
    assert.equal(JSON.parse(row.list_facts).status,'awaiting_deliver');assert.equal(JSON.parse(row.detail_facts).status,'delivered');
    await list(id);await details(id);assert.equal(await count(id,'list'),3);assert.equal(await count(id,'details'),1);
    await details(id,posting('order-1-1','unknown_future_status'));assert.equal(await count(id,'details'),2);
    row=await db.prepare('SELECT detail_facts FROM fbs_posting WHERE store_id=?').bind(id).first<any>();
    const saved=JSON.parse(row.detail_facts);assert.equal(saved.orderId,'9000000000817031942');assert.equal(saved.products.length,2);assert.equal(saved.products[0].sku,saved.products[1].sku);assert.equal(saved.products[0].price,'00012.3400');assert.equal(saved.products[1].price,'999999999999999999.00000001');
    assert.equal(await db.prepare('SELECT count(*) AS n FROM fbs_posting_observation WHERE store_id=? AND source_updated_at IS NOT NULL').bind(id).first('n'),0);
    await assert.rejects(db.prepare("UPDATE fbs_posting_observation SET facts='{}' WHERE store_id=?").bind(id).run(),/FBS_OBSERVATION_IMMUTABLE/);
  });
  await context.test('detail snapshot failure rolls back completion while old facts remain intact',async()=>{
    const id=await add('fbs-detail-rollback');await list(id);await details(id);const job=await detailWork(id);
    await db.prepare("CREATE TRIGGER synthetic_fbs_detail_failure BEFORE INSERT ON fbs_posting_observation WHEN NEW.store_id='fbs-detail-rollback' AND NEW.source='details' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_DETAIL_FAILURE'); END").run();
    await assert.rejects(commitFbsDetails(db,job.lease,job.work,posting('order-1-1','changed')),/SYNTHETIC_DETAIL_FAILURE/);
    assert.equal(await count(id,'details'),1);assert.equal(JSON.parse(await db.prepare('SELECT detail_facts FROM fbs_posting WHERE store_id=?').bind(id).first<string>('detail_facts')??'{}').status,'delivered');
  });
  await context.test('known postings refresh after fifteen minutes even outside new list windows',async()=>{
    const id=await add('fbs-refresh');await list(id);const before=Date.now();await details(id);
    let stats=await getFbsCounts(db,actor,id);assert.equal(stats?.readyCount,1);assert.equal(stats?.pendingCount,0);
    assert.ok(Number(await db.prepare('SELECT detail_due_at FROM fbs_posting WHERE store_id=?').bind(id).first('detail_due_at'))>=before+900_000);
    await list(id,[]);const job=await detailWork(id);assert.equal(job.work.postingNumber,'order-1-1');
    stats=await getFbsCounts(db,actor,id);assert.equal(stats?.readyCount,1);assert.equal(stats?.pendingCount,1);
    assert.ok(await commitFbsDetails(db,job.lease,job.work,posting()));
  });
  await context.test('three isolated detail failures preserve source success and leave other postings executable',async()=>{
    const id=await add('fbs-failures');await list(id,[posting(),posting('order-1-2')]);await details(id);
    await db.prepare("UPDATE store_sync_source SET last_success_at=123,last_error='preserved',failures=2 WHERE store_id=? AND source='fbs_postings'").bind(id).run();
    for(let index=0;index<3;index++){
      await db.prepare("UPDATE fbs_posting SET detail_due_at=CASE WHEN posting_number='order-1-1' THEN 1 ELSE ? END WHERE store_id=?").bind(Date.now()+3_600_000,id).run();
      await db.prepare('UPDATE fbs_sync_window SET due_at=? WHERE store_id=?').bind(Date.now()+3_600_000,id).run();
      const claimed=await lease(id),work=await getDueFbsWork(db,claimed);assert.equal(work?.kind,'details');assert.equal((work as FbsDetailsWork).postingNumber,'order-1-1');
      assert.ok(await commitFbsDetailFailure(db,claimed,work as FbsDetailsWork,'invalid_response'));
      assert.equal(await commitFbsDetailFailure(db,claimed,work as FbsDetailsWork,'invalid_response'),false);
    }
    const stats=await getFbsCounts(db,actor,id);assert.equal(stats?.failedCount,1);assert.equal(stats?.readyCount,1);
    assert.deepEqual(await db.prepare("SELECT last_success_at,last_error,failures FROM store_sync_source WHERE store_id=? AND source='fbs_postings'").bind(id).first(),{last_success_at:123,last_error:'preserved',failures:2});
    await list(id,[posting()]);assert.equal((await getFbsCounts(db,actor,id))?.failedCount,1);
    const other=await detailWork(id);assert.equal(other.work.postingNumber,'order-1-2');assert.ok(await commitFbsDetails(db,other.lease,other.work,posting('order-1-2')));
  });
  await context.test('reenable preserves windows and moves complete and failed detail tasks to the new epoch',async()=>{
    const id=await add('fbs-resume');await list(id,[posting(),posting('order-1-2')]);await details(id);
    await db.prepare("UPDATE fbs_posting SET detail_state='error',detail_attempt=3,detail_error='invalid_response' WHERE store_id=? AND posting_number='order-1-2'").bind(id).run();
    const before=await db.prepare('SELECT since,"to",cursor,last_completed_to FROM fbs_sync_window WHERE store_id=?').bind(id).first();
    const due=await db.prepare('SELECT detail_due_at FROM fbs_posting WHERE store_id=?').bind(id).first('detail_due_at');
    const stopped=await setSyncSourceEnabled(db,actor,id,'fbs_postings',1,false);assert.ok(stopped);
    const enabled=await setSyncSourceEnabled(db,actor,id,'fbs_postings',stopped.epoch,true);assert.ok(enabled);
    assert.deepEqual(await db.prepare('SELECT since,"to",cursor,last_completed_to FROM fbs_sync_window WHERE store_id=?').bind(id).first(),before);
    assert.equal(await db.prepare('SELECT detail_epoch FROM fbs_posting WHERE store_id=?').bind(id).first('detail_epoch'),enabled.epoch);
    assert.equal(await db.prepare('SELECT detail_due_at FROM fbs_posting WHERE store_id=?').bind(id).first('detail_due_at'),due);
    assert.deepEqual(await db.prepare("SELECT detail_state,detail_attempt,detail_epoch FROM fbs_posting WHERE store_id=? AND posting_number='order-1-2'").bind(id).first(),{detail_state:'pending',detail_attempt:0,detail_epoch:enabled.epoch});
    const job=await detailWork(id);assert.ok(await commitFbsDetails(db,job.lease,job.work,posting()));
  });
  await context.test('an obsolete detail revision cannot overwrite a newer list generation even with a fresh lease',async()=>{
    const id=await add('fbs-old-detail');await list(id);const old=await detailWork(id);
    await db.prepare('UPDATE store_coordinator SET lease_until=1 WHERE store_id=?').bind(id).run();
    await list(id,[posting('order-1-1','changed')]);
    const current=await detailWork(id);
    assert.equal(await commitFbsDetails(db,current.lease,old.work,posting()),false);
    assert.equal(await commitFbsDetailFailure(db,current.lease,old.work,'invalid_response'),false);
    assert.equal(await count(id,'details'),0);
    assert.ok(await commitFbsDetails(db,current.lease,current.work,posting('order-1-1','changed')));
  });
  await context.test('list and details alternate, cursor loops preserve the window and stale generations cannot commit',async()=>{
    const id=await add('fbs-fences');await list(id,[posting()],true,'A');
    await db.prepare('UPDATE fbs_sync_window SET due_at=1 WHERE store_id=?').bind(id).run();
    const claimed=await lease(id),work=await getDueFbsWork(db,claimed);assert.equal(work?.kind,'details');assert.ok(await commitFbsDetails(db,claimed,work as FbsDetailsWork,posting()));
    const page=await listWork(id);assert.equal(page.work.cursor,'A');
    await assert.rejects(commitFbsList(db,page.lease,page.work,{postings:[posting()],cursor:'A',hasNext:true}),/cursor_stalled/);
    assert.equal((await getFbsCounts(db,actor,id))?.lastCompletedTo,null);
    await db.prepare('UPDATE store_coordinator SET lease_until=1 WHERE store_id=?').bind(id).run();
    const replacement=await lease(id);assert.equal(await commitFbsList(db,page.lease,page.work,{postings:[],cursor:null,hasNext:false}),false);
    assert.equal(await commitFbsList(db,{...replacement,source:'products'},page.work,{postings:[],cursor:null,hasNext:false}),false);
    await db.prepare('UPDATE store SET credential_version=credential_version+1,revision=revision+1 WHERE id=?').bind(id).run();
    assert.equal(await getDueFbsWork(db,replacement),null);assert.equal(await commitFbsList(db,replacement,page.work,{postings:[],cursor:null,hasNext:false}),false);
  });
  await context.test('snapshot scope and current access prevent cross-company data exposure',async()=>{
    const id=await add('fbs-scope');await list(id);
    await assert.rejects(db.prepare('INSERT INTO fbs_posting_observation(id,organization_id,store_id,posting_number,source,facts,observed_at) VALUES (?,?,?,?,?,?,1)').bind('wrong-scope','other-fbs-org',id,'order-1-1','list','{}').run(),/FOREIGN KEY/);
    assert.equal(await getFbsCounts(db,{...actor,orgId:'other-fbs-org'},id),null);
    await db.prepare("DELETE FROM member WHERE id='fbs-member'").run();assert.equal(await getFbsCounts(db,actor,id),null);
  });
});
