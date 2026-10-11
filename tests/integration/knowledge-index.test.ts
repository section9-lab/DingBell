import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { nativeKnowledgeIndexFixture } from '../fixtures/knowledge-index.ts';

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  assert.fail('Native indexing did not reach the expected state within 40 seconds');
}
test('native Workflow/D1 replay after restart and an explicit local wake preserves completed effects', { timeout: 100_000 }, async t => {
  const f = await nativeKnowledgeIndexFixture(); t.after(f.close);
  assert.equal((await f.dispatch()).status, 200);
  await until(async () => Number((await f.db.prepare("SELECT COUNT(*) AS n FROM test_index_call WHERE kind='visibility'").first<{ n: number }>())?.n) > 0);
  assert.equal((await f.db.prepare('SELECT status FROM knowledge_revision WHERE document_id=?').bind(f.documentId).first())?.status, 'indexing');
  await f.restart();
  await f.db.prepare('UPDATE test_index_gate SET visible=1').run();
  // Miniflare 4.20260730's TimePriorityQueue.handleNextAlarm is a no-op.
  // An event wakes its engine; this proves replay, not automatic cloud alarm delivery.
  await f.wake();
  await until(async () => (await f.db.prepare('SELECT state FROM knowledge_index_job WHERE id=?').bind(f.jobId).first())?.state === 'succeeded');
  await until(async () => (await f.status()).status === 'complete');
  const calls = await f.db.prepare('SELECT kind,COUNT(*) AS n FROM test_index_call GROUP BY kind').all<{ kind: string; n: number }>();
  assert.equal(calls.results.find(c => c.kind === 'embedding')?.n, 1);
  assert.equal(calls.results.find(c => c.kind === 'upsert')?.n, 1);
  assert.equal((await f.db.prepare('SELECT active_revision FROM knowledge_document WHERE id=?').bind(f.documentId).first())?.active_revision, null);
  const revision = await f.db.prepare('SELECT status,tested_at FROM knowledge_revision WHERE document_id=?').bind(f.documentId).first();
  assert.equal(revision?.status, 'ready'); assert.equal(revision?.tested_at, null);
});

test('native model failures are terminal unknown results and are not dispatched again after restart', { timeout: 60_000 }, async t => {
  const f = await nativeKnowledgeIndexFixture(); t.after(f.close);
  await f.db.prepare("UPDATE test_index_gate SET mode='model-error'").run();
  await f.dispatch();
  await until(async () => (await f.db.prepare('SELECT state FROM knowledge_index_job WHERE id=?').bind(f.jobId).first())?.state === 'unknown');
  await f.restart(); await f.dispatch();
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM test_index_call WHERE kind='embedding'").first())?.n, 1);
  assert.equal((await f.db.prepare('SELECT vectors_json FROM knowledge_index_job WHERE id=?').bind(f.jobId).first())?.vectors_json, null);
});
