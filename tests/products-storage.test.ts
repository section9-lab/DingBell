import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { commitProductDetails, commitProductList, getDueProductWork, getProductCounts } from '../src/modules/products/storage.ts';
import type { ProductDetailsWork, ProductListWork } from '../src/modules/products/types.ts';
import type { OzonProductDetails, OzonProductListItem } from '../src/modules/products/ozon.ts';
import * as synchronization from '../src/modules/sync/storage.ts';
import type { SyncLease } from '../src/modules/sync/types.ts';
import { prepareProductSyncSeed } from '../src/modules/products/sync-seed.ts';

test('product persistence separates catalog checkpoints, current facts and source history', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    const folder = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(folder).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, folder), 'utf8'));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    for (const name of ['product_sync_cursor', 'product', 'product_source_snapshot']) assert.ok(tables.includes(name), `${name} must be persisted`);
  } finally { db.close(); }
});

test('product persistence uses real D1 transactions and current source authorization', { timeout: 90_000 }, async context => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2026-06-01', d1Databases: { DB: crypto.randomUUID() } });
  context.after(() => mf.dispose());
  const db = await mf.getD1Database('DB') as unknown as D1Database;
  const folder = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(folder).filter(name => name.endsWith('.sql')).sort()) {
    for (const statement of readFileSync(new URL(name, folder), 'utf8').split('--> statement-breakpoint').map(part => part.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  const actor = { orgId: 'products-org', actorUserId: 'products-admin', sessionId: 'products-session' };
  await db.batch([
    db.prepare("INSERT INTO organization (id,name,slug,created_at) VALUES ('products-org','Products','products',1),('other-products-org','Other','other-products',1)"),
    db.prepare("INSERT INTO user (id,name,email,email_verified) VALUES ('products-admin','Admin','products@example.invalid',1)"),
    db.prepare("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('products-member','products-org','products-admin','admin',1)"),
    db.prepare('INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,1,1)').bind(actor.sessionId, actor.sessionId, actor.actorUserId, Date.now() + 3_600_000),
  ]);
  const capabilities = JSON.stringify(['auth', 'products_read', 'chats_read'].map(code => ({ code, status: 'available', reason: 'read_verified' })));
  const productId = '9000000000817031942';
  const item = (id = productId): OzonProductListItem => ({ id, offerId: `offer-${id}`, sku: '9000000000817031941', archived: false, hasFboStocks: false, hasFbsStocks: true });
  const facts = (id = productId, price = '000012.3400'): OzonProductDetails => ({ id, offerId: `offer-${id}`, name: 'Синтетический товар', sku: '9000000000817031941', sources: [{ sku: '9000000000817031941', source: 'fbs' }], price, currency: 'RUB', archived: false });
  async function addStore(id: string) {
    await db.prepare(`INSERT INTO store (id,organization_id,name,platform_store_id,status,credential_key_version,credential_nonce,credential_ciphertext,capabilities,checked_at,expires_at,created_at,updated_at)
      VALUES (?,?,'Products',?,'verified','synthetic','synthetic','synthetic',?,1,?,1,1)`).bind(id, actor.orgId, id, capabilities, Date.now() + 3_600_000).run();
    const source = await synchronization.setSyncSourceEnabled(db, actor, id, 'products', 0, true);
    assert.ok(source?.enabled); return id;
  }
  async function lease(storeId: string): Promise<SyncLease> {
    await db.prepare("UPDATE store_sync_source SET due_at=1 WHERE store_id=? AND source='products'").bind(storeId).run();
    const claimed = await synchronization.claimSyncLease(db, { orgId: actor.orgId, storeId, source: 'products', token: crypto.randomUUID() });
    assert.ok(claimed); return claimed;
  }
  async function listWork(storeId: string): Promise<{ lease: SyncLease; work: ProductListWork }> {
    await db.prepare("UPDATE product_sync_cursor SET due_at=1,last_kind='details' WHERE store_id=?").bind(storeId).run();
    const claimed = await lease(storeId), work = await getDueProductWork(db, claimed);
    assert.equal(work?.kind, 'list'); return { lease: claimed, work: work as ProductListWork };
  }
  async function detailWork(storeId: string): Promise<{ lease: SyncLease; work: ProductDetailsWork }> {
    await db.prepare('UPDATE product_sync_cursor SET due_at=? WHERE store_id=?').bind(Date.now() + 3_600_000, storeId).run();
    await db.prepare("UPDATE product SET detail_due_at=1 WHERE store_id=? AND detail_state='pending'").bind(storeId).run();
    const claimed = await lease(storeId), work = await getDueProductWork(db, claimed);
    assert.equal(work?.kind, 'details'); return { lease: claimed, work: work as ProductDetailsWork };
  }
  async function list(storeId: string, items = [item()], cursor = crypto.randomUUID()) {
    const job = await listWork(storeId);
    assert.ok(await commitProductList(db, job.lease, job.work, { items, lastId: cursor, reportedTotal: items.length }, Date.now() + 1000)); return job;
  }
  async function details(storeId: string, items = [facts()]) {
    const job = await detailWork(storeId);
    assert.ok(await commitProductDetails(db, job.lease, job.work, { items }, Date.now() + 30_000)); return job;
  }
  async function nextRound(storeId: string) {
    const job = await listWork(storeId);
    assert.ok(await commitProductList(db, job.lease, job.work, { items: [], lastId: job.work.cursor, reportedTotal: 123 }, Date.now() + 300_000));
  }
  async function count(table: string, storeId: string) { return db.prepare(`SELECT count(*) AS n FROM ${table} WHERE store_id=?`).bind(storeId).first<number>('n'); }

  await context.test('the seed creates its checkpoint only behind the authorization receipt', async () => {
    const storeId = 'product-seed';
    await db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,created_at,updated_at) VALUES (?,?,'Seed',?,1,1)").bind(storeId, actor.orgId, storeId).run();
    const denied = prepareProductSyncSeed(db, { storeId, orgId: actor.orgId }, 1, { sql: '0=1', values: [] });
    if (denied.length) await db.batch(denied);
    assert.equal(await db.prepare('SELECT cursor FROM product_sync_cursor WHERE store_id=?').bind(storeId).first('cursor'), null);
    const accepted = prepareProductSyncSeed(db, { storeId, orgId: actor.orgId }, 1, { sql: '1=1', values: [] });
    if (accepted.length) await db.batch(accepted);
    assert.equal(await db.prepare('SELECT cursor FROM product_sync_cursor WHERE store_id=?').bind(storeId).first('cursor'), '');
    assert.deepEqual(await getProductCounts(db, actor, storeId), { productCount: 0, readyCount: 0, pendingCount: 0, failedCount: 0 });
  });
  await context.test('a persisted products lease discovers due work before it can atomically import the page', async () => {
    const storeId = 'product-seed';
    await db.prepare("UPDATE store SET status='verified',credential_key_version='synthetic',credential_nonce='synthetic',credential_ciphertext='synthetic',capabilities=?,expires_at=? WHERE id=?").bind(capabilities, Date.now() + 3_600_000, storeId).run();
    await db.prepare("INSERT INTO store_coordinator(store_id,organization_id,fence,lease_source,lease_token,lease_until) VALUES (?,?,1,'products','synthetic-lease',?)").bind(storeId, actor.orgId, Date.now() + 60_000).run();
    await db.prepare("INSERT INTO store_sync_source(store_id,organization_id,source,enabled,epoch,credential_version,due_at,updated_at) VALUES (?,?,'products',1,1,1,1,1)").bind(storeId, actor.orgId).run();
    const claimed: SyncLease = { orgId: actor.orgId, storeId, source: 'products', epoch: 1, fence: 1, token: 'synthetic-lease', credentialVersion: 1, storeRevision: 1 };
    const work = await getDueProductWork(db, claimed); assert.equal(work?.kind, 'list');
    assert.ok(await commitProductList(db, claimed, work as ProductListWork, { items: [item()], lastId: 'first', reportedTotal: 1 }, Date.now() + 1000));
    assert.equal(await count('product', storeId), 1);
  });
  await context.test('enable seeds a resumable list; commits discover IDs before any details exist', async () => {
    const id = await addStore('product-first');
    assert.deepEqual(await getProductCounts(db, actor, id), { productCount: 0, readyCount: 0, pendingCount: 0, failedCount: 0 });
    const job = await list(id);
    assert.equal(await commitProductList(db, job.lease, job.work, { items: [item()], lastId: 'replayed', reportedTotal: 1 }, Date.now() + 1000), false);
    assert.deepEqual(await getProductCounts(db, actor, id), { productCount: 1, readyCount: 0, pendingCount: 1, failedCount: 0 });
    assert.equal(await count('product_source_snapshot', id), 0);
    assert.equal(await db.prepare('SELECT facts FROM product WHERE store_id=?').bind(id).first('facts'), null);
  });
  await context.test('identical facts refresh observed time without snapshots; A to B to A retains all changes', async () => {
    const id = await addStore('product-history'); await list(id); await details(id);
    await nextRound(id); await list(id);
    assert.deepEqual(await getProductCounts(db, actor, id), { productCount: 1, readyCount: 1, pendingCount: 1, failedCount: 0 });
    await details(id); assert.equal(await count('product_source_snapshot', id), 1);
    await nextRound(id); await list(id); await details(id, [facts(productId, '15.0000')]);
    await nextRound(id); await list(id); await details(id);
    assert.equal(await count('product_source_snapshot', id), 3);
    const row = await db.prepare('SELECT id,facts,list_source_updated_at,facts_source_updated_at,facts_observed_at FROM product WHERE store_id=?').bind(id).first<any>();
    assert.equal(row.id, productId); assert.equal(JSON.parse(row.facts).price, '000012.3400'); assert.equal(JSON.parse(row.facts).sku, '9000000000817031941');
    assert.equal(row.list_source_updated_at, null); assert.equal(row.facts_source_updated_at, null); assert.ok(row.facts_observed_at > 0);
    await assert.rejects(db.prepare("UPDATE product_source_snapshot SET facts='{}' WHERE store_id=?").bind(id).run(), /PRODUCT_SNAPSHOT_IMMUTABLE/);
  });
  await context.test('list failure rolls back the whole page including cursor and lease receipt', async () => {
    const id = await addStore('product-list-failure'), job = await listWork(id);
    await db.prepare("CREATE TRIGGER synthetic_product_list_failure BEFORE INSERT ON product WHEN NEW.store_id='product-list-failure' AND NEW.id='2' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_PRODUCT_FAILURE'); END").run();
    await assert.rejects(commitProductList(db, job.lease, job.work, { items: [item('1'), item('2')], lastId: 'next', reportedTotal: 2 }, Date.now() + 1000), /SYNTHETIC_PRODUCT_FAILURE/);
    assert.equal(await count('product', id), 0);
    assert.equal(await db.prepare('SELECT cursor FROM product_sync_cursor WHERE store_id=?').bind(id).first('cursor'), '');
    assert.equal((await getDueProductWork(db, job.lease))?.kind, 'list');
  });
  await context.test('detail snapshot failure rolls back facts and every task completion', async () => {
    const id = await addStore('product-detail-failure'); await list(id, [item('1'), item('2')]);
    const job = await detailWork(id);
    await db.prepare("CREATE TRIGGER synthetic_product_detail_failure BEFORE INSERT ON product_source_snapshot WHEN NEW.store_id='product-detail-failure' AND NEW.product_id='2' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_SNAPSHOT_FAILURE'); END").run();
    await assert.rejects(commitProductDetails(db, job.lease, job.work, { items: [facts('1'), facts('2')] }, Date.now() + 30_000), /SYNTHETIC_SNAPSHOT_FAILURE/);
    assert.equal(await count('product_source_snapshot', id), 0);
    assert.deepEqual(await getProductCounts(db, actor, id), { productCount: 2, readyCount: 0, pendingCount: 2, failedCount: 0 });
  });
  await context.test('subset details retry three times, remain visible and do not starve succeeding products', async () => {
    const id = await addStore('product-missing'); await list(id, [item('1'), item('2')]); await details(id, [facts('1')]);
    const first = await db.prepare("SELECT detail_attempt,detail_due_at,detail_error FROM product WHERE store_id=? AND id='2'").bind(id).first<any>();
    assert.equal(first.detail_attempt, 1); assert.ok(first.detail_due_at > Date.now()); assert.equal(first.detail_error, 'product_details_missing');
    await details(id, []); await details(id, []);
    assert.deepEqual(await getProductCounts(db, actor, id), { productCount: 2, readyCount: 1, pendingCount: 0, failedCount: 1 });
    await nextRound(id); await list(id, [item('1'), item('2')]);
    assert.equal(await db.prepare("SELECT detail_state FROM product WHERE store_id=? AND id='2'").bind(id).first('detail_state'), 'error');
    assert.equal(await db.prepare("SELECT detail_attempt FROM product WHERE store_id=? AND id='2'").bind(id).first('detail_attempt'), 3);
    const before = await db.prepare('SELECT cursor,generation FROM product_sync_cursor WHERE store_id=?').bind(id).first();
    const stopped = await synchronization.setSyncSourceEnabled(db, actor, id, 'products', 1, false); assert.ok(stopped);
    assert.equal((await getProductCounts(db, actor, id))?.failedCount, 1);
    assert.ok(await synchronization.setSyncSourceEnabled(db, actor, id, 'products', stopped.epoch, true));
    assert.deepEqual(await db.prepare('SELECT cursor,generation FROM product_sync_cursor WHERE store_id=?').bind(id).first(), before);
    assert.equal(await db.prepare("SELECT detail_attempt FROM product WHERE store_id=? AND id='2'").bind(id).first('detail_attempt'), 0);
    assert.equal((await getProductCounts(db, actor, id))?.pendingCount, 2);
  });
  await context.test('only empty pages finish a round and unseen products are retained', async () => {
    const id = await addStore('product-cycles'); await list(id); await details(id);
    const first = await db.prepare('SELECT generation FROM product_sync_cursor WHERE store_id=?').bind(id).first('generation');
    await nextRound(id);
    assert.equal(await db.prepare('SELECT generation FROM product_sync_cursor WHERE store_id=?').bind(id).first('generation'), Number(first) + 1);
    assert.equal(await db.prepare('SELECT cursor FROM product_sync_cursor WHERE store_id=?').bind(id).first('cursor'), '');
    assert.equal(await count('product', id), 1);
    assert.ok(await db.prepare('SELECT last_completed_at FROM product_sync_cursor WHERE store_id=?').bind(id).first('last_completed_at'));
    const job = await listWork(id);
    assert.ok(await commitProductList(db, job.lease, job.work, { items: [item('2')], lastId: 'short-page', reportedTotal: 0 }, Date.now() + 1000));
    assert.equal(await db.prepare('SELECT generation FROM product_sync_cursor WHERE store_id=?').bind(id).first('generation'), Number(first) + 1);
    assert.equal(await count('product', id), 2);
  });
  await context.test('list and details alternate when both are due, surviving separate leases', async () => {
    const id = await addStore('product-fair'); await list(id);
    await db.prepare('UPDATE product_sync_cursor SET due_at=1 WHERE store_id=?').bind(id).run();
    const one = await lease(id), work = await getDueProductWork(db, one); assert.equal(work?.kind, 'details');
    assert.ok(await commitProductDetails(db, one, work as ProductDetailsWork, { items: [] }, Date.now() + 30_000));
    await db.prepare('UPDATE product SET detail_due_at=1 WHERE store_id=?').bind(id).run();
    const two = await lease(id); assert.equal((await getDueProductWork(db, two))?.kind, 'list');
  });
  await context.test('a repeated catalog boundary rejects the whole new page without losing the last checkpoint', async () => {
    const id = await addStore('product-loop'); await list(id, [item('1')], 'A'); await list(id, [item('2')], 'B');
    const job = await listWork(id);
    await assert.rejects(commitProductList(db, job.lease, job.work, { items: [item('3')], lastId: 'A', reportedTotal: 3 }, Date.now() + 1000), /cursor_stalled/);
    assert.equal(await count('product', id), 2);
    assert.equal(await db.prepare('SELECT cursor FROM product_sync_cursor WHERE store_id=?').bind(id).first('cursor'), 'B');
  });
  await context.test('product facts store only the explicitly normalized source fields', async () => {
    const id = await addStore('product-whitelist');
    await list(id, [{ ...item(), unrelatedCredential: 'must-not-persist' } as OzonProductListItem]);
    const providerExtras = { ...facts(), html: '<script>must-not-persist</script>', sources: [{ ...facts().sources[0], arbitrary: 'must-not-persist' }] };
    await details(id, [providerExtras]);
    const saved = await db.prepare('SELECT listing,facts FROM product WHERE store_id=?').bind(id).first<any>();
    assert.equal(JSON.stringify(saved).includes('must-not-persist'), false);
    const snapshot = await db.prepare('SELECT facts FROM product_source_snapshot WHERE store_id=?').bind(id).first<string>('facts');
    assert.equal(snapshot?.includes('must-not-persist'), false);
  });
  await context.test('a chat toggle cannot invalidate the products lease; a chat lease cannot commit products', async () => {
    const id = await addStore('product-source-isolation');
    const chat = await synchronization.setSyncSourceEnabled(db, actor, id, 'chat', 0, true); assert.ok(chat);
    const job = await listWork(id);
    assert.ok(await synchronization.setSyncSourceEnabled(db, actor, id, 'chat', chat.epoch, false));
    assert.ok(await commitProductList(db, job.lease, job.work, { items: [item()], lastId: 'next', reportedTotal: 1 }, Date.now() + 1000));
    const detailJob = await detailWork(id);
    assert.equal(await commitProductDetails(db, { ...detailJob.lease, source: 'chat' }, detailJob.work, { items: [facts()] }, Date.now() + 30_000), false);
    assert.equal(await count('product_source_snapshot', id), 0);
  });
  await context.test('stale catalog generation, expired lease and credential rotation cannot overwrite facts', async () => {
    const id = await addStore('product-stale'); await list(id);
    const old = await detailWork(id);
    await db.prepare('UPDATE store_coordinator SET lease_until=1 WHERE store_id=?').bind(id).run();
    assert.equal(await commitProductDetails(db, old.lease, old.work, { items: [facts()] }, Date.now() + 30_000), false);
    await nextRound(id); await list(id);
    const current = await detailWork(id);
    assert.equal(await commitProductDetails(db, current.lease, old.work, { items: [facts()] }, Date.now() + 30_000), false);
    assert.equal(await count('product_source_snapshot', id), 0);
    await db.prepare('UPDATE store SET credential_version=credential_version+1,revision=revision+1 WHERE id=?').bind(id).run();
    assert.equal(await getDueProductWork(db, current.lease), null);
    assert.equal(await commitProductDetails(db, current.lease, current.work, { items: [facts()] }, Date.now() + 30_000), false);
  });
  await context.test('scope foreign keys and fresh member authorization protect read progress', async () => {
    const id = await addStore('product-scope'); await list(id); await details(id);
    await assert.rejects(db.prepare('INSERT INTO product_source_snapshot(id,organization_id,store_id,product_id,facts,observed_at) VALUES (?,?,?,?,?,1)').bind('wrong-scope', 'other-products-org', id, productId, '{}').run(), /FOREIGN KEY/);
    assert.equal(await getProductCounts(db, { ...actor, orgId: 'other-products-org' }, id), null);
    await db.prepare("DELETE FROM member WHERE id='products-member'").run();
    assert.equal(await getProductCounts(db, actor, id), null);
  });
});
