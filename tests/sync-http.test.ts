import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { hashPassword } from 'better-auth/crypto';
import { createApp } from '../src/application.ts';
import { services } from '../src/modules/identity/services.ts';

async function fixture() {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("sync-http-fixture")}}',
    compatibilityDate: '2026-06-01', d1Databases: { DB: crypto.randomUUID() } });
  try {
    const DB = await mf.getD1Database('DB') as unknown as D1Database;
    const dir = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) {
      for (const statement of readFileSync(new URL(name, dir), 'utf8').split('--> statement-breakpoint').map(part => part.trim()).filter(Boolean)) await DB.prepare(statement).run();
    }
    const password = 'synthetic-sync-user-password';
    const hash = await hashPassword(password);
    await DB.prepare("INSERT INTO organization (id,name,slug,created_at) VALUES ('company','Company','company',1),('other-company','Other','other',1)").run();
    for (const [id, company, role] of [['owner','company','owner'],['staff','company','member'],['other','other-company','owner']]) {
      await DB.batch([
        DB.prepare('INSERT INTO user (id,name,email,email_verified) VALUES (?,?,?,1)').bind(id,id,`${id}@example.invalid`),
        DB.prepare("INSERT INTO account (id,account_id,provider_id,user_id,password,updated_at) VALUES (?,?,'credential',?,?,1)").bind(`account-${id}`,id,id,hash),
        DB.prepare('INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES (?,?,?,?,1)').bind(`${id}-member`,company,id,role),
      ]);
    }
    const wakes: unknown[] = [];
    let failWake = false;
    let wakeTask: (() => Promise<unknown>) | undefined;
    const namespace = { getByName: (name: string) => ({ async wake(scope: unknown) { wakes.push({ name, scope }); if (failWake) throw new Error('Synthetic failed wake'); await wakeTask?.(); } }) };
    const env = { DB, APP_BASE_URL:'https://sync.example.invalid', BETTER_AUTH_SECRET:'synthetic-sync-auth-secret-at-least-thirty-two',
      STORE_CREDENTIAL_KEYS: JSON.stringify({ test: btoa('s'.repeat(32)) }), STORE_CREDENTIAL_ACTIVE_KEY:'test',
      STORE_COORDINATOR: namespace };
    const app = createApp();
    const cookies: Record<string,string> = {};
    for (const id of ['owner','staff','other']) {
      const response = await services(env)!.auth.api.signInEmail({ body:{email:`${id}@example.invalid`,password},asResponse:true });
      cookies[id] = response.headers.getSetCookie().map(value => value.split(';',1)[0]).join('; ');
    }
    const storeId = crypto.randomUUID();
    const request = (suffix = '/sync', body?: unknown, actor = 'owner', company = 'company', origin = env.APP_BASE_URL) => app.request(`${env.APP_BASE_URL}/api/companies/${company}/stores/${storeId}${suffix}`, {
      method:body === undefined ? 'GET':'POST',headers:{cookie:cookies[actor] ?? '',origin,'content-type':'application/json'},
      ...(body === undefined ? {} : {body:JSON.stringify(body)}),
    },env as never);
    const created = await app.request(`${env.APP_BASE_URL}/api/companies/company/stores`,{method:'POST',headers:{cookie:cookies.owner!,origin:env.APP_BASE_URL,'content-type':'application/json'},body:JSON.stringify({id:storeId,name:'Synthetic sync store',clientId:'12345',apiKey:'synthetic-sync-platform-key'})},env as never);
    assert.equal(created.status,200);
    const qualify = (available = ['auth','chats_read']) => DB.prepare("UPDATE store SET status='partial',capabilities=?,checked_at=?,expires_at=? WHERE id=?")
      .bind(JSON.stringify(['auth','products_read','chats_read','orders_fbs_read','reply','proactive_chat'].map(code => ({code,status:available.includes(code)?'available':'unknown',reason:'read_verified'}))),Date.now(),Date.now()+86_400_000,storeId).run();
    return { DB,env,request,storeId,wakes,qualify,failWake:()=>{failWake=true;},onWake:(task:()=>Promise<unknown>)=>{wakeTask=task;},close:()=>mf.dispose() };
  } catch (error) {
    await mf.dispose().catch(() => {});
    throw error;
  }
}

test('sync HTTP fixture cleanup preserves the initialization error even when disposal rejects', {timeout:30_000}, async t => {
  const failure = Object.assign(new Error('synthetic initialization failure'),{code:'EADDRNOTAVAIL'});
  const originalDispose = Miniflare.prototype.dispose;
  let instance: Miniflare | undefined, closed = false;
  t.mock.method(Miniflare.prototype,'getD1Database',async function(this:Miniflare) { instance=this; throw failure; });
  const disposal = t.mock.method(Miniflare.prototype,'dispose',async function(this:Miniflare) {
    await originalDispose.call(this); closed=true; throw new Error('synthetic cleanup failure');
  });
  try {
    await assert.rejects(fixture,error=>error===failure);
    assert.equal(disposal.mock.calls.length,1); assert.equal(closed,true);
  } finally { if(instance&&!closed) await originalDispose.call(instance); }
});

test('sync is disabled until an authorized manager explicitly enables a store with fresh readable chat evidence', {timeout:30_000}, async () => {
  const f = await fixture();
  try {
    let response = await f.request(); assert.equal(response.status,200);
    const initial = await response.json() as { sync:{enabled:boolean;epoch:number};configured:boolean };
    assert.equal(initial.sync.enabled,false); assert.equal(initial.sync.epoch,0); assert.equal(initial.configured,true);
    assert.equal((await f.request('/sync',{enabled:true,expectedEpoch:0})).status,409);
    await f.qualify();
    response = await f.request('/sync',{enabled:true,expectedEpoch:0}); assert.equal(response.status,200);
    const enabled = await response.json() as {sync:{enabled:boolean;epoch:number;storeId:string};wakePending:boolean};
    assert.equal(enabled.sync.enabled,true); assert.equal(enabled.sync.epoch,1); assert.equal(enabled.sync.storeId,f.storeId);
    assert.equal(enabled.wakePending,false); assert.equal(f.wakes.length,1);
    assert.equal((await f.request('/sync',{enabled:true,expectedEpoch:0})).status,409);
    assert.equal(f.wakes.length,1);
    response = await f.request('/sync',{enabled:false,expectedEpoch:1}); assert.equal(response.status,200);
    assert.equal((await response.json() as {sync:{enabled:boolean}}).sync.enabled,false);
    const audit = await f.DB.prepare("SELECT action,outcome FROM store_audit_event WHERE action LIKE 'store.sync.%' ORDER BY created_at,id").all();
    for (const action of ['store.sync.enable','store.sync.disable']) assert.ok(audit.results.some(row=>row.action===action&&row.outcome==='succeeded'));
  } finally { await f.close(); }
});

test('sync state and controls enforce the current company, store grant, verified identity and request origin', {timeout:30_000}, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/sync',undefined,'anonymous')).status,401);
    assert.equal((await f.request('/sync',undefined,'other','company')).status,404);
    assert.equal((await f.request('/sync',undefined,'staff')).status,404);
    await f.DB.prepare("INSERT INTO store_grant (organization_id,store_id,member_id,created_at) VALUES ('company',?,'staff-member',1)").bind(f.storeId).run();
    assert.equal((await f.request('/sync',undefined,'staff')).status,200);
    assert.equal((await f.request('/sync',{enabled:true,expectedEpoch:0},'staff')).status,403);
    assert.equal((await f.request('/sync',{enabled:true,expectedEpoch:0},'owner','company','https://elsewhere.example.invalid')).status,403);
    await f.DB.prepare("DELETE FROM member WHERE id='staff-member'").run();
    assert.equal((await f.request('/sync',undefined,'staff')).status,404);
    assert.equal(f.wakes.length,0);
  } finally { await f.close(); }
});

test('failed wake preserves the durable enabled intent and a repeated command never repeats the write', {timeout:30_000}, async () => {
  const f = await fixture();
  try {
    await f.qualify(); f.failWake();
    const response = await f.request('/sync',{enabled:true,expectedEpoch:0}); assert.equal(response.status,200);
    const state = await response.json() as {sync:{enabled:boolean;epoch:number};wakePending:boolean};
    assert.equal(state.wakePending,true); assert.equal(state.sync.enabled,true); assert.equal(state.sync.epoch,1);
    assert.equal((await f.request('/sync',{enabled:true,expectedEpoch:0})).status,409);
    const reread = await f.request(); assert.equal((await reread.json() as {sync:{enabled:boolean}}).sync.enabled,true);
    assert.equal(f.wakes.length,1);
  } finally { await f.close(); }
});

test('missing sync runtime blocks enable without blocking read access or the ability to disable', {timeout:30_000}, async () => {
  const f = await fixture();
  try {
    await f.qualify();
    assert.equal((await f.request('/sync',{enabled:true,expectedEpoch:0})).status,200);
    Reflect.deleteProperty(f.env,'STORE_COORDINATOR');
    const read = await f.request(); assert.equal(read.status,200);
    assert.equal((await read.json() as {configured:boolean}).configured,false);
    assert.equal((await f.request('/sync',{enabled:false,expectedEpoch:1})).status,200);
    const enable = await f.request('/sync',{enabled:true,expectedEpoch:2}); assert.equal(enable.status,503);
    assert.equal((await enable.json() as {error:{code:string}}).error.code,'SYNC_NOT_CONFIGURED');
  } finally { await f.close(); }
});

test('sync audit failure prevents an unaudited start and reports uncertainty after a completed write', {timeout:30_000}, async () => {
  const f = await fixture();
  try {
    await f.qualify();
    await f.DB.prepare("CREATE TRIGGER fail_sync_intent BEFORE INSERT ON store_audit_event WHEN NEW.action LIKE 'store.sync.%' AND NEW.outcome='started' BEGIN SELECT RAISE(ABORT,'synthetic-audit-failure'); END").run();
    let response = await f.request('/sync',{enabled:true,expectedEpoch:0});
    assert.equal(response.status,503); assert.equal((await response.json() as {error:{code:string}}).error.code,'AUDIT_UNAVAILABLE');
    assert.equal((await (await f.request()).json() as {sync:{enabled:boolean}}).sync.enabled,false);
    assert.equal(f.wakes.length,0);
    await f.DB.prepare('DROP TRIGGER fail_sync_intent').run();
    await f.DB.prepare("CREATE TRIGGER fail_sync_result BEFORE INSERT ON store_audit_event WHEN NEW.action LIKE 'store.sync.%' AND NEW.outcome='succeeded' BEGIN SELECT RAISE(ABORT,'synthetic-audit-failure'); END").run();
    response = await f.request('/sync',{enabled:true,expectedEpoch:0});
    assert.equal(response.status,503); assert.equal((await response.json() as {error:{code:string}}).error.code,'OPERATION_UNCONFIRMED');
    assert.equal((await (await f.request()).json() as {sync:{enabled:boolean}}).sync.enabled,true);
    assert.equal(f.wakes.length,1);
    assert.equal((await f.request('/sync',{enabled:true,expectedEpoch:0})).status,409);
  } finally { await f.close(); }
});

test('a sync command acknowledges its committed transition even when background work changes the state before the response', {timeout:30_000}, async () => {
  const f = await fixture();
  try {
    await f.qualify();
    f.onWake(()=>f.DB.prepare("UPDATE store SET status='paused',revision=revision+1 WHERE id=?").bind(f.storeId).run());
    const response = await f.request('/sync',{enabled:true,expectedEpoch:0}); assert.equal(response.status,200);
    const result = await response.json() as {sync:{enabled:boolean;epoch:number}};
    assert.equal(result.sync.enabled,true); assert.equal(result.sync.epoch,1);
    const current = await (await f.request()).json() as {sync:{enabled:boolean;epoch:number}};
    assert.equal(current.sync.enabled,false); assert.equal(current.sync.epoch,2);
  } finally { await f.close(); }
});

test('product synchronization requires its own capability and can run without enabling chat', {timeout:30_000}, async () => {
  const f = await fixture();
  try {
    let response = await f.request('/sync/products'); assert.equal(response.status,200);
    assert.deepEqual((await response.json() as {sync:unknown}).sync, {
      storeId:f.storeId,source:'products',enabled:false,epoch:0,dueAt:new Date(0).toISOString(),lastSuccessAt:null,
      blockedUntil:null,lastError:null,failures:0,running:false,productCount:0,readyCount:0,pendingCount:0,failedCount:0,
    });
    await f.qualify();
    assert.equal((await f.request('/sync/products',{enabled:true,expectedEpoch:0})).status,409);
    await f.qualify(['auth','products_read']);
    response = await f.request('/sync/products',{enabled:true,expectedEpoch:0}); assert.equal(response.status,200);
    const result = await response.json() as {sync:{source:string;enabled:boolean;epoch:number};wakePending:boolean};
    assert.equal(result.sync.source,'products'); assert.equal(result.sync.enabled,true); assert.equal(result.sync.epoch,1);
    assert.equal(result.wakePending,false);
    assert.equal((await (await f.request()).json() as {sync:{enabled:boolean;epoch:number}}).sync.enabled,false);
    assert.equal((await f.request('/sync',{enabled:true,expectedEpoch:0})).status,409);
    assert.equal((await f.request('/sync/products',{enabled:true,expectedEpoch:0})).status,409);
    response = await f.request('/sync/products',{enabled:false,expectedEpoch:1}); assert.equal(response.status,200);
    const audit = await f.DB.prepare("SELECT action,outcome FROM store_audit_event WHERE action LIKE 'store.sync.products.%'").all();
    for (const action of ['store.sync.products.enable','store.sync.products.disable']) assert.ok(audit.results.some(row=>row.action===action&&row.outcome==='succeeded'));
  } finally { await f.close(); }
});

test('product sync enforces store grants, current roles, strict input and source-specific audit', {timeout:30_000}, async () => {
  const f = await fixture();
  try {
    await f.qualify(['auth','products_read']);
    assert.equal((await f.request('/sync/products',undefined,'other')).status,404);
    assert.equal((await f.request('/sync/products',undefined,'staff')).status,404);
    assert.equal((await f.request('/sync/products',undefined,'anonymous')).status,401);
    await f.DB.prepare("INSERT INTO store_grant (organization_id,store_id,member_id,created_at) VALUES ('company',?,'staff-member',1)").bind(f.storeId).run();
    assert.equal((await f.request('/sync/products',undefined,'staff')).status,200);
    assert.equal((await f.request('/sync/products',{enabled:true,expectedEpoch:0},'staff')).status,403);
    assert.equal((await f.request('/sync/products',{enabled:true,expectedEpoch:0,source:'chat'})).status,400);
    assert.equal((await f.request('/sync/products',{enabled:true,expectedEpoch:0},'owner','company','https://elsewhere.example.invalid')).status,403);
    await f.DB.prepare("CREATE TRIGGER fail_product_intent BEFORE INSERT ON store_audit_event WHEN NEW.action='store.sync.products.enable' AND NEW.outcome='started' BEGIN SELECT RAISE(ABORT,'synthetic-audit-failure'); END").run();
    assert.equal((await f.request('/sync/products',{enabled:true,expectedEpoch:0})).status,503);
    assert.equal((await (await f.request('/sync/products')).json() as {sync:{enabled:boolean}}).sync.enabled,false);
    assert.equal(f.wakes.length,0);
    await f.DB.prepare("DELETE FROM store_grant WHERE store_id=?").bind(f.storeId).run();
    assert.equal((await f.request('/sync/products',undefined,'staff')).status,404);
  } finally { await f.close(); }
});

test('product intent survives a lost wake, while missing runtime still permits a later stop', {timeout:30_000}, async () => {
  const f = await fixture();
  try {
    await f.qualify(['auth','products_read']); f.failWake();
    const response = await f.request('/sync/products',{enabled:true,expectedEpoch:0}); assert.equal(response.status,200);
    assert.equal((await response.json() as {wakePending:boolean}).wakePending,true);
    Reflect.deleteProperty(f.env,'STORE_COORDINATOR');
    assert.equal((await (await f.request('/sync/products')).json() as {configured:boolean}).configured,false);
    assert.equal((await f.request('/sync/products',{enabled:false,expectedEpoch:1})).status,200);
    assert.equal((await f.request('/sync/products',{enabled:true,expectedEpoch:2})).status,503);
    assert.equal((await f.request('/sync/anything', {enabled:true,expectedEpoch:0})).status,404);
  } finally { await f.close(); }
});

test('FBS synchronization starts only with its own capability and reports an explicit historical window', {timeout:30_000}, async () => {
  const f = await fixture();
  try {
    let response = await f.request('/sync/fbs-postings'); assert.equal(response.status,200);
    const empty = (await response.json() as {sync:Record<string,unknown>}).sync;
    assert.deepEqual(empty, {storeId:f.storeId,source:'fbs_postings',enabled:false,epoch:0,dueAt:new Date(0).toISOString(),lastSuccessAt:null,
      blockedUntil:null,lastError:null,failures:0,running:false,postingCount:0,readyCount:0,pendingCount:0,failedCount:0,
      historyStart:null,windowSince:null,windowTo:null,lastCompletedTo:null});
    await f.qualify(['auth','products_read','chats_read']);
    response = await f.request('/sync/fbs-postings',{enabled:true,expectedEpoch:0});
    assert.equal(response.status,409); assert.equal((await response.json() as {error:{code:string}}).error.code,'FBS_SYNC_CAPABILITY_REQUIRED');
    await f.qualify(['auth','orders_fbs_read']);
    const before = Date.now();
    response = await f.request('/sync/fbs-postings',{enabled:true,expectedEpoch:0}); assert.equal(response.status,200);
    const sync = (await response.json() as {sync:{source:string;enabled:boolean;epoch:number;historyStart:string;windowSince:string;windowTo:string;lastCompletedTo:null}}).sync;
    assert.equal(sync.source,'fbs_postings'); assert.equal(sync.enabled,true); assert.equal(sync.epoch,1);
    assert.equal(Date.parse(sync.windowTo)-Date.parse(sync.historyStart),30*86_400_000);
    assert.equal(sync.windowSince,sync.historyStart); assert.equal(sync.lastCompletedTo,null);
    assert.ok(Date.parse(sync.windowTo)>=before && Date.parse(sync.windowTo)<=Date.now());
    for (const path of ['/sync','/sync/products']) {
      assert.equal((await (await f.request(path)).json() as {sync:{enabled:boolean}}).sync.enabled,false);
      assert.equal((await f.request(path,{enabled:true,expectedEpoch:0})).status,409);
    }
    assert.equal((await f.request('/sync/fbs-postings',{enabled:false,expectedEpoch:0})).status,409);
    assert.equal((await f.request('/sync/fbs-postings',{enabled:false,expectedEpoch:1})).status,200);
    const stopped = (await (await f.request('/sync/fbs-postings')).json() as {sync:typeof sync}).sync;
    assert.equal(stopped.historyStart,sync.historyStart); assert.equal(stopped.windowTo,sync.windowTo);
    const audit = await f.DB.prepare("SELECT action,outcome FROM store_audit_event WHERE action LIKE 'store.sync.fbs_postings.%'").all();
    for (const action of ['store.sync.fbs_postings.enable','store.sync.fbs_postings.disable']) assert.ok(audit.results.some(row=>row.action===action && row.outcome==='succeeded'));
  } finally { await f.close(); }
});

test('FBS synchronization requires current membership and grants and never accepts a client-selected source', {timeout:30_000}, async () => {
  const f = await fixture();
  try {
    await f.qualify(['auth','orders_fbs_read']);
    for (const [actor,status] of [['other',404],['staff',404],['anonymous',401]] as const) assert.equal((await f.request('/sync/fbs-postings',undefined,actor)).status,status);
    await f.DB.prepare("INSERT INTO store_grant (organization_id,store_id,member_id,created_at) VALUES ('company',?,'staff-member',1)").bind(f.storeId).run();
    assert.equal((await f.request('/sync/fbs-postings',undefined,'staff')).status,200);
    assert.equal((await f.request('/sync/fbs-postings',{enabled:true,expectedEpoch:0},'staff')).status,403);
    assert.equal((await f.request('/sync/fbs-postings',{enabled:true,expectedEpoch:0,source:'products'})).status,400);
    assert.equal((await f.request('/sync/fbs-postings',{enabled:true,expectedEpoch:0},'owner','company','https://other.example.invalid')).status,403);
    await f.DB.prepare("CREATE TRIGGER fail_fbs_intent BEFORE INSERT ON store_audit_event WHEN NEW.action='store.sync.fbs_postings.enable' AND NEW.outcome='started' BEGIN SELECT RAISE(ABORT,'synthetic-audit-failure'); END").run();
    assert.equal((await f.request('/sync/fbs-postings',{enabled:true,expectedEpoch:0})).status,503);
    assert.equal(f.wakes.length,0);
    assert.equal((await (await f.request('/sync/fbs-postings')).json() as {sync:{enabled:boolean}}).sync.enabled,false);
    await f.DB.prepare('DELETE FROM store_grant WHERE store_id=?').bind(f.storeId).run();
    assert.equal((await f.request('/sync/fbs-postings',undefined,'staff')).status,404);
  } finally { await f.close(); }
});

test('FBS durable intent survives a lost wake and its receipt belongs to the committed command', {timeout:30_000}, async () => {
  const f = await fixture();
  try {
    await f.qualify(['auth','orders_fbs_read']); f.failWake();
    let response = await f.request('/sync/fbs-postings',{enabled:true,expectedEpoch:0}); assert.equal(response.status,200);
    assert.equal((await response.json() as {wakePending:boolean}).wakePending,true);
    Reflect.deleteProperty(f.env,'STORE_COORDINATOR');
    assert.equal((await f.request('/sync/fbs-postings',{enabled:false,expectedEpoch:1})).status,200);
    assert.equal((await f.request('/sync/fbs-postings',{enabled:true,expectedEpoch:2})).status,503);
  } finally { await f.close(); }
  const g = await fixture();
  try {
    await g.qualify(['auth','orders_fbs_read']);
    g.onWake(()=>g.DB.prepare("UPDATE store SET status='paused',revision=revision+1 WHERE id=?").bind(g.storeId).run());
    const response = await g.request('/sync/fbs-postings',{enabled:true,expectedEpoch:0}); assert.equal(response.status,200);
    assert.equal((await response.json() as {sync:{enabled:boolean}}).sync.enabled,true);
    assert.equal((await (await g.request('/sync/fbs-postings')).json() as {sync:{enabled:boolean}}).sync.enabled,false);
  } finally { await g.close(); }
});
