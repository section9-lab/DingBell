import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knowledgeFixture } from './fixtures/knowledge.ts';
import { prepareKnowledge } from '../src/modules/knowledge/content.ts';
import * as vectorize from '../src/modules/knowledge/vectorize.ts';

test('a tested draft receipt alone cannot publish through HTTP or direct SQL', async t => {
  const f = await knowledgeFixture(); t.after(f.close);
  const id = crypto.randomUUID();
  assert.equal((await f.request('', { id, kind: 'guide', storeId: 'store-a', productRef: null, language: 'en', title: 'Synthetic guide',
    source: { format: 'text', content: 'Use the power button.' } })).status, 200);
  f.sqlite.prepare("UPDATE knowledge_revision SET status='ready',tested_at=1,index_profile=?,mutation_id='draft-receipt' WHERE document_id=?")
    .run(vectorize.knowledgeProfile.id, id);
  const response = await f.request(`/${id}/publish`, { expectedVersion: 1 });
  assert.equal(response.status, 409, 'draft visibility must not authorize publication');
  assert.equal((await response.json() as any).error.code, 'KNOWLEDGE_PUBLICATION_NOT_READY');
  assert.throws(() => f.sqlite.prepare('UPDATE knowledge_document SET active_revision=1,version=2 WHERE id=?').run(id), /publication requires/);
  assert.equal(f.sqlite.prepare('SELECT active_revision FROM knowledge_document WHERE id=?').get(id)?.active_revision, null);
  for (const [profile, receipt, time] of [
    ['wrong-profile', 'published-receipt', 2], [vectorize.knowledgeProfile.id, '', 2], [vectorize.knowledgeProfile.id, 'published-receipt', 0],
  ]) {
    f.sqlite.prepare('UPDATE knowledge_revision SET published_profile=?,published_mutation_id=?,published_at=? WHERE document_id=?').run(profile, receipt, time, id);
    assert.equal((await (await f.request(`/${id}`)).json() as any).draft.publicationReady, false);
    assert.equal((await f.request(`/${id}/publish`, { expectedVersion: 1 })).status, 409);
    assert.throws(() => f.sqlite.prepare('UPDATE knowledge_document SET active_revision=1,version=2 WHERE id=?').run(id), /publication requires/);
  }
  f.sqlite.prepare('UPDATE knowledge_revision SET published_profile=?,published_mutation_id=?,published_at=2 WHERE document_id=?')
    .run(vectorize.knowledgeProfile.id, 'published-receipt', id);
  f.sqlite.prepare('UPDATE knowledge_revision SET mutation_id=NULL WHERE document_id=?').run(id);
  assert.equal((await (await f.request(`/${id}`)).json() as any).draft.publicationReady, false, 'the read model must not promise a publish that SQL rejects');
  f.sqlite.prepare("UPDATE knowledge_revision SET mutation_id='draft-receipt' WHERE document_id=?").run(id);
  assert.equal((await (await f.request(`/${id}`)).json() as any).draft.publicationReady, true);
  // The fixture injects verified evidence. The test does not claim the business test/promotion workflow is implemented.
  assert.equal((await f.request(`/${id}/publish`, { expectedVersion: 1 })).status, 200);
  assert.equal((await f.request(`/${id}/draft`, { expectedVersion: 2, title: 'Replacement', source: { format: 'text', content: 'Updated instructions.' } })).status, 200);
  const replacement = await (await f.request(`/${id}`)).json() as any;
  assert.equal(replacement.document.activeRevision, 1); assert.equal(replacement.draft.publicationReady, false);
  assert.equal((await f.request(`/${id}/publish`, { expectedVersion: 3 })).status, 409);
});

test('publication rechecks its independent proof inside the final database update', async t => {
  const f = await knowledgeFixture(); t.after(f.close);
  const id = crypto.randomUUID();
  assert.equal((await f.request('', { id, kind: 'guide', storeId: null, productRef: null, language: 'en', title: 'Synthetic guide',
    source: { format: 'text', content: 'Synthetic instructions.' } })).status, 200);
  f.sqlite.prepare("UPDATE knowledge_revision SET status='ready',tested_at=1,index_profile='synthetic',mutation_id='draft',published_profile='synthetic',published_mutation_id='published',published_at=2 WHERE document_id=?").run(id);
  f.before(sql => {
    if (!sql.startsWith('UPDATE knowledge_document SET active_revision=draft_revision')) return;
    f.before(undefined);
    f.sqlite.prepare('UPDATE knowledge_revision SET published_at=NULL WHERE document_id=?').run(id);
  });
  assert.equal((await f.request(`/${id}/publish`, { expectedVersion: 1 })).status, 409);
  assert.equal(f.sqlite.prepare('SELECT active_revision FROM knowledge_document WHERE id=?').get(id)?.active_revision, null);
  assert.equal(f.sqlite.prepare('SELECT version FROM knowledge_document WHERE id=?').get(id)?.version, 1);
});

async function indexFixture() {
  const scope = { kind: 'guide' as const, storeId: 'store-a', productRef: null, language: 'en' as const };
  const documentId = crypto.randomUUID();
  const prepared = await prepareKnowledge('company', documentId, 1, scope,
    { title: 'Synthetic guide', source: { format: 'text', content: 'Synthetic operating instructions. '.repeat(100).trim() } });
  const manifest = await vectorize.knowledgeManifest('company', documentId, 1, scope, prepared);
  const records = new Map<string, VectorizeVector>(); let writes = 0, visible = false;
  let alter = (rows: VectorizeVector[]) => rows;
  const index = {
    async upsert(rows: VectorizeVector[]) { writes++; for (const row of rows) records.set(row.id, structuredClone(row)); return { mutationId: `receipt-${writes}` }; },
    async getByIds(ids: string[]) { return alter(ids.map(id => structuredClone(records.get(id)!)).reverse()); },
    async queryById() { return { matches: visible ? [...records.values()].filter(row => row.metadata?.eligible === true).map(({ values, ...row }) => ({ ...row, score: 1 })) : [] }; },
  } as unknown as Vectorize;
  const vectors = prepared.chunks.map((_, ordinal) => Array.from({ length: 1024 }, (_, i) => i === ordinal ? 1 : 0));
  await vectorize.indexKnowledge(index, manifest, vectors);
  return { manifest, index, records, vectors, writes: () => writes, visible: () => { visible = true; }, alter: (fn: typeof alter) => { alter = fn; } };
}

test('publication reuses validated draft vectors, preserves order, and still requires query visibility', async () => {
  assert.equal(typeof vectorize.copyKnowledgeToPublished, 'function');
  const f = await indexFixture();
  const receipt = await vectorize.copyKnowledgeToPublished(f.index, f.manifest);
  assert.equal(receipt, 'receipt-2');
  const published = [...f.records.values()].filter(row => row.metadata?.eligible === true);
  assert.equal(published.length, f.manifest.chunks.length);
  assert.deepEqual(published.map(row => row.values), f.vectors);
  assert.equal(await vectorize.isKnowledgeVisible(f.index, f.manifest, true), false, 'copy acceptance is not publication readiness');
  f.visible(); assert.equal(await vectorize.isKnowledgeVisible(f.index, f.manifest, true), true);
  await vectorize.copyKnowledgeToPublished(f.index, f.manifest);
  assert.equal(f.records.size, f.manifest.chunks.length * 2, 'retry uses stable, separate published IDs');
});

test('publication rejects missing, mixed-scope or malformed draft vectors before writing', async () => {
  assert.equal(typeof vectorize.copyKnowledgeToPublished, 'function');
  const f = await indexFixture();
  for (const alter of [
    (_rows: VectorizeVector[]) => [],
    (rows: VectorizeVector[]) => rows.map(() => rows[0]),
    (rows: VectorizeVector[]) => rows.map(row => ({ ...row, namespace: 'other-company' })),
    (rows: VectorizeVector[]) => rows.map(row => ({ ...row, id: 'wrong-id' })),
    (rows: VectorizeVector[]) => rows.map(row => ({ ...row, values: [1, 2] })),
    ...['scope', 'product', 'language', 'revision', 'profile', 'chunkId', 'bodyHash', 'documentId', 'revisionNumber', 'eligible'].map(key =>
      (rows: VectorizeVector[]) => rows.map(row => ({ ...row, metadata: { ...row.metadata, [key]: 'wrong' } }))),
  ]) {
    f.alter(alter);
    await assert.rejects(() => vectorize.copyKnowledgeToPublished(f.index, f.manifest), /KNOWLEDGE_(INDEX|EMBEDDING)_INVALID/);
    assert.equal(f.writes(), 1, 'invalid provider data must not write published copies');
  }
});
