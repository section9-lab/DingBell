import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeKnowledgeIndexFixture } from '../fixtures/knowledge-index.ts';
import { admitReviewJob } from '../../src/modules/knowledge/review-storage.ts';

async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 40_000;
  while (Date.now() < end) { if (await check()) return; await delay(100); }
  assert.fail('The native knowledge review did not reach the expected state');
}
test('native testing persists results and publication resumes after restart without repeating the model or copy', { timeout: 120_000 }, async t => {
  const f = await nativeKnowledgeIndexFixture(); t.after(f.close);
  await f.db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,created_at,updated_at) VALUES('store-a','company','Synthetic store','synthetic-store',1,1)").run();
  await f.db.prepare('UPDATE test_index_gate SET visible=1').run(); await f.dispatch();
  await until(async () => (await f.db.prepare('SELECT state FROM knowledge_index_job WHERE id=?').bind(f.jobId).first())?.state === 'succeeded');
  const chunk = await f.db.prepare('SELECT id FROM knowledge_chunk WHERE document_id=?').bind(f.documentId).first<{ id: string }>();
  const actor = { orgId: 'company', actorUserId: 'owner', sessionId: 'login' }, testId = crypto.randomUUID();
  assert.equal(await admitReviewJob(f.db, actor, f.documentId, testId, 2, [{ question: 'Where are the instructions?', expectedChunkId: chunk!.id, minimumScore: .7 }], 100000), true);
  await f.dispatchReviews();
  await until(async () => (await f.db.prepare('SELECT state FROM knowledge_review_job WHERE id=?').bind(testId).first())?.state === 'succeeded');
  const result = await f.db.prepare('SELECT results_json,vectors_json FROM knowledge_review_job WHERE id=?').bind(testId).first<{ results_json: string; vectors_json: string | null }>();
  assert.equal(JSON.parse(result!.results_json).passed, true); assert.equal(result?.vectors_json, null);
  assert.equal((await f.db.prepare('SELECT active_revision FROM knowledge_document WHERE id=?').bind(f.documentId).first())?.active_revision, null);
  assert.deepEqual(await (await f.retrieve()).json(), [], 'ready, tested drafts are not active retrieval sources');
  const publicationId = crypto.randomUUID();
  await f.db.prepare('UPDATE test_index_gate SET visible=0').run();
  assert.equal(await admitReviewJob(f.db, actor, f.documentId, publicationId, 3, null, 100000), true);
  await f.dispatchReviews();
  await until(async () => (await f.db.prepare('SELECT mutation_id FROM knowledge_review_job WHERE id=?').bind(publicationId).first())?.mutation_id != null);
  await f.restart(); await f.db.prepare('UPDATE test_index_gate SET visible=1').run();
  // The pinned local scheduler requires an explicit wake; this is not a cloud alarm test.
  await f.wakeReview(publicationId);
  await until(async () => (await f.db.prepare('SELECT state FROM knowledge_review_job WHERE id=?').bind(publicationId).first())?.state === 'succeeded');
  await until(async () => (await f.reviewStatus(publicationId)).status === 'complete');
  assert.equal((await f.db.prepare('SELECT active_revision FROM knowledge_document WHERE id=?').bind(f.documentId).first())?.active_revision, 1);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM test_index_call WHERE kind='embedding'").first())?.n, 2);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM test_index_call WHERE kind='upsert'").first())?.n, 2);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM knowledge_audit_event WHERE action='publish.completed' AND outcome='succeeded'").first())?.n, 1);
  const retrieved = await f.retrieve(); assert.equal(retrieved.status, 200);
  const citations = await retrieved.json() as { documentId: string; revision: number; body: string }[];
  assert.equal(citations.length, 1); assert.equal(citations[0].documentId, f.documentId); assert.equal(citations[0].revision, 1);
  assert.match(citations[0].body, /Use the instructions supplied with your product/);
  await f.db.prepare("UPDATE test_index_gate SET mode='query-empty'").run();
  const unavailable = await f.retrieve(); assert.equal(unavailable.status, 409);
  assert.equal((await unavailable.json() as any).error, 'KNOWLEDGE_INDEX_NOT_VISIBLE');
  await f.db.prepare("UPDATE test_index_gate SET mode='normal'").run();
  await f.db.prepare('UPDATE knowledge_document SET active_revision=NULL,version=version+1 WHERE id=?').bind(f.documentId).run();
  assert.deepEqual(await (await f.retrieve()).json(), [], 'stale published vectors cannot revive withdrawn D1 sources');
  await f.db.prepare("UPDATE session SET expires_at=1 WHERE id='login'").run();
  const denied = await f.retrieve(); assert.equal(denied.status, 409); assert.equal((await denied.json() as any).error, 'KNOWLEDGE_ACCESS_DENIED');
});
