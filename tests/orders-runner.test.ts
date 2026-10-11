import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { encryptCredentials } from '../src/modules/stores/credentials.ts';
import { runSyncPage, retrySyncFailure } from '../src/modules/sync/runner.ts';
import { setSyncSourceEnabled } from '../src/modules/sync/storage.ts';
import { OzonReadError } from '../src/modules/orders/ozon.ts';

const scope = { orgId:'org',storeId:'store' }, actor = {orgId:'org',actorUserId:'admin',sessionId:'session'};
const day = 86_400_000, hour = 3_600_000;
const posting = {posting_number:'order-1-1',order_id:'9000000000817031942',order_number:'order-1',status:'delivered',products:[{sku:'9000000000817031943',offer_id:'article',quantity:1,price:'123.4500',currency_code:'RUB'}]};
const another = {...posting,posting_number:'order-1-2'};
const list = (postings: unknown[], cursor: string|null = null) => Response.json({postings,has_next:cursor!==null,...(cursor===null?{}:{cursor})});

async function fixture(context:TestContext,all=false) {
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  context.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB') as unknown as D1Database;
  const folder=new URL('../migrations/',import.meta.url);
  for(const file of readdirSync(folder).filter(name=>name.endsWith('.sql')).sort()) for(const sql of readFileSync(new URL(file,folder),'utf8').split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean)) await db.prepare(sql).run();
  const env={DB:db,STORE_CREDENTIAL_KEYS:JSON.stringify({v1:btoa('a'.repeat(32))}),STORE_CREDENTIAL_ACTIVE_KEY:'v1'};
  const envelope=await encryptCredentials(env,{...scope,platformStoreId:'123456',credentialVersion:1},{apiKey:'synthetic-fbs-secret'});
  await db.batch([
    db.prepare("INSERT INTO organization (id,name,slug,created_at) VALUES ('org','Org','org',1)"),
    db.prepare("INSERT INTO user (id,name,email,email_verified) VALUES ('admin','Admin','fbs@example.invalid',1)"),
    db.prepare("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('member','org','admin','admin',1)"),
    db.prepare("INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES ('session','session','admin',?,1,1)").bind(Date.now()+3_600_000),
    db.prepare("INSERT INTO store (id,organization_id,name,platform_store_id,status,credential_key_version,credential_nonce,credential_ciphertext,capabilities,checked_at,expires_at,created_at,updated_at) VALUES ('store','org','Store','123456','verified',?,?,?,?,?,?,1,1)")
      .bind(envelope.keyVersion,envelope.nonce,envelope.ciphertext,JSON.stringify(['auth','orders_fbs_read',...(all?['chats_read','products_read']:[])].map(code=>({code,status:'available'}))),Date.now(),Date.now()+day),
  ]);
  if(all) for(const source of ['chat','products'] as const) assert.ok(await setSyncSourceEnabled(db,actor,scope.storeId,source,0,true));
  assert.ok(await setSyncSourceEnabled(db,actor,scope.storeId,'fbs_postings',0,true));
  const state=(source='fbs_postings')=>db.prepare('SELECT enabled,epoch,last_success_at,last_error,failures FROM store_sync_source WHERE source=?').bind(source).first<{enabled:number;epoch:number;last_success_at:number|null;last_error:string|null;failures:number}>();
  const ready=async(windows=true)=>{
    await db.batch([db.prepare('UPDATE store_sync_source SET due_at=0'),db.prepare('UPDATE fbs_posting SET detail_due_at=0'),db.prepare('UPDATE product_sync_cursor SET due_at=0'),db.prepare('UPDATE sync_cursor SET due_at=0')]);
    if(windows)await db.prepare('UPDATE fbs_sync_window SET due_at=0').run();
  };
  const fbsFirst=()=>db.prepare("UPDATE store_sync_source SET due_at=? WHERE source<>'fbs_postings'").bind(Date.now()+60_000).run();
  return {db,env,state,ready,fbsFirst};
}

test('FBS permission classifications are separate from chat and product errors',()=>{
  assert.equal(retrySyncFailure({code:'permission_denied'},'fbs-list',0,0,0).code,'fbs_list_permission_denied');
  assert.equal(retrySyncFailure({code:'permission_denied'},'fbs-detail',0,0,0).code,'fbs_details_permission_denied');
  assert.equal(retrySyncFailure({code:'permission_denied'},'fbs-detail',0,0,0).disable,true);
});

test('FBS alone preserves a frozen window across pages and hydrates split postings separately', {timeout:30_000},async context=>{
  const {db,env,ready}=await fixture(context);
  const requests:{path:string;body:Record<string,any>}[]=[];
  const fetcher=(async(input,init)=>{
    const path=new URL(String(input)).pathname,body=JSON.parse(String(init?.body));requests.push({path,body});
    assert.equal(new Headers(init?.headers).get('Api-Key'),'synthetic-fbs-secret');
    if(path==='/v4/posting/fbs/list')return body.cursor?list([]):list([posting,another],'next-page');
    if(path==='/v3/posting/fbs/get')return Response.json({result:body.posting_number===posting.posting_number?posting:another});
    throw new Error('Unexpected synthetic request');
  }) as typeof fetch;
  for(let index=0;index<4;index++){await ready();await runSyncPage(env,scope,{fetcher});}
  const lists=requests.filter(request=>request.path==='/v4/posting/fbs/list');assert.equal(lists.length,2);
  assert.deepEqual(lists[0].body.filter,lists[1].body.filter);assert.equal(lists[1].body.cursor,'next-page');
  const duration=Date.parse(lists[0].body.filter.to)-Date.parse(lists[0].body.filter.since);
  assert.ok(duration>=30*day && duration<=30*day+5_000);
  assert.equal(await db.prepare('SELECT last_completed_to FROM fbs_sync_window').first('last_completed_to'),Date.parse(lists[0].body.filter.to));
  const rows=await db.prepare('SELECT posting_number,order_id,detail_facts FROM fbs_posting ORDER BY posting_number').all<{posting_number:string;order_id:string;detail_facts:string}>();
  assert.deepEqual(rows.results.map(row=>row.posting_number),[posting.posting_number,another.posting_number]);
  assert.deepEqual(rows.results.map(row=>row.order_id),[posting.order_id,posting.order_id]);
  assert.equal(JSON.parse(rows.results[0].detail_facts).products[0].price,'123.4500');
  assert.equal(await db.prepare("SELECT count(*) FROM store_sync_source WHERE source<>'fbs_postings'").first('count(*)'),0);
});

test('long downtime is covered by bounded overlapping windows without jumping to the latest month', {timeout:30_000},async context=>{
  const {db,env,ready}=await fixture(context),now=Date.now(),oldTo=now-120*day;
  await db.prepare("UPDATE fbs_sync_window SET history_start=?,since=?,`to`=?,last_completed_to=?,state='waiting',cursor=NULL,due_at=0").bind(oldTo-30*day,oldTo-30*day,oldTo,oldTo).run();
  const windows:{since:string;to:string}[]=[];
  const fetcher=(async(_input,init)=>{windows.push(JSON.parse(String(init?.body)).filter);return list([]);}) as typeof fetch;
  for(let index=0;index<5;index++){await ready();await runSyncPage(env,scope,{fetcher,now:()=>now});}
  assert.equal(windows.length,4);assert.equal(Date.parse(windows[0].since),oldTo-hour);
  windows.forEach((window,index)=>{
    assert.ok(Date.parse(window.to)>Date.parse(window.since));assert.ok(Date.parse(window.to)-Date.parse(window.since)<=31*day);
    if(index)assert.equal(Date.parse(window.since),Date.parse(windows[index-1].to)-hour);
  });
  assert.equal(Date.parse(windows.at(-1)!.to),now);
  assert.equal(await db.prepare('SELECT last_completed_to FROM fbs_sync_window').first('last_completed_to'),now);
  await ready();await runSyncPage(env,scope,{fetcher,now:()=>now-day});
  assert.equal(windows.length,4,'a backwards clock cannot create another API window');
  assert.equal(await db.prepare('SELECT last_completed_to FROM fbs_sync_window').first('last_completed_to'),now);
});

test('a clock behind the completed window preserves storage waiting time instead of polling every thirty seconds', {timeout:30_000},async context=>{
  const {db,env,state}=await fixture(context),futureTo=Date.now()+hour;
  await db.prepare("UPDATE fbs_sync_window SET since=?,`to`=?,last_completed_to=?,state='waiting',cursor=NULL,due_at=0").bind(futureTo-30*day,futureTo,futureTo).run();
  await db.prepare("UPDATE store_sync_source SET due_at=0 WHERE source='fbs_postings'").run();
  let calls=0;await runSyncPage(env,scope,{fetcher:(async()=>{calls++;return list([]);}) as typeof fetch});
  assert.equal(calls,0);assert.equal((await state())!.last_success_at,null);
  assert.ok((await db.prepare("SELECT due_at FROM store_sync_source WHERE source='fbs_postings'").first<number>('due_at'))!>futureTo);
  assert.equal(await db.prepare('SELECT lease_token FROM store_coordinator').first('lease_token'),null);
});

test('persistent fairness includes all three sources without requiring chat for FBS', {timeout:30_000},async context=>{
  const {env,ready}=await fixture(context,true);const calls:string[]=[];
  const fetcher=(async input=>{
    const path=new URL(String(input)).pathname;calls.push(path);
    if(path==='/v3/chat/list')return Response.json({chats:[],has_next:false});
    if(path==='/v3/product/list')return Response.json({result:{items:[],last_id:'',total:0}});
    if(path==='/v4/posting/fbs/list')return list([]);
    throw new Error('Unexpected synthetic request');
  }) as typeof fetch;
  for(let index=0;index<9;index++){await ready();await runSyncPage(env,scope,{fetcher});}
  assert.equal(calls.length,9);
  for(let index=0;index<9;index+=3)assert.deepEqual(new Set(calls.slice(index,index+3)),new Set(['/v3/chat/list','/v3/product/list','/v4/posting/fbs/list']));
});

test('a failing posting has three bounded attempts, retains old facts and does not block another posting', {timeout:30_000},async context=>{
  const {db,env,state,ready}=await fixture(context);
  await runSyncPage(env,scope,{fetcher:(async()=>list([posting,another])) as typeof fetch});
  await runSyncPage(env,scope,{fetcher:(async()=>Response.json({result:posting})) as typeof fetch});
  const oldFacts=await db.prepare('SELECT detail_facts FROM fbs_posting WHERE posting_number=?').bind(posting.posting_number).first('detail_facts');assert.ok(oldFacts);
  await db.prepare('UPDATE fbs_posting SET detail_due_at=? WHERE posting_number=?').bind(Date.now()+day,another.posting_number).run();
  const lastSuccess=(await state())!.last_success_at;
  const failures:[typeof fetch,string][]=[
    [(async()=>{throw new TypeError('synthetic network failure');}) as typeof fetch,'network_error'],
    [(async()=>new Response('',{status:503})) as typeof fetch,'provider_unavailable'],
    [(async()=>Response.json({result:{...posting,posting_number:'wrong-package'}})) as typeof fetch,'invalid_response'],
  ];
  for(const [fetcher,code] of failures){
    await db.prepare("UPDATE store_sync_source SET due_at=0 WHERE source='fbs_postings'").run();
    await db.prepare('UPDATE fbs_posting SET detail_due_at=0 WHERE posting_number=?').bind(posting.posting_number).run();
    await runSyncPage(env,scope,{fetcher});
    assert.equal((await state())!.last_success_at,lastSuccess,'failed details cannot record successful synchronization');
    assert.equal((await state())!.enabled,1);assert.equal((await state())!.failures,0);
    assert.equal(await db.prepare('SELECT detail_error FROM fbs_posting WHERE posting_number=?').bind(posting.posting_number).first('detail_error'),code);
  }
  assert.deepEqual(await db.prepare('SELECT detail_state,detail_attempt,detail_facts FROM fbs_posting WHERE posting_number=?').bind(posting.posting_number).first(),{detail_state:'error',detail_attempt:3,detail_facts:oldFacts});
  await ready(false);
  let requested='';await runSyncPage(env,scope,{fetcher:(async(_input,init)=>{requested=JSON.parse(String(init?.body)).posting_number;return Response.json({result:another});}) as typeof fetch});
  assert.equal(requested,another.posting_number);assert.equal((await state())!.enabled,1);
});

test('detail timeouts stay local and known delivered postings continue refreshing after leaving the list window', {timeout:30_000},async context=>{
  const {db,env,state,ready}=await fixture(context);
  await runSyncPage(env,scope,{fetcher:(async()=>list([posting])) as typeof fetch});
  const before=(await state())!.last_success_at;
  await runSyncPage(env,scope,{fetcher:(async()=>{throw new OzonReadError('timed_out');}) as typeof fetch});
  assert.equal(await db.prepare('SELECT detail_attempt FROM fbs_posting').first('detail_attempt'),1);
  assert.equal((await state())!.last_success_at,before);assert.equal((await state())!.enabled,1);
  await ready(false);await runSyncPage(env,scope,{fetcher:(async()=>Response.json({result:posting})) as typeof fetch});
  const refreshedAt=Date.now();assert.ok((await db.prepare('SELECT detail_due_at FROM fbs_posting').first<number>('detail_due_at'))!>=refreshedAt+15*60_000-1_000);
  await db.prepare("UPDATE store_sync_source SET due_at=0 WHERE source='fbs_postings'").run();await db.prepare('UPDATE fbs_sync_window SET due_at=0').run();
  await runSyncPage(env,scope,{fetcher:(async()=>list([])) as typeof fetch});
  await ready(false);let calls=0;
  await runSyncPage(env,scope,{fetcher:(async input=>{assert.equal(new URL(String(input)).pathname,'/v3/posting/fbs/get');calls++;return Response.json({result:posting});}) as typeof fetch});
  assert.equal(calls,1,'a delivered raw status does not stop refresh permanently');
});

test('the dispatcher deadline is a posting timeout rather than a source-wide aborted failure', {timeout:30_000},async context=>{
  const {db,env,state}=await fixture(context);
  await runSyncPage(env,scope,{fetcher:(async()=>list([posting])) as typeof fetch});
  const before=(await state())!.last_success_at,startedAt=Date.now();let clockReads=0;
  await runSyncPage(env,scope,{
    now:()=>startedAt+(clockReads++===0?0:9_990),
    fetcher:(async()=>new Promise<Response>(()=>{})) as typeof fetch,
  });
  assert.equal((await state())!.enabled,1);assert.equal((await state())!.last_success_at,before);assert.equal((await state())!.failures,0);
  assert.equal(await db.prepare('SELECT detail_error FROM fbs_posting').first('detail_error'),'timed_out');
  assert.equal(await db.prepare('SELECT detail_attempt FROM fbs_posting').first('detail_attempt'),1);
});

test('FBS permissions are isolated, 429 is shared and invalid credentials stop every source', {timeout:30_000},async context=>{
  const {db,env,state,fbsFirst}=await fixture(context,true);await fbsFirst();
  await runSyncPage(env,scope,{fetcher:(async()=>new Response('',{status:403})) as typeof fetch});
  assert.equal((await state())!.last_error,'fbs_list_permission_denied');assert.equal((await state('chat'))!.enabled,1);assert.equal((await state('products'))!.enabled,1);
  assert.ok(await setSyncSourceEnabled(db,actor,scope.storeId,'fbs_postings',(await state())!.epoch,true));
  await runSyncPage(env,scope,{fetcher:(async()=>list([posting])) as typeof fetch});
  await runSyncPage(env,scope,{fetcher:(async()=>new Response('',{status:403})) as typeof fetch});
  assert.equal((await state())!.last_error,'fbs_details_permission_denied');assert.equal((await state('products'))!.enabled,1);
  assert.ok(await setSyncSourceEnabled(db,actor,scope.storeId,'fbs_postings',(await state())!.epoch,true));
  let calls=0;await runSyncPage(env,scope,{fetcher:(async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'120'}});}) as typeof fetch});
  const blocked=await db.prepare('SELECT blocked_until FROM store_coordinator').first<number>('blocked_until');assert.ok(blocked!>Date.now()+119_000);
  const stopped=await setSyncSourceEnabled(db,actor,scope.storeId,'fbs_postings',(await state())!.epoch,false);assert.ok(stopped);
  assert.ok(await setSyncSourceEnabled(db,actor,scope.storeId,'fbs_postings',stopped.epoch,true));
  await db.prepare('UPDATE store_sync_source SET due_at=0').run();
  await runSyncPage(env,scope,{fetcher:(async()=>{calls++;return list([]);}) as typeof fetch});assert.equal(calls,1);
  // Advance beyond the synthetic provider cooldown for the separate 401 scenario.
  await db.prepare('UPDATE store_coordinator SET blocked_until=NULL').run();await fbsFirst();
  await runSyncPage(env,scope,{fetcher:(async()=>new Response('',{status:401})) as typeof fetch});
  assert.equal(await db.prepare('SELECT count(*) FROM store_sync_source WHERE enabled=1').first('count(*)'),0);
});

test('FBS pages are fenced after source stop, credential rotation and lease expiry', {timeout:30_000},async context=>{
  const {db,env,state}=await fixture(context);
  await runSyncPage(env,scope,{fetcher:(async()=>{assert.ok(await setSyncSourceEnabled(db,actor,scope.storeId,'fbs_postings',1,false));return list([posting]);}) as typeof fetch});
  assert.equal(await db.prepare('SELECT count(*) FROM fbs_posting').first('count(*)'),0);assert.equal((await state())!.last_success_at,null);
  assert.ok(await setSyncSourceEnabled(db,actor,scope.storeId,'fbs_postings',(await state())!.epoch,true));
  await runSyncPage(env,scope,{fetcher:(async()=>{await db.prepare('UPDATE store_coordinator SET lease_until=1').run();return list([posting]);}) as typeof fetch});
  assert.equal(await db.prepare('SELECT count(*) FROM fbs_posting').first('count(*)'),0);
  await runSyncPage(env,scope,{fetcher:(async()=>{await db.prepare("UPDATE store SET credential_version=credential_version+1,revision=revision+1,status='unverified'").run();return list([posting]);}) as typeof fetch});
  assert.equal(await db.prepare('SELECT count(*) FROM fbs_posting').first('count(*)'),0);assert.equal((await state())!.enabled,0);
});
