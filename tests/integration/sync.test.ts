import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Miniflare, Response as WorkerResponse } from 'miniflare';
import { encryptCredentials } from '../../src/modules/stores/credentials.ts';
import { setSyncSourceEnabled } from '../../src/modules/sync/storage.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Exercise the authored DO in workerd without relying on a previous production build.
async function runtimeModules() {
  const modules: { type: 'ESModule'; path: string; contents: string }[] = [];
  const visited = new Set<string>();
  async function add(path: string) {
    if (visited.has(path)) return;
    visited.add(path);
    let contents = stripTypeScriptTypes(await readFile(path, 'utf8'), { mode: 'transform' });
    if (/from ['"]valibot['"]/.test(contents)) {
      const dependency=fileURLToPath(import.meta.resolve('valibot'));
      contents=contents.replace(/from ['"]valibot['"]/g,`from ${JSON.stringify('./'+relative(dirname(path),dependency))}`);await add(dependency);
    }
    modules.push({ type: 'ESModule', path, contents });
    for (const match of contents.matchAll(/\bfrom\s*['"](\.[^'"]+)['"]/g)) await add(resolve(dirname(path), match[1]!));
  }
  await add(join(root, 'src/modules/sync/coordinator.ts'));
  await add(join(root, 'src/cloudflare.ts'));
  return [{ type: 'ESModule' as const, path: join(root, 'tests/integration/sync-fixture.mjs'), contents: `
    import { StoreCoordinator } from '../../src/modules/sync/coordinator.ts';
    import workerEvents from '../../src/cloudflare.ts';
    export class TestCoordinator extends StoreCoordinator {
      async reserveForTest(bucket, now) { return this.reserve(bucket, now); }
      async alarmForTest() { return this.ctx.storage.getAlarm(); }
    }
    export default { async fetch(request, env) {
      const input = await request.json();
      if (input.op === 'cron') { await workerEvents.scheduled({},env); return Response.json(true); }
      const stub = env.STORE_COORDINATOR.getByName(input.name);
      if (input.op === 'wake') { await stub.wake(input.scope); return Response.json(true); }
      if (input.op === 'inspect') return Response.json(await stub.alarmForTest());
      return Response.json(await stub.reserveForTest(input.bucket, input.now));
    } };
  ` }, ...modules];
}

test('real StoreCoordinator serializes per-store permits and preserves buckets across restart', { timeout: 30_000 }, async context => {
  const statePath = await mkdtemp(join(tmpdir(), 'dingbell-sync-runtime-'));
  const modules = await runtimeModules();
  const options = { modules, modulesRoot: root, compatibilityDate: '2026-06-01',
    durableObjects: { STORE_COORDINATOR: { className: 'TestCoordinator', useSQLite: true } }, durableObjectsPersist: statePath };
  let mf = new Miniflare(options);
  context.after(async () => { await mf.dispose(); await rm(statePath, { recursive: true, force: true }); });
  const permit = async (name: string, bucket = 'chat-list', now = 1_000) => {
    const response = await mf.dispatchFetch('http://fixture.invalid', { method: 'POST', body: JSON.stringify({ name, bucket, now }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const attempts = await Promise.all(Array.from({ length: 10 }, () => permit('store-a')));
  assert.equal(attempts.filter(value => value === 1_000).length, 1, 'only one request obtains the current permit');
  assert.equal(attempts.filter(value => value === 2_000).length, 9);
  assert.equal(await permit('store-a', 'chat-history'), 2_000, 'endpoint buckets still share the store budget');
  assert.equal(await permit('store-b'), 1_000, 'another store has its own budget');
  await mf.dispose();
  mf = new Miniflare(options);
  assert.equal(await permit('store-a'), 2_000, 'restart must not reset a persisted rate limit');
  assert.equal(await permit('store-a', 'chat-history', 2_000), 2_000);
  assert.equal(await permit('store-a', 'chat-list', 2_000), 3_000);
  assert.equal(await permit('store-a', 'product-list', 2_000), 3_000);
  assert.equal(await permit('store-a', 'product-details', 2_000), 3_000);
  assert.equal(await permit('store-a', 'fbs-list', 2_000), 3_000);
  assert.equal(await permit('store-a', 'fbs-detail', 2_000), 3_000);
});

test('native Cron recovers a lost wake, alarms import a page, and pause removes future work across restart', { timeout: 30_000 }, async context => {
  const statePath = await mkdtemp(join(tmpdir(), 'dingbell-sync-alarm-'));
  const requests: string[] = [];
  const keys = { STORE_CREDENTIAL_KEYS: JSON.stringify({ v1: btoa('b'.repeat(32)) }), STORE_CREDENTIAL_ACTIVE_KEY: 'v1' };
  const options = { modules: await runtimeModules(), modulesRoot: root, compatibilityDate: '2026-06-01',
    bindings: keys, d1Databases: { DB: 'synthetic-sync' }, d1Persist: join(statePath, 'd1'),
    durableObjects: { STORE_COORDINATOR: { className: 'TestCoordinator', useSQLite: true } }, durableObjectsPersist: join(statePath, 'do'),
    outboundService: async (request: Request) => {
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://api-seller.ozon.ru');
      assert.equal(request.headers.get('Api-Key'), 'synthetic-alarm-key');
      requests.push(url.pathname);
      if (url.pathname === '/v3/chat/list') return WorkerResponse.json({ chats: [{ chat: { chat_id: 'chat', chat_type: 'BUYER_SELLER', chat_status: 'Opened', created_at: '2026-10-01T00:00:00Z' }, last_message_id: '100', unread_count: 1 }], has_next: false });
      if (url.pathname === '/v3/chat/history') return WorkerResponse.json({ messages: [{ message_id: '100', created_at: '2026-10-01T00:00:00Z', user: { id: '123', type: 'Customer' }, data: ['Synthetic alarm message'], is_image: false, is_read: false }], has_next: false });
      throw new Error('Unexpected synthetic network request');
    },
  };
  let mf = new Miniflare(options);
  context.after(async () => { await mf.dispose(); await rm(statePath, { recursive: true, force: true }); });
  let db = await mf.getD1Database('DB');
  const directory = join(root, 'migrations');
  for (const name of (await readdir(directory)).filter(value => value.endsWith('.sql')).sort()) {
    for (const sql of (await readFile(join(directory, name), 'utf8')).split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  const scope = { orgId: 'org', storeId: 'store' };
  const envelope = await encryptCredentials(keys, { ...scope, platformStoreId: '123456', credentialVersion: 1 }, { apiKey: 'synthetic-alarm-key' });
  await db.batch([
    db.prepare("INSERT INTO organization (id,name,slug,created_at) VALUES ('org','Org','org',1)"),
    db.prepare("INSERT INTO store (id,organization_id,name,platform_store_id,status,credential_key_version,credential_nonce,credential_ciphertext,created_at,updated_at) VALUES ('store','org','Store','123456','verified',?,?,?,1,1)").bind(envelope.keyVersion, envelope.nonce, envelope.ciphertext),
    db.prepare("INSERT INTO store_coordinator (store_id,organization_id) VALUES ('store','org')"),
    db.prepare("INSERT INTO store_sync_source (store_id,organization_id,source,enabled,epoch,credential_version,due_at,updated_at) VALUES ('store','org','chat',1,1,1,0,1)"),
    db.prepare("INSERT INTO sync_cursor (store_id,organization_id,thread_id,stream,due_at) VALUES ('store','org','','discovery',0)"),
  ]);
  async function command(op: string) {
    const response = await mf.dispatchFetch('http://fixture.invalid', { method: 'POST', body: JSON.stringify({ op, name: JSON.stringify([scope.orgId, scope.storeId]), scope }) });
    assert.equal(response.status, 200);
    return response.json();
  }
  assert.equal(requests.length, 0);
  await command('cron');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && await db.prepare('SELECT count(*) FROM message').first('count(*)') !== 1) await delay(25);
  assert.deepEqual(requests, ['/v3/chat/list', '/v3/chat/history']);
  assert.equal(await db.prepare('SELECT count(*) FROM message').first('count(*)'), 1);
  assert.equal(await db.prepare('SELECT state FROM ingest_event').first('state'), 'historical');
  const append=(await db.prepare('SELECT message_id,conversation_id,sequence FROM message_append').all()).results;
  assert.equal(append.length,1);assert.equal(append[0].sequence,1);assert.equal(await db.prepare('SELECT message_sequence FROM conversation').first('message_sequence'),1);
  await db.prepare("UPDATE store SET status='paused',revision=revision+1").run();
  await command('wake');
  assert.equal(await command('inspect'), null);
  await mf.dispose();
  mf = new Miniflare(options);
  db = await mf.getD1Database('DB');
  await command('cron');
  assert.equal(await db.prepare('SELECT enabled FROM store_sync_source').first('enabled'), 0);
  assert.equal(await db.prepare('SELECT count(*) FROM message').first('count(*)'), 1);
  assert.deepEqual((await db.prepare('SELECT message_id,conversation_id,sequence FROM message_append').all()).results,append);
  assert.equal(await db.prepare('SELECT message_sequence FROM conversation').first('message_sequence'),1);
  assert.equal(await command('inspect'), null);
  assert.equal(requests.length, 2);
});

test('native product-only alarms hydrate facts and keep stopped synchronization stopped after restart', { timeout: 30_000 }, async context => {
  const statePath = await mkdtemp(join(tmpdir(), 'dingbell-product-alarm-'));
  const requests: string[] = [];
  const keys = { STORE_CREDENTIAL_KEYS: JSON.stringify({ v1: btoa('b'.repeat(32)) }), STORE_CREDENTIAL_ACTIVE_KEY: 'v1' };
  const options = { modules: await runtimeModules(), modulesRoot: root, compatibilityDate: '2026-06-01', bindings: keys,
    d1Databases: { DB: 'synthetic-products' }, d1Persist: join(statePath, 'd1'),
    durableObjects: { STORE_COORDINATOR: { className: 'TestCoordinator', useSQLite: true } }, durableObjectsPersist: join(statePath, 'do'),
    outboundService: async (request: Request) => {
      const url = new URL(request.url); assert.equal(url.origin, 'https://api-seller.ozon.ru'); requests.push(url.pathname);
      const body = await request.json() as { last_id?: string };
      if (url.pathname === '/v3/product/list') return WorkerResponse.json({ result: { items: body.last_id ? [] : [{product_id:'9000000000817031942',offer_id:'native-product'}],last_id:'end',total:1 } });
      if (url.pathname === '/v3/product/info/list') return WorkerResponse.json({ items: [{id:'9000000000817031942',offer_id:'native-product',name:'Native product',price:'1530.0000',currency_code:'RUB'}] });
      throw new Error('Unexpected synthetic network request');
    },
  };
  let mf = new Miniflare(options);
  context.after(async () => { await mf.dispose(); await rm(statePath,{recursive:true,force:true}); });
  let database = await mf.getD1Database('DB');
  const directory = join(root, 'migrations');
  for (const name of (await readdir(directory)).filter(value => value.endsWith('.sql')).sort()) {
    for (const sql of (await readFile(join(directory,name),'utf8')).split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean)) await database.prepare(sql).run();
  }
  const scope = {orgId:'org',storeId:'store'}, actor = {orgId:'org',actorUserId:'admin',sessionId:'session'};
  const envelope = await encryptCredentials(keys,{...scope,platformStoreId:'123456',credentialVersion:1},{apiKey:'synthetic-products-alarm-key'});
  await database.batch([
    database.prepare("INSERT INTO organization (id,name,slug,created_at) VALUES ('org','Org','org',1)"),
    database.prepare("INSERT INTO user (id,name,email,email_verified) VALUES ('admin','Admin','native@example.invalid',1)"),
    database.prepare("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('member','org','admin','admin',1)"),
    database.prepare("INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES ('session','session','admin',?,1,1)").bind(Date.now()+3_600_000),
    database.prepare("INSERT INTO store (id,organization_id,name,platform_store_id,status,credential_key_version,credential_nonce,credential_ciphertext,capabilities,checked_at,expires_at,created_at,updated_at) VALUES ('store','org','Store','123456','verified',?,?,?,?,?,?,1,1)")
      .bind(envelope.keyVersion,envelope.nonce,envelope.ciphertext,JSON.stringify([{code:'auth',status:'available'},{code:'products_read',status:'available'}]),Date.now(),Date.now()+86_400_000),
  ]);
  assert.ok(await setSyncSourceEnabled(database as unknown as D1Database,actor,scope.storeId,'products',0,true));
  async function command(op: string) {
    const response = await mf.dispatchFetch('http://fixture.invalid',{method:'POST',body:JSON.stringify({op,name:JSON.stringify([scope.orgId,scope.storeId]),scope})});
    assert.equal(response.status,200); return response.json();
  }
  // Reserve a future synthetic slot so an early alarm cannot race this assertion.
  const reservedAt = Date.now()+2_000;
  await mf.dispatchFetch('http://fixture.invalid',{method:'POST',body:JSON.stringify({name:JSON.stringify([scope.orgId,scope.storeId]),bucket:'chat-list',now:reservedAt})});
  await database.prepare("UPDATE store_sync_source SET due_at=? WHERE source='products'").bind(reservedAt+500).run();
  await command('wake');
  assert.ok(Number(await command('inspect')) >= reservedAt+1_000, 'alarm scheduling must respect persisted rate permits before claiming another source');
  await command('cron');
  const deadline = Date.now()+10_000;
  while (Date.now()<deadline && await database.prepare("SELECT count(*) FROM product WHERE facts IS NOT NULL AND detail_state='complete'").first('count(*)') !== 1) await delay(25);
  assert.equal(await database.prepare("SELECT count(*) FROM product WHERE facts IS NOT NULL AND detail_state='complete'").first('count(*)'),1);
  assert.equal(JSON.parse((await database.prepare('SELECT facts FROM product').first<string>('facts'))!).price,'1530.0000');
  assert.deepEqual(requests.slice(0,2),['/v3/product/list','/v3/product/info/list']);
  assert.equal(await database.prepare("SELECT count(*) FROM store_sync_source WHERE source='chat'").first('count(*)'),0);
  assert.ok(await setSyncSourceEnabled(database as unknown as D1Database,actor,scope.storeId,'products',1,false));
  await command('wake');
  assert.equal(await command('inspect'),null);
  const beforeRestart=requests.length;
  await mf.dispose(); mf=new Miniflare(options); database=await mf.getD1Database('DB');
  await command('cron');
  assert.equal(await command('inspect'),null);
  assert.equal(await database.prepare('SELECT count(*) FROM product').first('count(*)'),1);
  assert.equal(requests.length,beforeRestart);
});

test('native FBS-only alarms resume an unfinished frozen window after restart', {timeout:30_000},async context=>{
  const statePath=await mkdtemp(join(tmpdir(),'dingbell-fbs-alarm-'));
  const keys={STORE_CREDENTIAL_KEYS:JSON.stringify({v1:btoa('b'.repeat(32))}),STORE_CREDENTIAL_ACTIVE_KEY:'v1'};
  const requests:{path:string;body:Record<string,unknown>}[]=[];
  const posting={posting_number:'native-order-1',order_id:'9000000000817031942',order_number:'native-order',status:'delivered',products:[{sku:'9000000000817031943',offer_id:'native-article',quantity:1,price:'1530.0000',currency_code:'RUB'}]};
  const options={modules:await runtimeModules(),modulesRoot:root,compatibilityDate:'2026-06-01',bindings:keys,
    d1Databases:{DB:'synthetic-fbs'},d1Persist:join(statePath,'d1'),durableObjects:{STORE_COORDINATOR:{className:'TestCoordinator',useSQLite:true}},durableObjectsPersist:join(statePath,'do'),
    outboundService:async(request:Request)=>{
      const url=new URL(request.url);assert.equal(url.origin,'https://api-seller.ozon.ru');
      const body=await request.json() as Record<string,unknown>;requests.push({path:url.pathname,body});
      if(url.pathname==='/v4/posting/fbs/list')return body.cursor?WorkerResponse.json({postings:[],has_next:false}):WorkerResponse.json({postings:[posting],has_next:true,cursor:'frozen-next'});
      if(url.pathname==='/v3/posting/fbs/get')return WorkerResponse.json({result:posting});
      throw new Error('Unexpected synthetic network request');
    },
  };
  let mf=new Miniflare(options);context.after(async()=>{await mf.dispose();await rm(statePath,{recursive:true,force:true});});
  let database=await mf.getD1Database('DB');
  const directory=join(root,'migrations');
  for(const name of (await readdir(directory)).filter(value=>value.endsWith('.sql')).sort())for(const sql of (await readFile(join(directory,name),'utf8')).split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean))await database.prepare(sql).run();
  const scope={orgId:'org',storeId:'store'},actor={orgId:'org',actorUserId:'admin',sessionId:'session'};
  const envelope=await encryptCredentials(keys,{...scope,platformStoreId:'123456',credentialVersion:1},{apiKey:'synthetic-fbs-alarm-key'});
  await database.batch([
    database.prepare("INSERT INTO organization (id,name,slug,created_at) VALUES ('org','Org','org',1)"),
    database.prepare("INSERT INTO user (id,name,email,email_verified) VALUES ('admin','Admin','fbs-native@example.invalid',1)"),
    database.prepare("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('member','org','admin','admin',1)"),
    database.prepare("INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES ('session','session','admin',?,1,1)").bind(Date.now()+3_600_000),
    database.prepare("INSERT INTO store (id,organization_id,name,platform_store_id,status,credential_key_version,credential_nonce,credential_ciphertext,capabilities,checked_at,expires_at,created_at,updated_at) VALUES ('store','org','Store','123456','verified',?,?,?,?,?,?,1,1)")
      .bind(envelope.keyVersion,envelope.nonce,envelope.ciphertext,JSON.stringify([{code:'auth',status:'available'},{code:'orders_fbs_read',status:'available'}]),Date.now(),Date.now()+86_400_000),
  ]);
  assert.ok(await setSyncSourceEnabled(database as unknown as D1Database,actor,scope.storeId,'fbs_postings',0,true));
  async function command(op:string){
    const response=await mf.dispatchFetch('http://fixture.invalid',{method:'POST',body:JSON.stringify({op,name:JSON.stringify([scope.orgId,scope.storeId]),scope})});
    assert.equal(response.status,200);return response.json();
  }
  await command('cron');
  const firstDeadline=Date.now()+8_000;
  while(Date.now()<firstDeadline && await database.prepare('SELECT cursor FROM fbs_sync_window').first('cursor')!=='frozen-next')await delay(25);
  const checkpoint=await database.prepare('SELECT since,"to",cursor FROM fbs_sync_window').first<{since:number;to:number;cursor:string}>();
  assert.equal(checkpoint?.cursor,'frozen-next');
  await mf.dispose();mf=new Miniflare(options);database=await mf.getD1Database('DB');
  await command('cron');
  const completedDeadline=Date.now()+10_000;
  while(Date.now()<completedDeadline && (await database.prepare('SELECT last_completed_to FROM fbs_sync_window').first('last_completed_to')!==checkpoint!.to || await database.prepare('SELECT detail_facts FROM fbs_posting').first('detail_facts')===null))await delay(25);
  assert.equal(await database.prepare('SELECT last_completed_to FROM fbs_sync_window').first('last_completed_to'),checkpoint!.to);
  const lists=requests.filter(request=>request.path==='/v4/posting/fbs/list');assert.equal(lists.length,2);
  assert.deepEqual(lists[0].body.filter,lists[1].body.filter);assert.equal(lists[1].body.cursor,'frozen-next');
  assert.equal(JSON.parse((await database.prepare('SELECT detail_facts FROM fbs_posting').first<string>('detail_facts'))!).products[0].price,'1530.0000');
  assert.equal(await database.prepare("SELECT count(*) FROM store_sync_source WHERE source<>'fbs_postings'").first('count(*)'),0);
  assert.ok(await setSyncSourceEnabled(database as unknown as D1Database,actor,scope.storeId,'fbs_postings',1,false));
  await command('wake');assert.equal(await command('inspect'),null);
});
