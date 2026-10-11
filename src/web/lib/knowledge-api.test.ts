import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKnowledge, readKnowledge, readKnowledgeList, readKnowledgeJob, submitKnowledgeJob } from './knowledge-api.ts';

const id = '10000000-0000-4000-8000-000000000001', jobId = '20000000-0000-4000-8000-000000000001';
const scope = { kind: 'faq' as const, storeId: null, productRef: null, language: 'ru' as const };
const draft = { revision: 1, title: 'Store policy', source: { format: 'text' as const, content: 'Verified policy.' }, contentHash: 'a'.repeat(64), status: 'draft', testedAt: null, createdAt: 1, rollbackOf: null, publicationReady: false };
const detail = { companyId: 'a/b', document: { id, ...scope, version: 1, draftRevision: 1, activeRevision: null, updatedAt: 1 }, draft, active: null, operation: null };
const job = { id: jobId, documentId: id, revision: 1, documentVersion: 2, state: 'queued', inputBytes: 20, attemptedAt: null, errorCode: null, createdAt: 1, updatedAt: 1 };

test('knowledge requests preserve tenant scope, filters and the exact durable submission ID', async t => {
  const calls: { url: string; init: RequestInit }[] = [];
  let response: unknown = detail;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => { calls.push({ url, init }); return Response.json(response); });
  assert.deepEqual(await readKnowledge('a/b', id), detail);
  assert.equal(calls[0].url, `/api/companies/a%2Fb/knowledge/${id}`);
  response = { companyId: 'a/b', documents: [], nextAfter: null, capabilities: { indexing: false, review: false } };
  await readKnowledgeList('a/b', { storeId: null, kind: 'faq', publication: 'unpublished' }, 'cursor');
  const url = new URL(calls[1].url, 'https://example.invalid');
  assert.equal(url.searchParams.get('storeId'), ''); assert.equal(url.searchParams.get('kind'), 'faq'); assert.equal(url.searchParams.get('after'), 'cursor');
  response = { companyId: 'a/b', job };
  await submitKnowledgeJob('a/b', id, 'index', { jobId, expectedVersion: 1 });
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { jobId, expectedVersion: 1 });
  assert.equal(calls[2].init.method, 'POST');
  assert.deepEqual(await readKnowledgeJob('a/b', id, { id: jobId, kind: 'index' }), { companyId: 'a/b', job });
});

test('knowledge response contracts reject another scope, contradictory publication pointers and malformed jobs', async t => {
  for (const value of [
    { ...detail, companyId: 'other' }, { ...detail, document: { ...detail.document, id: crypto.randomUUID() } },
    { ...detail, document: { ...detail.document, activeRevision: 1 } }, { ...detail, draft: { ...draft, revision: 2 } },
    { ...detail, active: draft }, { ...detail, operation: { id: jobId, kind: 'send' } },
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(value));
    await assert.rejects(() => readKnowledge('a/b', id), { code: 'INVALID_RESPONSE' }); mock.mock.restore();
  }
  for (const value of [{ ...job, documentId: crypto.randomUUID() }, { ...job, id: crypto.randomUUID() }, { ...job, state: 'published' }, { ...job, revision: 3 }]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ companyId: 'a/b', job: value }));
    await assert.rejects(() => readKnowledgeJob('a/b', id, { id: jobId, kind: 'index' }), { code: 'INVALID_RESPONSE' }); mock.mock.restore();
  }
});

test('uncertain knowledge writes are not automatically retried', async t => {
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('connection lost'); });
  await assert.rejects(() => createKnowledge('a/b', id, scope, { title: draft.title, source: draft.source }), { code: 'OPERATION_UNCONFIRMED' });
  assert.equal(calls, 1);
});
