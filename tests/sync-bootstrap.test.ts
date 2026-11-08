import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationControlFixture } from './fixtures/conversation-control.ts';
import { bootstrapStoreSync, runStartupBootstrap } from '../src/modules/sync/bootstrap.ts';

async function fixture() {
  const f = await conversationControlFixture();
  const now = Date.now();
  await f.db.prepare(`UPDATE store SET status='verified',platform='ozon',expires_at=?,credential_key_version='v1',credential_nonce='nonce',
    credential_ciphertext='ciphertext',credential_version=1,capabilities=? WHERE id='store'`)
    .bind(now + 3_600_000, JSON.stringify([
      { code: 'auth', status: 'available' }, { code: 'chats_read', status: 'available' },
      { code: 'products_read', status: 'available' }, { code: 'orders_fbs_read', status: 'available' },
    ])).run();
  return f;
}

test('startup bootstrap creates the initial chat, product and FBS work and completes once', { timeout: 30_000 }, async t => {
  const f = await fixture(); t.after(f.close);
  const wake = async () => {};
  await runStartupBootstrap({ DB: f.db }, { wake });
  const marker = await f.db.prepare("SELECT completed_at AS completedAt FROM sync_bootstrap WHERE id='startup'").first<{ completedAt: number | null }>();
  assert.ok(marker?.completedAt);
  const storeMarker = await f.db.prepare("SELECT completed_at AS completedAt FROM sync_bootstrap WHERE id='store'").first<{ completedAt: number | null }>();
  assert.ok(storeMarker?.completedAt);
  const sources = (await f.db.prepare('SELECT source,enabled,epoch FROM store_sync_source ORDER BY source').all<{ source: string; enabled: number; epoch: number }>()).results;
  assert.deepEqual(sources.map(row => row.source), ['chat', 'fbs_postings', 'products']);
  assert.ok(sources.every(row => row.enabled === 1 && row.epoch >= 1));
  assert.ok(await f.db.prepare("SELECT 1 FROM sync_cursor WHERE store_id='store' AND stream='discovery'").first());
  assert.ok(await f.db.prepare("SELECT 1 FROM product_sync_cursor WHERE store_id='store'").first());
  assert.ok(await f.db.prepare("SELECT 1 FROM fbs_sync_window WHERE store_id='store'").first());
  const before = (await f.db.prepare('SELECT COUNT(*) AS n FROM store_sync_source').first<{ n: number }>())!.n;
  await runStartupBootstrap({ DB: f.db }, { wake });
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM store_sync_source').first<{ n: number }>())!.n, before);
});

test('a store without read capabilities is marked complete but gets no empty sync work', { timeout: 30_000 }, async t => {
  const f = await fixture(); t.after(f.close);
  await f.db.prepare("UPDATE store SET capabilities=? WHERE id='store'").bind(JSON.stringify([{ code: 'auth', status: 'available' }])).run();
  const result = await bootstrapStoreSync({ DB: f.db }, { orgId: 'org', storeId: 'store' }, { wake: async () => {} });
  assert.equal(result.status, 'completed');
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM store_sync_source').first<{ n: number }>())!.n, 0);
  assert.ok(await f.db.prepare("SELECT completed_at FROM sync_bootstrap WHERE id='store'").first('completed_at'));
});
