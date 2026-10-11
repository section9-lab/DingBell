import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { encryptCredentials } from '../src/modules/stores/credentials.ts';
import { checkCursorProgress, historyCheckpoint, retrySyncFailure, runSyncPage } from '../src/modules/sync/runner.ts';

test('sync retries obey Retry-After and stop rather than shorten an excessive provider delay', () => {
  assert.deepEqual(retrySyncFailure({ code: 'rate_limited', retryAfterMs: 120_000 }, 'discovery', 0, 1_000, 0),
    { code: 'rate_limited', nextDueAt: 121_000, disable: false, blockedUntil: 121_000 });
  assert.deepEqual(retrySyncFailure({ code: 'rate_limited', retryAfterMs: 86_400_001 }, 'discovery', 0, 1_000, 0),
    { code: 'retry_after_requires_review', nextDueAt: 1_000, disable: true, blockedUntil: 86_401_001 });
  assert.equal(retrySyncFailure({ code: 'rate_limited', retryAfterMs: Number.MAX_SAFE_INTEGER }, 'discovery', 0, 1_000, 0).nextDueAt, 1_000);
  assert.equal(retrySyncFailure({ code: 'rate_limited', retryAfterMs: Number.MAX_SAFE_INTEGER }, 'discovery', 0, 1_000, 0).blockedUntil, 8_640_000_000_000_000);
});

test('history permissions fail separately and repeated transient failures have a bound', () => {
  assert.equal(retrySyncFailure({ code: 'permission_denied' }, 'backfill', 0, 0, 0).code, 'chat_history_permission_denied');
  assert.equal(retrySyncFailure({ code: 'permission_denied' }, 'discovery', 0, 0, 0).code, 'chat_list_permission_denied');
  assert.equal(retrySyncFailure({ code: 'invalid_credentials' }, 'incremental', 0, 0, 0).disable, true);
  assert.equal(retrySyncFailure({ code: 'network_error' }, 'backfill', 0, 0, 0).disable, false);
  assert.equal(retrySyncFailure({ code: 'network_error' }, 'backfill', 4, 0, 0).disable, true);
});

test('source-specific failures isolate product permissions while invalid credentials stop all sources', () => {
  const list = retrySyncFailure({ code: 'permission_denied' }, 'product-list', 0, 0, 0);
  assert.equal(list.code, 'product_list_permission_denied'); assert.equal(list.disable, true);
  assert.equal(retrySyncFailure({ code: 'permission_denied' }, 'product-details', 0, 0, 0).code, 'product_details_permission_denied');
  assert.equal(retrySyncFailure({ code: 'invalid_credentials' }, 'product-list', 0, 0, 0).disableAll, true);
  assert.equal(retrySyncFailure({ code: 'credentials_unavailable' }, 'discovery', 0, 0, 0).disableAll, true);
});

test('message checkpoints preserve opaque IDs and consume inclusive page boundaries', () => {
  assert.equal(historyCheckpoint('Backward', 'new', [{ id: 'new' }, { id: '0003' }, { id: 'large-opaque-id' }], true), 'large-opaque-id');
  assert.equal(historyCheckpoint('Forward', 'old', [{ id: 'old' }, { id: '000000000000000003' }, { id: 'new' }], false), 'new');
  assert.equal(historyCheckpoint('Forward', 'unchanged', [{ id: 'unchanged' }], false), 'unchanged');
  assert.equal(historyCheckpoint('Forward', 'unchanged', [], false), 'unchanged');
});

test('a hasNext page that cannot advance must stop instead of looping forever', () => {
  assert.throws(() => historyCheckpoint('Forward', 'unchanged', [{ id: 'unchanged' }], true), /cursor_stalled/);
  assert.throws(() => historyCheckpoint('Backward', null, [], true), /cursor_stalled/);
});

test('persisted cursor boundaries reject multi-page loops without comparing numeric IDs', () => {
  assert.throws(() => checkCursorProgress('b', 'a', ['a'], true), /cursor_stalled/);
  assert.throws(() => checkCursorProgress('b', 'a', ['a'], false), /cursor_stalled/);
  assert.doesNotThrow(() => checkCursorProgress('b', 'b', ['a'], false));
  assert.doesNotThrow(() => checkCursorProgress('b', null, ['a'], false));
});

test('history pages preserve provider ordering and reject contradictory timestamp directions', () => {
  const older = { id: 'opaque-a', createdAt: '2026-10-01T00:00:00Z' };
  const newer = { id: 'opaque-b', createdAt: '2026-10-02T00:00:00Z' };
  assert.equal(historyCheckpoint('Forward', null, [older, newer], true), newer.id);
  assert.equal(historyCheckpoint('Backward', null, [newer, older], true), older.id);
  assert.throws(() => historyCheckpoint('Forward', null, [newer, older], true), /invalid_response/);
  assert.throws(() => historyCheckpoint('Backward', null, [older, newer], true), /invalid_response/);
});

test('one bounded sync page discovers then imports history without creating an AI trigger', { timeout: 30_000 }, async context => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}',
    compatibilityDate: '2026-06-01', d1Databases: { DB: crypto.randomUUID() } });
  context.after(() => mf.dispose());
  const database = await mf.getD1Database('DB');
  const db = database as unknown as D1Database;
  const folder = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(folder).filter(name => name.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(new URL(file, folder), 'utf8').split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)) await database.prepare(sql).run();
  }
  const env = { DB: db, STORE_CREDENTIAL_KEYS: JSON.stringify({ v1: btoa('a'.repeat(32)) }), STORE_CREDENTIAL_ACTIVE_KEY: 'v1' };
  const envelope = await encryptCredentials(env, { orgId: 'org', storeId: 'store', platformStoreId: '123456', credentialVersion: 1 }, { apiKey: 'synthetic-secret' });
  const now = Date.now();
  await database.batch([
    database.prepare("INSERT INTO organization (id,name,slug,created_at) VALUES ('org','Org','org',1)"),
    database.prepare("INSERT INTO store (id,organization_id,name,platform_store_id,status,credential_key_version,credential_nonce,credential_ciphertext,capabilities,checked_at,expires_at,created_at,updated_at) VALUES ('store','org','Store','123456','verified',?,?,?,?,?,?,1,1)")
      .bind(envelope.keyVersion, envelope.nonce, envelope.ciphertext, JSON.stringify([{ code: 'auth', status: 'available' }, { code: 'chats_read', status: 'available' }]), now, now + 86_400_000),
    database.prepare("INSERT INTO store_coordinator (store_id,organization_id) VALUES ('store','org')"),
    database.prepare("INSERT INTO store_sync_source (store_id,organization_id,source,enabled,epoch,credential_version,due_at,updated_at) VALUES ('store','org','chat',1,1,1,0,1)"),
    database.prepare("INSERT INTO sync_cursor (store_id,organization_id,thread_id,stream,due_at) VALUES ('store','org','','discovery',0)"),
  ]);
  const requests: string[] = [];
  let mode: 'history' | 'incremental' | 'rate-limited' | 'pause' | 'empty' | 'bootstrap' | 'bootstrap-tail' | 'bootstrap-forward' = 'history';
  let discoveryNext: string | null = null;
  let emptyThread = false;
  const historyRequests: { direction: string; from_message_id?: number }[] = [];
  const fetcher = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    assert.equal(new Headers(init?.headers).get('Api-Key'), 'synthetic-secret');
    if (path === '/v3/chat/list') return Response.json({ chats: [{ chat: { chat_id: 'chat', chat_type: 'BUYER_SELLER', chat_status: 'Opened', created_at: '2026-10-01T00:00:00Z' }, last_message_id: emptyThread ? null : '10', unread_count: emptyThread ? 0 : 1 }, { chat: { chat_id: 'support', chat_type: 'SELLER_SUPPORT', chat_status: 'Opened', created_at: '2026-10-01T00:00:00Z' }, unread_count: 0 }], has_next: discoveryNext !== null, cursor: discoveryNext });
    if (path === '/v3/chat/history') {
      historyRequests.push(JSON.parse(String(init?.body)));
      if (mode === 'rate-limited') return new Response('', { status: 429, headers: { 'retry-after': '120' } });
      if (mode === 'pause') await database.prepare("UPDATE store SET status='paused',revision=revision+1 WHERE id='store'").run();
      const ids = mode === 'history' ? ['11', '10'] : mode === 'pause' ? ['13'] : mode === 'empty' ? [] : mode === 'bootstrap' ? ['22', '21'] : mode === 'bootstrap-tail' ? ['21', '20'] : mode === 'bootstrap-forward' ? ['22', '23'] : ['10', '11', '12'];
      return Response.json({ messages: ids.map(id => ({ message_id: id, created_at: '2026-10-01T00:00:00Z', user: { id: '123', type: id === '12' ? 'Seller' : id === '11' ? 'Сustomer' : 'Customer' }, data: ['A synthetic question'], is_image: false, is_read: false })), has_next: mode === 'bootstrap' });
    }
    throw new Error('Unexpected test request');
  }) as typeof fetch;
  await runSyncPage(env, { orgId: 'org', storeId: 'store' }, { fetcher });
  assert.deepEqual(requests, ['/v3/chat/list']);
  assert.equal(await database.prepare('SELECT count(*) FROM conversation').first('count(*)'), 1);
  await database.prepare("UPDATE store_sync_source SET due_at=0").run();
  await database.prepare("UPDATE sync_cursor SET due_at=0 WHERE stream='backfill'").run();
  await runSyncPage(env, { orgId: 'org', storeId: 'store' }, { fetcher });
  assert.deepEqual(requests, ['/v3/chat/list', '/v3/chat/history']);
  assert.equal(await database.prepare('SELECT count(*) FROM message').first('count(*)'), 2);
  assert.equal(await database.prepare('SELECT state FROM ingest_event').first('state'), 'historical');
  assert.equal(await database.prepare('SELECT lease_token FROM store_coordinator').first('lease_token'), null);

  await context.test('incremental overlap skips the baseline, recognizes both consumer spellings and observes seller echoes', async () => {
    mode = 'incremental';
    await database.prepare('UPDATE store_sync_source SET due_at=0').run();
    await database.prepare("UPDATE sync_cursor SET due_at=0 WHERE stream='incremental'").run();
    await runSyncPage(env, { orgId: 'org', storeId: 'store' }, { fetcher });
    assert.equal(await database.prepare('SELECT count(*) FROM message').first('count(*)'), 3);
    assert.equal(await database.prepare("SELECT count(*) FROM ingest_event WHERE state='pending'").first('count(*)'), 1);
    assert.equal(await database.prepare("SELECT count(*) FROM ingest_event WHERE state='observed'").first('count(*)'), 1);
    assert.equal(await database.prepare("SELECT cursor FROM sync_cursor WHERE stream='incremental'").first('cursor'), '12');
  });
  await context.test('429 stores a durable wait and immediately repeated wake does not fetch again', async () => {
    mode = 'rate-limited';
    await database.prepare('UPDATE store_sync_source SET due_at=0').run();
    await database.prepare("UPDATE sync_cursor SET due_at=0 WHERE stream='incremental'").run();
    const before = Date.now();
    await runSyncPage(env, { orgId: 'org', storeId: 'store' }, { fetcher });
    const state = await database.prepare('SELECT due_at,last_error FROM store_sync_source').first<{ due_at: number; last_error: string }>();
    assert.equal(state?.last_error, 'rate_limited');
    assert.ok(state!.due_at >= before + 120_000);
    const count = requests.length;
    await runSyncPage(env, { orgId: 'org', storeId: 'store' }, { fetcher });
    assert.equal(requests.length, count);
  });
  await context.test('pause while the provider responds fences the late page and stops subsequent reads', async () => {
    mode = 'pause';
    // Start this independent fault scenario after the synthetic provider cooldown.
    await database.prepare('UPDATE store_coordinator SET blocked_until=NULL').run();
    await database.prepare('UPDATE store_sync_source SET due_at=0').run();
    await runSyncPage(env, { orgId: 'org', storeId: 'store' }, { fetcher });
    assert.equal(await database.prepare('SELECT count(*) FROM message').first('count(*)'), 3);
    assert.equal(await database.prepare('SELECT enabled FROM store_sync_source').first('enabled'), 0);
    const count = requests.length;
    await runSyncPage(env, { orgId: 'org', storeId: 'store' }, { fetcher });
    assert.equal(requests.length, count);
  });
  await context.test('two-page provider cursor cycles stop durably without re-reading forever', async () => {
    discoveryNext = 'page-b';
    await database.batch([
      database.prepare("UPDATE store SET status='verified'"),
      database.prepare('UPDATE store_coordinator SET blocked_until=NULL'),
      database.prepare('UPDATE store_sync_source SET enabled=1,epoch=epoch+1,due_at=0,last_error=NULL,failures=0'),
      database.prepare("UPDATE sync_cursor SET due_at=0,cursor='page-a',recent_cursors='[]' WHERE stream='discovery'"),
    ]);
    await runSyncPage(env, { orgId: 'org', storeId: 'store' }, { fetcher });
    assert.equal(await database.prepare("SELECT cursor FROM sync_cursor WHERE stream='discovery'").first('cursor'), 'page-b');
    discoveryNext = 'page-a';
    await database.batch([
      database.prepare('UPDATE store_sync_source SET due_at=0'),
      database.prepare("UPDATE sync_cursor SET due_at=0 WHERE stream='discovery'"),
    ]);
    await runSyncPage(env, { orgId: 'org', storeId: 'store' }, { fetcher });
    assert.equal(await database.prepare('SELECT last_error FROM store_sync_source').first('last_error'), 'cursor_stalled');
    assert.equal(await database.prepare('SELECT enabled FROM store_sync_source').first('enabled'), 0);
    assert.equal(await database.prepare("SELECT cursor FROM sync_cursor WHERE stream='discovery'").first('cursor'), 'page-b');
    const count = requests.length;
    await runSyncPage(env, { orgId: 'org', storeId: 'store' }, { fetcher });
    assert.equal(requests.length, count);
  });
  await context.test('an empty thread establishes a real backward snapshot before any forward request', async () => {
    emptyThread = true;
    discoveryNext = null;
    mode = 'empty';
    await database.batch([
      database.prepare('DELETE FROM conversation'),
      database.prepare('UPDATE store_coordinator SET blocked_until=NULL'),
      database.prepare('UPDATE store_sync_source SET enabled=1,epoch=epoch+1,due_at=0,last_error=NULL,failures=0'),
      database.prepare("UPDATE sync_cursor SET due_at=0,cursor=NULL,recent_cursors='[]' WHERE stream='discovery'"),
    ]);
    const run = () => runSyncPage(env, { orgId: 'org', storeId: 'store' }, { fetcher });
    async function due(stream: string) {
      await database.batch([
        database.prepare('UPDATE store_sync_source SET due_at=0'),
        database.prepare('UPDATE sync_cursor SET due_at=0 WHERE stream=?').bind(stream),
      ]);
    }
    await run();
    await due('backfill');
    await run();
    assert.equal(await database.prepare("SELECT completed FROM sync_cursor WHERE stream='backfill'").first('completed'), 1);
    await due('incremental');
    await run();
    assert.deepEqual({ direction: historyRequests.at(-1)?.direction, from: historyRequests.at(-1)?.from_message_id }, { direction: 'Backward', from: undefined });
    assert.equal(Object.hasOwn(historyRequests.at(-1)!, 'from_message_id'), false, 'do not invent a zero message ID');
    assert.equal(await database.prepare("SELECT cursor FROM sync_cursor WHERE stream='incremental'").first('cursor'), null);
    assert.equal(await database.prepare('SELECT enabled FROM store_sync_source').first('enabled'), 1);
    mode = 'bootstrap';
    await due('incremental');
    await run();
    assert.equal(await database.prepare("SELECT cursor FROM sync_cursor WHERE stream='incremental'").first('cursor'), '22', 'the newest real ID becomes the forward frontier');
    assert.equal(await database.prepare("SELECT count(*) FROM ingest_event WHERE state='historical'").first('count(*)'), 2);
    assert.equal(await database.prepare("SELECT count(*) FROM ingest_event WHERE state='pending'").first('count(*)'), 0);
    const backfill = await database.prepare("SELECT cursor,completed FROM sync_cursor WHERE stream='backfill'").first();
    assert.deepEqual(backfill, { cursor: '21', completed: 0 }, 'a completed empty backfill is reopened to retain older pages');
    mode = 'bootstrap-tail';
    await due('backfill');
    await run();
    assert.equal(await database.prepare('SELECT count(*) FROM message').first('count(*)'), 3);
    assert.equal(await database.prepare("SELECT count(*) FROM ingest_event WHERE state='historical'").first('count(*)'), 3);
    mode = 'bootstrap-forward';
    await due('incremental');
    await run();
    assert.equal(historyRequests.at(-1)?.direction, 'Forward');
    assert.equal(historyRequests.at(-1)?.from_message_id, 22);
    assert.equal(await database.prepare('SELECT count(*) FROM message').first('count(*)'), 4);
    assert.equal(await database.prepare("SELECT count(*) FROM ingest_event WHERE state='pending'").first('count(*)'), 1);
  });
});
