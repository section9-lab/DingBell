import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { encryptCredentials } from '../src/modules/stores/credentials.ts';
import { runSyncPage } from '../src/modules/sync/runner.ts';
import { setSyncSourceEnabled } from '../src/modules/sync/storage.ts';

const scope = { orgId: 'org', storeId: 'store' };
const actor = { orgId: scope.orgId, actorUserId: 'admin', sessionId: 'session' };
const listed = { product_id: '9000000000817031942', offer_id: 'article' };
const detail = { id: listed.product_id, offer_id: listed.offer_id, name: 'Synthetic product', price: '123.4500', currency_code: 'RUB' };

async function fixture(context: TestContext, chat = false) {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2026-06-01', d1Databases: { DB: crypto.randomUUID() } });
  context.after(() => mf.dispose());
  const db = await mf.getD1Database('DB') as unknown as D1Database;
  const folder = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(folder).filter(name => name.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(new URL(file, folder), 'utf8').split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  const env = { DB: db, STORE_CREDENTIAL_KEYS: JSON.stringify({ v1: btoa('a'.repeat(32)) }), STORE_CREDENTIAL_ACTIVE_KEY: 'v1' };
  const envelope = await encryptCredentials(env, { ...scope, platformStoreId: '123456', credentialVersion: 1 }, { apiKey: 'synthetic-products-secret' });
  await db.batch([
    db.prepare("INSERT INTO organization (id,name,slug,created_at) VALUES ('org','Org','org',1)"),
    db.prepare("INSERT INTO user (id,name,email,email_verified) VALUES ('admin','Admin','admin@example.invalid',1)"),
    db.prepare("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('member','org','admin','admin',1)"),
    db.prepare("INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES ('session','session','admin',?,1,1)").bind(Date.now() + 3_600_000),
    db.prepare("INSERT INTO store (id,organization_id,name,platform_store_id,status,credential_key_version,credential_nonce,credential_ciphertext,capabilities,checked_at,expires_at,created_at,updated_at) VALUES ('store','org','Store','123456','verified',?,?,?,?,?,?,1,1)")
      .bind(envelope.keyVersion, envelope.nonce, envelope.ciphertext, JSON.stringify(['auth','chats_read','products_read'].map(code => ({ code, status: 'available' }))), Date.now(), Date.now() + 86_400_000),
  ]);
  if (chat) assert.equal((await setSyncSourceEnabled(db, actor, scope.storeId, 'chat', 0, true))?.enabled, true);
  assert.equal((await setSyncSourceEnabled(db, actor, scope.storeId, 'products', 0, true))?.enabled, true);
  const state = (source: string) => db.prepare('SELECT enabled,epoch,last_success_at,last_error,failures FROM store_sync_source WHERE source=?').bind(source).first<{enabled:number;epoch:number;last_success_at:number|null;last_error:string|null;failures:number}>();
  const productFirst = () => db.prepare("UPDATE store_sync_source SET due_at=? WHERE source='chat'").bind(Date.now() + 60_000).run();
  // Make test work due between bounded invocations; shared provider cooldowns remain intact.
  const ready = () => db.batch([
    db.prepare('UPDATE store_sync_source SET due_at=0'), db.prepare('UPDATE product_sync_cursor SET due_at=0'),
    db.prepare('UPDATE product SET detail_due_at=0'), db.prepare('UPDATE sync_cursor SET due_at=0'),
  ]);
  return { db, env, state, productFirst, ready };
}

test('products can continuously list, hydrate and begin another catalog round without chat authorization', { timeout: 30_000 }, async context => {
  const { db, env, state, ready } = await fixture(context);
  const calls: {path:string;body:Record<string,unknown>}[] = [];
  const fetcher = (async (input, init) => {
    const path = new URL(String(input)).pathname, body = JSON.parse(String(init?.body)); calls.push({path,body});
    assert.equal(new Headers(init?.headers).get('Api-Key'), 'synthetic-products-secret');
    if (path === '/v3/product/list') return Response.json({ result: { items: body.last_id ? [] : [listed], last_id: 'end', total: 1 } });
    if (path === '/v3/product/info/list') return Response.json({ items: [detail] });
    throw new Error('Unexpected synthetic request');
  }) as typeof fetch;
  for (let index = 0; index < 7; index++) {
    await ready(); await runSyncPage(env, scope, { fetcher });
    if (index === 2) assert.ok((await db.prepare('SELECT due_at FROM product_sync_cursor').first<number>('due_at'))! >= Date.now() + 299_000, 'completed rounds wait five minutes before scanning again');
  }
  assert.deepEqual(calls.slice(0,3).map(item => item.path), ['/v3/product/list','/v3/product/info/list','/v3/product/list']);
  assert.ok(calls.filter(item => item.path === '/v3/product/list' && item.body.last_id === '').length >= 2, 'an empty terminal page schedules a later catalog round');
  assert.equal(await db.prepare("SELECT count(*) FROM store_sync_source WHERE source='chat'").first('count(*)'), 0);
  assert.equal((await state('products'))?.enabled, 1);
  assert.ok((await state('products'))?.last_success_at);
});

test('persistent source fairness gives both chat and products bounded opportunities', { timeout: 30_000 }, async context => {
  const { env, ready } = await fixture(context, true);
  const calls: string[] = [];
  const fetcher = (async input => {
    const path = new URL(String(input)).pathname; calls.push(path);
    if (path === '/v3/chat/list') return Response.json({ chats: [], has_next: false });
    if (path === '/v3/product/list') return Response.json({ result: { items: [], last_id: '', total: 0 } });
    throw new Error('Unexpected synthetic request');
  }) as typeof fetch;
  for (let index = 0; index < 8; index++) { await ready(); await runSyncPage(env, scope, { fetcher }); }
  assert.equal(calls.length, 8);
  for (let index = 0; index < calls.length; index += 2) assert.deepEqual(new Set(calls.slice(index,index+2)), new Set(['/v3/chat/list','/v3/product/list']));
});

test('disabling chat does not fence an in-flight product page', { timeout: 30_000 }, async context => {
  const { env, db, state, productFirst } = await fixture(context, true); await productFirst();
  await runSyncPage(env, scope, { fetcher: (async () => {
    assert.equal((await setSyncSourceEnabled(db, actor, scope.storeId, 'chat', 1, false))?.enabled, false);
    return Response.json({ result: { items: [listed], last_id: 'end', total: 1 } });
  }) as typeof fetch });
  assert.equal((await state('chat'))?.enabled, 0);
  assert.equal((await state('products'))?.enabled, 1);
  assert.ok((await state('products'))?.last_success_at, 'the unrelated source change must not invalidate this lease');
  assert.equal(await db.prepare('SELECT lease_token FROM store_coordinator').first('lease_token'), null);
});

test('product permission errors stop only products while credential rejection stops every source', { timeout: 30_000 }, async context => {
  const { env, db, state, productFirst } = await fixture(context, true); await productFirst();
  await runSyncPage(env, scope, { fetcher: (async () => new Response('', { status: 403 })) as typeof fetch });
  assert.equal((await state('products'))?.enabled, 0);
  assert.equal((await state('products'))?.last_error, 'product_list_permission_denied');
  assert.equal((await state('chat'))?.enabled, 1);
  const failed = await state('products');
  assert.ok(await setSyncSourceEnabled(db, actor, scope.storeId, 'products', failed!.epoch, true));
  await runSyncPage(env, scope, { fetcher: (async () => Response.json({ result: { items: [listed], last_id: 'end', total: 1 } })) as typeof fetch });
  await runSyncPage(env, scope, { fetcher: (async () => new Response('', { status: 403 })) as typeof fetch });
  assert.equal((await state('products'))?.last_error, 'product_details_permission_denied');
  assert.equal((await state('chat'))?.enabled, 1);
  assert.ok(await setSyncSourceEnabled(db, actor, scope.storeId, 'products', (await state('products'))!.epoch, true));
  await runSyncPage(env, scope, { fetcher: (async () => new Response('', { status: 401 })) as typeof fetch });
  assert.equal((await state('products'))?.enabled, 0);
  assert.equal((await state('chat'))?.enabled, 0);
});

test('shared Retry-After survives source disable and resume and blocks every source', { timeout: 30_000 }, async context => {
  const { env, db, state, productFirst } = await fixture(context, true); await productFirst();
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '120' } }); }) as typeof fetch;
  const before = Date.now(); await runSyncPage(env, scope, { fetcher });
  assert.ok((await db.prepare('SELECT blocked_until FROM store_coordinator').first<number>('blocked_until'))! >= before + 120_000);
  const current = await state('products');
  const disabled = await setSyncSourceEnabled(db, actor, scope.storeId, 'products', current!.epoch, false); assert.ok(disabled);
  assert.ok(await setSyncSourceEnabled(db, actor, scope.storeId, 'products', disabled.epoch, true));
  await db.prepare('UPDATE store_sync_source SET due_at=0').run();
  await runSyncPage(env, scope, { fetcher });
  assert.equal(calls, 1);
});

test('product disable or credential replacement rejects the provider response that arrives late', { timeout: 30_000 }, async context => {
  const { env, db, state } = await fixture(context);
  await runSyncPage(env, scope, { fetcher: (async () => {
    assert.ok(await setSyncSourceEnabled(db, actor, scope.storeId, 'products', 1, false));
    return Response.json({ result: { items: [listed], last_id: 'end', total: 1 } });
  }) as typeof fetch });
  assert.equal((await state('products'))?.last_success_at, null);
  assert.ok(await setSyncSourceEnabled(db, actor, scope.storeId, 'products', 2, true));
  await runSyncPage(env, scope, { fetcher: (async () => {
    await db.prepare("UPDATE store SET credential_version=credential_version+1,revision=revision+1,status='unverified'").run();
    return Response.json({ result: { items: [listed], last_id: 'end', total: 1 } });
  }) as typeof fetch });
  assert.equal((await state('products'))?.last_success_at, null);
  assert.equal((await state('products'))?.enabled, 0);
});

test('missing detail IDs retry only three times and unchanged future listings do not resurrect failures', { timeout: 30_000 }, async context => {
  const { env, db, ready } = await fixture(context);
  const missing = { product_id: '9000000000817031943', offer_id: 'missing' };
  let missingAttempts = 0; let completeAttempts = 0;
  const fetcher = (async (input, init) => {
    const path = new URL(String(input)).pathname, body = JSON.parse(String(init?.body));
    if (path === '/v3/product/list') return Response.json({ result: { items: body.last_id ? [] : [listed,missing], last_id: 'end', total: 2 } });
    if (path === '/v3/product/info/list') {
      if (body.product_id.includes(missing.product_id)) missingAttempts++;
      if (body.product_id.includes(listed.product_id)) completeAttempts++;
      return Response.json({ items: body.product_id.includes(listed.product_id) ? [detail] : [] });
    }
    throw new Error('Unexpected synthetic request');
  }) as typeof fetch;
  for (let index = 0; index < 22; index++) { await ready(); await runSyncPage(env, scope, { fetcher }); }
  assert.equal(missingAttempts, 3);
  assert.ok(completeAttempts > 1, 'successful products still refresh in following rounds');
  assert.deepEqual(await db.prepare('SELECT detail_state,detail_attempt,detail_error FROM product WHERE id=?').bind(missing.product_id).first(), {detail_state:'error',detail_attempt:3,detail_error:'product_details_missing'});
});

test('one shared lease serializes sources and fences an expired product response behind a newer page', { timeout: 30_000 }, async context => {
  const { env, db, productFirst } = await fixture(context, true); await productFirst();
  const started = Promise.withResolvers<void>(); const provider = Promise.withResolvers<Response>();
  let calls = 0;
  const old = runSyncPage(env, scope, { fetcher: (async () => { calls++; started.resolve(); return provider.promise; }) as typeof fetch });
  await started.promise;
  await db.prepare("UPDATE store_sync_source SET due_at=0 WHERE source='chat'").run();
  await runSyncPage(env, scope, { fetcher: (async () => { calls++; throw new Error('A shared lease allowed concurrent traffic'); }) as typeof fetch });
  assert.equal(calls,1);
  await productFirst();
  await db.prepare('UPDATE store_coordinator SET lease_until=1').run();
  await runSyncPage(env, scope, { fetcher: (async () => Response.json({result:{items:[{...listed,offer_id:'newer'}],last_id:'newer-page',total:1}})) as typeof fetch });
  provider.resolve(Response.json({result:{items:[{...listed,offer_id:'older'}],last_id:'old-page',total:1}}));
  await old;
  assert.equal(JSON.parse((await db.prepare('SELECT listing FROM product').first<string>('listing'))!).offerId,'newer');
  assert.equal(await db.prepare('SELECT cursor FROM product_sync_cursor').first('cursor'),'newer-page');
});
