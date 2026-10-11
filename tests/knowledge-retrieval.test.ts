import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knowledgeFixture } from './fixtures/knowledge.ts';
import { prepareKnowledge } from '../src/modules/knowledge/content.ts';
import { indexKnowledge, knowledgeManifest, knowledgeProfile, queryKnowledge } from '../src/modules/knowledge/vectorize.ts';
import { publishKnowledge, retrieveKnowledge, withdrawKnowledge, writeKnowledge } from '../src/modules/knowledge/storage.ts';
import type { KnowledgeScope } from '../src/shared/knowledge.ts';

const scope = { storeId: 'store-a', productRef: 'sku-a', language: 'ru' as const };
const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
async function fixture() {
  const f = await knowledgeFixture();
  const actor = (user = 'owner', orgId = 'company') => ({ orgId, actorUserId: user,
    sessionId: f.sqlite.prepare('SELECT id FROM session WHERE user_id=?').get(user)!.id as string });
  const rows = new Map<string, VectorizeVector>(), scores = new Map<string, number>(), calls: VectorizeQueryOptions[] = [];
  let beforeQuery: (() => Promise<void> | void) | undefined;
  let alter: ((rows: VectorizeMatch[]) => VectorizeMatch[]) | undefined;
  const index = { upsert: async (vectors: VectorizeVector[]) => {
    for (const row of vectors) rows.set(row.id, structuredClone(row)); return { mutationId: 'synthetic-retrieval-receipt' };
  }, query: async (_vector: number[], options: VectorizeQueryOptions) => {
    calls.push(structuredClone(options));
    const matches = [...rows.values()].filter(row => row.namespace === options.namespace
      && Object.entries(options.filter ?? {}).every(([key, value]) => value && typeof value === 'object' && '$in' in value
        ? Array.isArray(value.$in) && value.$in.includes(row.metadata![key] as string) : row.metadata?.[key] === value))
      .map(({ values, ...row }) => ({ ...row, score: scores.get(row.id) ?? .8 }))
      .sort((a, b) => b.score - a.score).slice(0, options.topK);
    await beforeQuery?.(); return { matches: alter ? alter(matches) : matches };
  } } as unknown as Vectorize;
  async function source(options: { id?: string; revision?: number; version?: number; score?: number; orgId?: string;
    scope?: Partial<KnowledgeScope>; publish?: boolean; content?: string } = {}) {
    const orgId = options.orgId ?? 'company', user = orgId === 'company' ? 'owner' : 'other';
    const id = options.id ?? crypto.randomUUID(), revision = options.revision ?? 1;
    const documentScope: KnowledgeScope = { ...scope, kind: 'guide', ...options.scope };
    const prepared = await prepareKnowledge(orgId, id, revision, documentScope,
      { title: 'Synthetic source', source: { format: 'text', content: options.content ?? `Approved source ${id} revision ${revision}` } });
    assert.equal(await writeKnowledge(f.db, actor(user, orgId), id, documentScope, prepared, options.version ?? 0, crypto.randomUUID()), true);
    const manifest = await knowledgeManifest(orgId, id, revision, documentScope, prepared);
    await indexKnowledge(index, manifest, prepared.chunks.map(() => vector), true);
    for (const row of rows.values()) if (row.namespace === manifest.namespace && row.metadata?.documentId === id && row.metadata?.revisionNumber === revision) scores.set(row.id, options.score ?? .8);
    // Synthetic visibility proofs isolate retrieval from the separately tested publication workflow.
    f.sqlite.prepare("UPDATE knowledge_revision SET status='ready',index_profile=?,mutation_id='draft-visible',tested_at=1,published_profile=?,published_mutation_id='published-visible',published_at=2 WHERE organization_id=? AND document_id=? AND revision=?")
      .run(knowledgeProfile.id, knowledgeProfile.id, orgId, id, revision);
    if (options.publish !== false) assert.ok(await publishKnowledge(f.db, actor(user, orgId), id, options.version === undefined ? 1 : options.version + 1));
    return { documentId: id, revision, contentHash: prepared.contentHash, manifest, prepared };
  }
  return { ...f, actor, index, rows, scores, calls, source,
    beforeQuery: (value: typeof beforeQuery) => { beforeQuery = value; }, alter: (value: typeof alter) => { alter = value; } };
}

test('active revision filtering happens before topK so pending copies cannot crowd out the published source', async t => {
  const f = await fixture(); t.after(f.close);
  const active = await f.source({ score: .5 });
  for (let i = 0; i < 12; i++) await f.source({ publish: false, score: .99 });
  const results = await queryKnowledge(f.index, 'company', scope, vector, [active]);
  assert.deepEqual(results.map(row => row.documentId), [active.documentId]);
  assert.deepEqual(f.calls[0].filter?.revision, { $in: [active.manifest.revisionKey] });
});

test('retrieval merges company, store and product knowledge, isolates scope and only returns D1 content', async t => {
  const f = await fixture(); t.after(f.close);
  const common = await f.source({ score: .9, scope: { storeId: null, productRef: null } });
  const store = await f.source({ score: .85, scope: { productRef: null } });
  const product = await f.source({ score: .8 });
  await f.source({ scope: { storeId: 'store-b' } }); await f.source({ scope: { productRef: 'sku-b' } });
  await f.source({ scope: { language: 'en' } }); await f.source({ publish: false });
  await f.source({ id: common.documentId, orgId: 'other', scope: { storeId: null, productRef: null }, score: 1, content: 'Other company private policy for the identical question' });
  const retired = await f.source({ score: 1 }); await withdrawKnowledge(f.db, f.actor(), retired.documentId, 2);
  f.alter(rows => rows.map(row => ({ ...row, metadata: { ...row.metadata, body: 'Untrusted provider text' } })));
  const results = await retrieveKnowledge(f.db, f.index, f.actor(), scope, vector);
  assert.deepEqual(results.map(row => row.documentId), [common.documentId, store.documentId, product.documentId]);
  assert.deepEqual(results.map(row => row.score), [.9, .85, .8]);
  assert.equal(results[0].body, common.prepared.chunks[0].body); assert.equal(JSON.stringify(results).includes('Untrusted provider text'), false);
  assert.deepEqual((f.calls[0].filter!.revision as { $in: string[] }).$in.sort(), [common, store, product].map(row => row.manifest.revisionKey).sort());
  const general = await retrieveKnowledge(f.db, f.index, f.actor(), { ...scope, productRef: null }, vector);
  assert.deepEqual(general.map(row => row.documentId), [common.documentId, store.documentId]);
});

test('a pending replacement keeps the old source retrievable and publication during search retries against the new revision', async t => {
  const f = await fixture(); t.after(f.close);
  const old = await f.source({ score: .5 });
  const replacement = await f.source({ id: old.documentId, revision: 2, version: 2, publish: false, score: .99 });
  assert.equal((await retrieveKnowledge(f.db, f.index, f.actor(), scope, vector))[0].revision, 1);
  f.calls.length = 0;
  f.beforeQuery(async () => { f.beforeQuery(undefined); assert.ok(await publishKnowledge(f.db, f.actor(), old.documentId, 3)); });
  const results = await retrieveKnowledge(f.db, f.index, f.actor(), scope, vector);
  assert.equal(f.calls.length, 2); assert.equal(results[0].revision, 2); assert.equal(results[0].body, replacement.prepared.chunks[0].body);
});

test('withdrawal during retrieval drops the retired hit and refills from current publications', async t => {
  const f = await fixture(); t.after(f.close);
  const retired = await f.source({ score: .99 }), current = await f.source({ score: .7 });
  f.beforeQuery(async () => { f.beforeQuery(undefined); assert.ok(await withdrawKnowledge(f.db, f.actor(), retired.documentId, 2)); });
  const results = await retrieveKnowledge(f.db, f.index, f.actor(), scope, vector);
  assert.deepEqual(results.map(row => row.documentId), [current.documentId]); assert.equal(f.calls.length, 2);
});

test('empty scopes are distinct from denied access and staff retrieval requires a current store grant', async t => {
  const f = await fixture(); t.after(f.close);
  assert.deepEqual(await retrieveKnowledge(f.db, f.index, f.actor(), scope, vector), []); assert.equal(f.calls.length, 0);
  await f.source();
  for (const actor of [f.actor('staff'), f.actor('other'), { ...f.actor(), sessionId: 'missing' }])
    await assert.rejects(() => retrieveKnowledge(f.db, f.index, actor, scope, vector), /KNOWLEDGE_ACCESS_DENIED/);
  assert.equal(f.calls.length, 0);
  f.sqlite.exec("INSERT INTO store_grant VALUES('company','store-a','staff',1)");
  assert.equal((await retrieveKnowledge(f.db, f.index, f.actor('staff'), scope, vector)).length, 1);
  f.beforeQuery(() => { f.sqlite.exec("DELETE FROM store_grant WHERE member_id='staff'"); });
  await assert.rejects(() => retrieveKnowledge(f.db, f.index, f.actor('staff'), scope, vector), /KNOWLEDGE_ACCESS_DENIED/);
});

test('removing and rejoining an administrator cannot revive the in-flight membership', async t => {
  const f = await fixture(); t.after(f.close); await f.source();
  f.beforeQuery(() => {
    f.sqlite.exec("DELETE FROM member WHERE id='admin'; INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('rejoined-admin','company','admin','admin',2)");
  });
  await assert.rejects(() => retrieveKnowledge(f.db, f.index, f.actor('admin'), scope, vector), /KNOWLEDGE_ACCESS_CHANGED/);
  assert.equal(f.calls.length, 1);
});

test('multiple whitelist batches preserve the best scores, fit provider limits and never silently truncate the document set', async t => {
  const f = await fixture(); t.after(f.close); const documents = [];
  for (let i = 0; i < 160; i++) documents.push(await f.source({ score: i / 200 }));
  const results = await retrieveKnowledge(f.db, f.index, f.actor(), scope, vector);
  assert.deepEqual(results.map(row => row.documentId), documents.slice(-10).reverse().map(row => row.documentId));
  assert.equal(f.calls.length, 8);
  for (const options of f.calls) {
    assert.ok(new TextEncoder().encode(JSON.stringify(options.filter)).length < 2048);
    assert.equal((options.filter!.revision as { $in: string[] }).$in.length, 20);
  }
  await f.source(); f.calls.length = 0;
  await assert.rejects(() => retrieveKnowledge(f.db, f.index, f.actor(), scope, vector), /KNOWLEDGE_RETRIEVAL_LIMIT/);
  assert.equal(f.calls.length, 0);
});

test('continued publication changes stop after one retry instead of returning a stale or partial result', async t => {
  const f = await fixture(); t.after(f.close); await f.source();
  f.beforeQuery(async () => { await f.source(); });
  await assert.rejects(() => retrieveKnowledge(f.db, f.index, f.actor(), scope, vector), /KNOWLEDGE_CHANGED/);
  assert.equal(f.calls.length, 2);
});

test('a missing index batch is unavailable, not an empty knowledge base or a partial success', async t => {
  const f = await fixture(); t.after(f.close); await f.source();
  f.alter(() => []);
  await assert.rejects(() => retrieveKnowledge(f.db, f.index, f.actor(), scope, vector), /KNOWLEDGE_INDEX_NOT_VISIBLE/);
  for (let i = 0; i < 20; i++) await f.source();
  f.calls.length = 0; f.alter(rows => f.calls.length === 1 ? [] : rows);
  await assert.rejects(() => retrieveKnowledge(f.db, f.index, f.actor(), scope, vector), /KNOWLEDGE_INDEX_NOT_VISIBLE/);
  assert.equal(f.calls.length, 2);
  f.alter(() => []); f.beforeQuery(() => {
    f.beforeQuery(undefined); f.sqlite.exec('UPDATE knowledge_document SET active_revision=NULL,version=version+1');
  });
  assert.deepEqual(await retrieveKnowledge(f.db, f.index, f.actor(), scope, vector), [], 'a concurrently withdrawn scope becomes a genuinely empty snapshot');
});

test('invalid index references, foreign metadata and provider errors do not become empty or trusted results', async t => {
  const f = await fixture(); t.after(f.close); await f.source();
  const changes = [
    (row: VectorizeMatch) => ({ ...row, namespace: 'foreign-company' }),
    (row: VectorizeMatch) => ({ ...row, score: NaN }),
    (row: VectorizeMatch) => ({ ...row, metadata: { ...row.metadata, revision: 'f'.repeat(64) } }),
    (row: VectorizeMatch) => ({ ...row, metadata: { ...row.metadata, profile: 'unsupported-profile' } }),
    (row: VectorizeMatch) => ({ ...row, metadata: { ...row.metadata, documentId: crypto.randomUUID() } }),
  ];
  for (const change of changes) {
    f.alter(rows => rows.map(change));
    await assert.rejects(() => retrieveKnowledge(f.db, f.index, f.actor(), scope, vector), /KNOWLEDGE_INDEX_INVALID/);
  }
  f.alter(rows => [...rows, ...rows]);
  await assert.rejects(() => retrieveKnowledge(f.db, f.index, f.actor(), scope, vector), /KNOWLEDGE_INDEX_INVALID/);
  f.alter(rows => rows.map(row => ({ ...row, metadata: { ...row.metadata, bodyHash: 'f'.repeat(64) } })));
  await assert.rejects(() => retrieveKnowledge(f.db, f.index, f.actor(), scope, vector), /KNOWLEDGE_CITATIONS_INVALID/);
  f.alter(() => { throw new Error('synthetic provider unavailable'); });
  await assert.rejects(() => retrieveKnowledge(f.db, f.index, f.actor(), scope, vector), /synthetic provider unavailable/);
});

test('the final read checks access again after citation hashing and refuses unsupported active profiles', async t => {
  const f = await fixture(); t.after(f.close); const document = await f.source(); let reads = 0;
  f.after(sql => { if (sql.includes('FROM json_each(?) wanted') && ++reads === 2) {
    f.after(undefined); f.sqlite.exec("UPDATE user SET email_verified=0 WHERE id='admin'");
  } });
  await assert.rejects(() => retrieveKnowledge(f.db, f.index, f.actor('admin'), scope, vector), /KNOWLEDGE_ACCESS_DENIED/);
  f.sqlite.prepare("UPDATE knowledge_revision SET index_profile='unsupported',published_profile='unsupported' WHERE document_id=?").run(document.documentId);
  f.calls.length = 0;
  await assert.rejects(() => retrieveKnowledge(f.db, f.index, f.actor(), scope, vector), /KNOWLEDGE_PROFILE_UNSUPPORTED/);
  assert.equal(f.calls.length, 0);
});
