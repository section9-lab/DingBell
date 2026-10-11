import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { knowledgeFixture } from './fixtures/knowledge.ts';
import type { KnowledgeBindings } from '../src/modules/knowledge/bindings.ts';
import type { WorkflowStep } from 'cloudflare:workers';

async function runtime() {
  const module = await import('../src/modules/knowledge/index-runtime.ts').catch(() => null);
  assert.ok(module, 'the durable indexing runtime must be implemented'); return module;
}
async function fixture(t: TestContext) {
  const f = await knowledgeFixture(); t.after(f.close);
  let modelCalls = 0, upserts = 0, visible = false, modelError = false, lostUpsert = false;
  let beforeModel: (() => Promise<void>) | undefined;
  const vectors = new Map<string, VectorizeVector>();
  const env = Object.assign(f.env, { KNOWLEDGE_INDEXING_ENABLED: 'true', KNOWLEDGE_DAILY_INPUT_BYTES: '100000',
    KNOWLEDGE_WORKFLOW: { async create() {}, async get() { throw new Error('missing'); } } as unknown as Workflow,
    KNOWLEDGE_AI: { async run(_model: string, input: { text: string[] }) { modelCalls++; await beforeModel?.(); if (modelError) throw new Error('private-provider-details');
      return { shape: [input.text.length, 1024], data: input.text.map(() => Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0)) }; } } as unknown as Ai,
    KNOWLEDGE_INDEX: { async upsert(rows: VectorizeVector[]) { upserts++; for (const row of rows) vectors.set(row.id, row);
      if (lostUpsert) { lostUpsert = false; throw new Error('synthetic lost receipt'); } return { mutationId: 'synthetic-receipt' }; },
      async queryById(_id: string, opts: any) { return { matches: visible ? [...vectors.values()].filter(v => Object.entries(opts.filter).every(([k, value]) => v.metadata?.[k] === value)).map(v => ({ ...v, score: 1 })) : [] }; },
    } as unknown as Vectorize,
  }) as typeof f.env & KnowledgeBindings;
  const id = crypto.randomUUID(), jobId = crypto.randomUUID(), scope = { organizationId: 'company', jobId };
  const source = { format: 'text', content: 'The blue variant is 26 cm wide.' };
  assert.equal((await f.request('', { id, title: 'Specification', kind: 'guide', storeId: 'store-a', productRef: 'sku-a', language: 'en', source })).status, 200);
  assert.equal((await f.request(`/${id}/index`, { jobId, expectedVersion: 1 })).status, 202);
  const job = () => f.sqlite.prepare('SELECT * FROM knowledge_index_job WHERE id=?').get(jobId)!;
  return { ...f, env, id, jobId, scope, job, counts: () => ({ modelCalls, upserts }), visible: () => { visible = true; },
    modelError: () => { modelError = true; }, lostUpsert: () => { lostUpsert = true; }, beforeModel: (fn: () => Promise<void>) => { beforeModel = fn; } };
}

test('indexing reuses saved embeddings, waits for visibility and leaves publication and testing unset', async t => {
  const f = await fixture(t), r = await runtime();
  assert.equal(await r.embedIndexJob(f.env, f.scope), true);
  assert.equal(await r.embedIndexJob(f.env, f.scope), true); assert.equal(f.counts().modelCalls, 1);
  f.lostUpsert(); await assert.rejects(r.upsertIndexJob(f.env, f.scope));
  assert.equal(await r.upsertIndexJob(f.env, f.scope), true);
  assert.equal(await r.confirmIndexJob(f.env, f.scope), 'waiting'); assert.equal(f.job().state, 'indexing');
  f.visible(); assert.equal(await r.confirmIndexJob(f.env, f.scope), 'done');
  assert.equal(f.job().state, 'succeeded'); assert.equal(f.job().vectors_json, null);
  const revision = f.sqlite.prepare('SELECT * FROM knowledge_revision WHERE document_id=?').get(f.id)!;
  assert.equal(revision.status, 'ready'); assert.equal(revision.tested_at, null);
  assert.equal((await f.request(`/${f.id}/publish`, { expectedVersion: 2 })).status, 409);
  assert.equal(await r.embedIndexJob(f.env, f.scope), false); assert.equal(f.counts().modelCalls, 1);
});

test('ambiguous model calls retain their reservation and are never automatically repeated', async t => {
  const f = await fixture(t), r = await runtime(); f.modelError();
  assert.equal(await r.embedIndexJob(f.env, f.scope), false);
  assert.equal(f.job().state, 'unknown'); assert.equal(f.job().error_code, 'EMBEDDING_UNCONFIRMED');
  assert.equal(await r.embedIndexJob(f.env, f.scope), false); assert.equal(f.counts().modelCalls, 1);
  assert.ok(Number(f.sqlite.prepare('SELECT reserved_bytes FROM knowledge_index_usage').get()?.reserved_bytes) > 0);
  assert.equal(JSON.stringify(f.job()).includes('private-provider-details'), false);
});

test('a saved embedding survives a lost database acknowledgement without a second model call', async t => {
  const f = await fixture(t), r = await runtime();
  f.after(sql => { if (sql.includes('vectors_json=?')) { f.after(undefined); throw new Error('synthetic lost database acknowledgement'); } });
  await r.embedIndexJob(f.env, f.scope).catch(() => {});
  assert.equal(await r.embedIndexJob(f.env, f.scope), true);
  assert.equal(f.job().state, 'indexing'); assert.equal(f.counts().modelCalls, 1);
});

test('a recorded attempt without a saved result is unknown, not another billable attempt', async t => {
  const f = await fixture(t), r = await runtime();
  f.sqlite.prepare("UPDATE knowledge_index_job SET state='embedding',attempted_at=1 WHERE id=?").run(f.jobId);
  assert.equal(await r.embedIndexJob(f.env, f.scope), false); assert.equal(f.job().state, 'unknown'); assert.equal(f.counts().modelCalls, 0);
});

test('revocation and leave/rejoin invalidate the frozen initiating membership', async t => {
  const f = await fixture(t), r = await runtime();
  f.sqlite.exec("UPDATE member SET role='owner' WHERE id='admin'; DELETE FROM member WHERE id='owner'; INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('new-member','company','owner','owner',2)");
  assert.equal(await r.embedIndexJob(f.env, f.scope), false); assert.equal(f.job().state, 'cancelled'); assert.equal(f.counts().modelCalls, 0);
});

test('editing during an embedding call prevents stale output from becoming ready', async t => {
  const f = await fixture(t), r = await runtime();
  f.beforeModel(async () => { assert.equal((await f.request(`/${f.id}/draft`, { expectedVersion: 2, title: 'New specification', source: { format: 'text', content: 'The width is now 28 cm.' } })).status, 200); });
  assert.equal(await r.embedIndexJob(f.env, f.scope), false);
  assert.equal(f.job().state, 'cancelled'); assert.equal(f.job().vectors_json, null);
  assert.equal(f.sqlite.prepare('SELECT status FROM knowledge_revision WHERE document_id=? AND revision=2').get(f.id)?.status, 'draft');
  assert.equal(f.counts().upserts, 0);
});

test('repair reconciles a lost Workflow create acknowledgement by identity and never restarts a terminal instance', async t => {
  const f = await fixture(t);
  const dispatch = await import('../src/modules/knowledge/index-dispatch.ts').catch(() => null);
  assert.ok(dispatch, 'the D1 outbox needs a scheduled dispatcher');
  let creates = 0, exists = false, status = 'running';
  Object.assign(f.env, { KNOWLEDGE_WORKFLOW: {
    async get() { if (!exists) throw new Error('missing'); return { async status() { return { status }; } }; },
    async create(input: any) { creates++; assert.deepEqual({ ...input.params }, f.scope); assert.match(input.id, /^knowledge-[a-f0-9]{64}$/); exists = true; throw new Error('synthetic lost create acknowledgement'); },
  } });
  await dispatch.repairKnowledgeIndexes(f.env); assert.equal(creates, 1); assert.equal(f.job().state, 'queued');
  assert.ok(Number(f.job().wake_after) > Date.now());
  f.sqlite.prepare('UPDATE knowledge_index_job SET wake_after=0 WHERE id=?').run(f.jobId);
  await dispatch.repairKnowledgeIndexes(f.env); assert.equal(creates, 1);
  status = 'errored'; f.sqlite.prepare('UPDATE knowledge_index_job SET wake_after=0 WHERE id=?').run(f.jobId);
  await dispatch.repairKnowledgeIndexes(f.env); assert.equal(creates, 1); assert.equal(f.job().state, 'failed');
});

test('repair expires abandoned attempts without another model call, including when indexing is disabled', async t => {
  const f = await fixture(t), dispatch = await import('../src/modules/knowledge/index-dispatch.ts').catch(() => null); assert.ok(dispatch);
  f.sqlite.prepare("UPDATE knowledge_index_job SET state='embedding',attempted_at=1,deadline_at=1 WHERE id=?").run(f.jobId);
  Object.assign(f.env, { KNOWLEDGE_INDEXING_ENABLED: 'false' });
  await dispatch.repairKnowledgeIndexes(f.env);
  assert.equal(f.job().state, 'unknown'); assert.equal(f.job().error_code, 'INDEX_DEADLINE'); assert.equal(f.counts().modelCalls, 0);
});

test('visibility waiting is bounded and does not mark an unqueryable revision ready', async t => {
  const f = await fixture(t), r = await runtime(); let sleeps = 0;
  const step = { do: async (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback(), sleep: async () => { sleeps++; } } as unknown as WorkflowStep;
  await r.runKnowledgeIndex(f.env, f.scope, step);
  assert.equal(sleeps, 29); assert.equal(f.job().state, 'failed'); assert.equal(f.job().error_code, 'INDEX_NOT_VISIBLE');
  assert.equal(f.job().vectors_json, null); assert.equal(f.counts().modelCalls, 1);
  assert.equal(f.sqlite.prepare('SELECT status FROM knowledge_revision WHERE document_id=?').get(f.id)?.status, 'failed');
});

test('a failed replacement leaves the previously published revision available', async t => {
  const f = await fixture(t), r = await runtime();
  // Seed prior publication evidence; this test does not claim the publication pipeline is implemented.
  f.sqlite.prepare("UPDATE knowledge_index_job SET state='cancelled' WHERE id=?").run(f.jobId);
  f.sqlite.prepare("UPDATE knowledge_revision SET status='ready',tested_at=1,index_profile='synthetic',mutation_id='synthetic-prior-draft',published_profile='synthetic',published_mutation_id='synthetic-prior-publication',published_at=2 WHERE document_id=?").run(f.id);
  assert.equal((await f.request(`/${f.id}/publish`, { expectedVersion: 2 })).status, 200);
  assert.equal((await f.request(`/${f.id}/draft`, { expectedVersion: 3, title: 'New specification', source: { format: 'text', content: 'The width is now 28 cm.' } })).status, 200);
  const jobId = crypto.randomUUID(); assert.equal((await f.request(`/${f.id}/index`, { jobId, expectedVersion: 4 })).status, 202);
  f.modelError(); assert.equal(await r.embedIndexJob(f.env, { organizationId: 'company', jobId }), false);
  assert.equal(f.sqlite.prepare('SELECT active_revision FROM knowledge_document WHERE id=?').get(f.id)?.active_revision, 1);
  const chunk = f.sqlite.prepare('SELECT id,body_hash FROM knowledge_chunk WHERE document_id=? AND revision=1 LIMIT 1').get(f.id)!;
  assert.equal((await f.request('/citations', { storeId: 'store-a', productRef: 'sku-a', language: 'en',
    citations: [{ documentId: f.id, revision: 1, chunkId: chunk.id, bodyHash: chunk.body_hash }] })).status, 200);
});
