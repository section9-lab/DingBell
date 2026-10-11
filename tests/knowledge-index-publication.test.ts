import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareKnowledge } from '../src/modules/knowledge/content.ts';
import { indexKnowledge, knowledgeManifest, queryKnowledge } from '../src/modules/knowledge/vectorize.ts';

test('a delayed draft upsert cannot replace the already published vector copy', async () => {
  const documentId = '10000000-0000-4000-8000-000000000001';
  const scope = { kind: 'guide' as const, storeId: 'store-a', productRef: 'sku-a', language: 'ru' as const };
  const prepared = await prepareKnowledge('company-a', documentId, 1, scope, { title: '合成资料', source: { format: 'text', content: '宽度是26厘米。' } });
  const manifest = await knowledgeManifest('company-a', documentId, 1, scope, prepared);
  const rows = new Map<string, VectorizeVector>();
  const index = {
    upsert: async (vectors: VectorizeVector[]) => { for (const row of vectors) rows.set(row.id, structuredClone(row)); return { mutationId: crypto.randomUUID() }; },
    query: async () => ({ matches: [...rows.values()].filter(row => row.metadata?.eligible === true).map(({ values, ...row }) => ({ ...row, score: 1 })) }),
  } as unknown as Vectorize;
  const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
  await indexKnowledge(index, manifest, [vector]);
  await indexKnowledge(index, manifest, [vector], true);
  await indexKnowledge(index, manifest, [vector]);
  const candidates = await queryKnowledge(index, 'company-a', scope, vector, [{ documentId, revision: 1, contentHash: prepared.contentHash }]);
  assert.equal(candidates.length, 1, 'a late draft retry must not remove the published candidate');
  assert.equal(candidates[0].chunkId, prepared.chunks[0].id, 'D1 references remain stable across index copies');
  assert.equal(rows.size, 2, 'staging and published vectors have independent identities');
});
