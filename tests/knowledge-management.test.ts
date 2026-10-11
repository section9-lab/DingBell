import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knowledgeFixture } from './fixtures/knowledge.ts';
import { immediateSteps, knowledgeReviewFixture } from './fixtures/knowledge-review.ts';
import { runKnowledgeReview } from '../src/modules/knowledge/review-runtime.ts';

test('knowledge catalog filters apply before pagination and expose deployment capabilities without credentials', async t => {
  const f = await knowledgeFixture(); t.after(f.close);
  const create = async (extra = {}) => {
    const value = { id: crypto.randomUUID(), kind: 'faq', storeId: null, productRef: null, language: 'ru', title: 'Test policy', source: { format: 'text', content: 'Confirmed information.' }, ...extra };
    assert.equal((await f.request('', value)).status, 200); return value;
  };
  for (let i = 0; i < 21; i++) await create({ kind: 'guide', storeId: 'store-b' });
  const selected = await create({ kind: 'policy', storeId: 'store-a', language: 'en' });
  const response = await f.request('?kind=policy&storeId=store-a&language=en&publication=unpublished');
  assert.equal(response.status, 200);
  const data = await response.json() as any;
  assert.deepEqual(data.documents.map((row: any) => row.id), [selected.id]); assert.equal(data.nextAfter, null);
  assert.deepEqual(data.capabilities, { indexing: false, review: false });
  f.sqlite.prepare("UPDATE knowledge_revision SET status='ready',index_profile='synthetic',mutation_id='draft-visible',tested_at=1,published_profile='synthetic',published_mutation_id='copy-visible',published_at=2 WHERE document_id=?").run(selected.id);
  assert.equal((await f.request(`/${selected.id}/publish`, { expectedVersion: 1 })).status, 200);
  assert.deepEqual((await (await f.request('?publication=published')).json() as any).documents.map((row: any) => row.id), [selected.id]);
  assert.deepEqual((await (await f.request('?kind=policy&publication=unpublished')).json() as any).documents, []);
  assert.equal((await f.request('?storeId=store-other')).status, 200);
  assert.deepEqual((await (await f.request('?storeId=store-other')).json() as any).documents, []);
  assert.deepEqual((await (await f.request('?storeId=')).json() as any).documents, []);
  for (const query of ['?kind=invalid', '?publication=ready', '?language=fr', '?kind=faq&kind=guide', '?namespace=other'])
    assert.equal((await f.request(query)).status, 400);
});

test('completed publication remains discoverable after its final version increment and withdrawal clears it', async t => {
  const f = await knowledgeReviewFixture(); t.after(f.close); f.visible();
  const testId = crypto.randomUUID(), publishId = crypto.randomUUID();
  assert.equal((await f.request(`/${f.id}/tests`, { jobId: testId, expectedVersion: 2, cases: f.cases })).status, 202);
  await runKnowledgeReview(f.env, { organizationId: 'company', jobId: testId }, immediateSteps);
  assert.equal((await f.request(`/${f.id}/publish`, { jobId: publishId, expectedVersion: 3 })).status, 202);
  await runKnowledgeReview(f.env, { organizationId: 'company', jobId: publishId }, immediateSteps);
  const published = await (await f.request(`/${f.id}`)).json() as any;
  assert.equal(published.document.version, 5); assert.equal(published.document.activeRevision, 1);
  assert.deepEqual(published.operation, { id: publishId, kind: 'publish' });
  const withdrawn = await f.request(`/${f.id}/withdraw`, { expectedVersion: 5 }); assert.equal(withdrawn.status, 200);
  const data = await withdrawn.json() as any; assert.equal(data.operation, null); assert.equal(data.active, null);
});

test('document reads recover the current durable operation and stop pointing at jobs invalidated by a newer draft', async t => {
  const f = await knowledgeReviewFixture(); t.after(f.close);
  const indexJobId = f.sqlite.prepare('SELECT id FROM knowledge_index_job WHERE document_id=?').get(f.id)!.id;
  assert.deepEqual((await (await f.request(`/${f.id}`)).json() as any).operation, { id: indexJobId, kind: 'index' });
  assert.deepEqual((await (await f.request()).json() as any).capabilities, { indexing: true, review: true });
  const jobId = crypto.randomUUID();
  assert.equal((await f.request(`/${f.id}/tests`, { jobId, expectedVersion: 2, cases: f.cases })).status, 202);
  assert.deepEqual((await (await f.request(`/${f.id}`)).json() as any).operation, { id: jobId, kind: 'test' });
  assert.equal((await f.request(`/${f.id}/draft`, { expectedVersion: 3, title: 'A new draft', source: { format: 'text', content: 'Updated verified information.' } })).status, 200);
  assert.equal((await (await f.request(`/${f.id}`)).json() as any).operation, null);
  assert.equal((await f.request(`/${f.id}`, undefined, 'other', 'other')).status, 404);
});
