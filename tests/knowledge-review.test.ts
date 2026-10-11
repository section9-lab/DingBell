import assert from 'node:assert/strict';
import { test } from 'node:test';
import { immediateSteps, knowledgeReviewFixture } from './fixtures/knowledge-review.ts';
import { runKnowledgeIndex } from '../src/modules/knowledge/index-runtime.ts';

async function runtime() {
  const r = await import('../src/modules/knowledge/review-runtime.ts').catch(() => null);
  assert.ok(r, 'persistent knowledge testing and publication runtime is required'); return r;
}
test('saved retrieval tests and asynchronous publication form a complete isolated backend journey', async t => {
  const f = await knowledgeReviewFixture(); t.after(f.close);
  const inputs = await f.request(`/${f.id}/test-inputs`); assert.equal(inputs.status, 200);
  assert.equal((await inputs.json() as any).chunks[0].id, f.cases[0].expectedChunkId);
  const jobId = crypto.randomUUID(), body = { jobId, expectedVersion: 2, cases: f.cases };
  const admitted = await f.request(`/${f.id}/tests`, body); assert.equal(admitted.status, 202, await admitted.clone().text());
  assert.equal((await f.request(`/${f.id}/tests`, body)).status, 202);
  const r = await runtime(); await r.runKnowledgeReview(f.env, { organizationId: 'company', jobId }, immediateSteps);
  const result = await (await f.request(`/${f.id}/reviews/${jobId}`)).json() as any;
  assert.equal(result.job.state, 'succeeded'); assert.equal(result.job.results.passed, true); assert.deepEqual(result.job.cases, f.cases);
  assert.equal('vectorsJson' in result.job, false);
  const tested = await (await f.request(`/${f.id}`)).json() as any;
  assert.ok(tested.draft.testedAt); assert.equal(tested.draft.publicationReady, false); assert.equal(tested.document.activeRevision, null);
  const publicationId = crypto.randomUUID(), request = { jobId: publicationId, expectedVersion: 3 };
  assert.equal((await f.request(`/${f.id}/publish`, request)).status, 202);
  const scope = { organizationId: 'company', jobId: publicationId };
  await r.copyReviewPublication(f.env, scope);
  assert.equal(await r.confirmReviewPublication(f.env, scope), 'waiting');
  assert.equal((await (await f.request(`/${f.id}`)).json() as any).document.activeRevision, null);
  f.visible(); assert.equal(await r.confirmReviewPublication(f.env, scope), 'done');
  const published = await (await f.request(`/${f.id}`)).json() as any;
  assert.equal(published.document.activeRevision, 1); assert.equal(published.document.version, 5);
  assert.equal(published.draft.publicationReady, true); assert.deepEqual(f.counts(), { modelCalls: 2, copies: 1 });
  await r.runKnowledgeReview(f.env, scope, immediateSteps);
  assert.equal((await f.request(`/${f.id}/publish`, request)).status, 202); assert.deepEqual(f.counts(), { modelCalls: 2, copies: 1 });
  assert.equal((await (await f.request(`/${f.id}/reviews`)).json() as any).jobs.length, 2);
});

test('test admission rejects forged outcomes, foreign chunks, stale versions, roles and excess input without reserving', async t => {
  const f = await knowledgeReviewFixture(); t.after(f.close);
  const body = { jobId: crypto.randomUUID(), expectedVersion: 2, cases: f.cases };
  for (const changed of [{ ...body, passed: true }, { ...body, cases: [] }, { ...body, cases: [{ ...f.cases[0], question: '中'.repeat(801) }] },
    { ...body, cases: [{ ...f.cases[0], minimumScore: -1 }] }]) assert.equal((await f.request(`/${f.id}/tests`, changed)).status, 400);
  assert.equal((await f.request(`/${f.id}/tests`, { ...body, cases: [{ ...f.cases[0], expectedChunkId: 'a'.repeat(64) }] })).status, 409);
  assert.equal((await f.request(`/${f.id}/tests`, body, 'staff')).status, 403);
  assert.equal((await f.request(`/${f.id}/tests`, body, 'other', 'other')).status, 404);
  assert.equal((await f.request(`/${f.id}/tests`, { ...body, expectedVersion: 1 })).status, 409);
  f.env.KNOWLEDGE_DAILY_INPUT_BYTES = '1';
  assert.equal((await f.request(`/${f.id}/tests`, body)).status, 429);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM knowledge_review_job').get()?.n, 0);
  assert.equal(f.sqlite.prepare('SELECT version FROM knowledge_document WHERE id=?').get(f.id)?.version, 2);
});

test('failed retrieval keeps its evidence and cannot authorize publication', async t => {
  const f = await knowledgeReviewFixture(); t.after(f.close); f.score(.2);
  const jobId = crypto.randomUUID(); assert.equal((await f.request(`/${f.id}/tests`, { jobId, expectedVersion: 2, cases: f.cases })).status, 202);
  await (await runtime()).runKnowledgeReview(f.env, { organizationId: 'company', jobId }, immediateSteps);
  const result = await (await f.request(`/${f.id}/reviews/${jobId}`)).json() as any;
  assert.equal(result.job.state, 'failed'); assert.equal(result.job.results.passed, false); assert.equal(result.job.results.cases[0].matches[0].score, .2);
  assert.equal((await f.request(`/${f.id}/publish`, { jobId: crypto.randomUUID(), expectedVersion: 3 })).status, 409);
  assert.equal((await (await f.request(`/${f.id}`)).json() as any).draft.testedAt, null);
});

test('review dispatch reconciles a lost create acknowledgement and never restarts a completed instance', async t => {
  const f = await knowledgeReviewFixture(); t.after(f.close);
  const jobId = crypto.randomUUID(); assert.equal((await f.request(`/${f.id}/tests`, { jobId, expectedVersion: 2, cases: f.cases })).status, 202);
  const module = await import('../src/modules/knowledge/review-dispatch.ts').catch(() => null);
  assert.ok(module, 'the review outbox must be dispatched from the existing scheduled handler');
  let creates = 0, exists = false, status = 'running';
  f.env.KNOWLEDGE_REVIEW_WORKFLOW = { async create() { creates++; exists = true; throw new Error('synthetic lost acknowledgement'); },
    async get() { if (!exists) throw new Error('synthetic missing'); return { status: async () => ({ status }) }; } } as unknown as Workflow;
  await module.repairKnowledgeReviews(f.env);
  f.sqlite.exec('UPDATE knowledge_review_job SET wake_after=0'); await module.repairKnowledgeReviews(f.env); assert.equal(creates, 1);
  status = 'complete'; f.sqlite.exec('UPDATE knowledge_review_job SET wake_after=0'); await module.repairKnowledgeReviews(f.env);
  assert.equal(f.sqlite.prepare('SELECT state FROM knowledge_review_job WHERE id=?').get(jobId)?.state, 'failed'); assert.equal(creates, 1);
});

test('model ambiguity never retries automatically and committed embedding survives acknowledgement loss', async t => {
  const f = await knowledgeReviewFixture(); t.after(f.close); const r = await runtime();
  const jobId = crypto.randomUUID(); await f.request(`/${f.id}/tests`, { jobId, expectedVersion: 2, cases: f.cases });
  const scope = { organizationId: 'company', jobId };
  f.after(sql => { if (sql.includes("state='waiting',vectors_json=?")) { f.after(undefined); throw new Error('synthetic lost acknowledgement'); } });
  assert.equal(await r.embedReviewTest(f.env, scope), true); assert.equal(await r.embedReviewTest(f.env, scope), true);
  assert.equal(f.counts().modelCalls, 2); await r.evaluateReviewTest(f.env, scope);
  const nextId = crypto.randomUUID(); assert.equal((await f.request(`/${f.id}/tests`, { jobId: nextId, expectedVersion: 3, cases: f.cases })).status, 202);
  f.modelError(); const next = { organizationId: 'company', jobId: nextId };
  await r.runKnowledgeReview(f.env, next, immediateSteps); await r.runKnowledgeReview(f.env, next, immediateSteps);
  const job = f.sqlite.prepare('SELECT state,vectors_json FROM knowledge_review_job WHERE id=?').get(nextId)!;
  assert.equal(job.state, 'unknown'); assert.equal(job.vectors_json, null); assert.equal(f.counts().modelCalls, 3);
  assert.equal((await (await f.request(`/${f.id}`)).json() as any).draft.testedAt, null);
});

test('a late model result cannot authorize a removed and rejoined member or overwrite a new draft', async t => {
  for (const mutate of ['membership', 'draft'] as const) {
    const f = await knowledgeReviewFixture(); t.after(f.close);
    const jobId = crypto.randomUUID(); assert.equal((await f.request(`/${f.id}/tests`, { jobId, expectedVersion: 2, cases: f.cases })).status, 202);
    f.beforeModel(async () => {
      if (mutate === 'membership') { f.sqlite.exec("UPDATE member SET role='owner' WHERE id='admin'; DELETE FROM member WHERE id='owner'; INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('new-owner','company','owner','owner',1)"); }
      else assert.equal((await f.request(`/${f.id}/draft`, { expectedVersion: 3, title: 'Changed', source: { format: 'text', content: 'A newer draft.' } })).status, 200);
    });
    await (await runtime()).runKnowledgeReview(f.env, { organizationId: 'company', jobId }, immediateSteps);
    const job = f.sqlite.prepare('SELECT state,vectors_json FROM knowledge_review_job WHERE id=?').get(jobId)!;
    assert.equal(job.state, 'cancelled'); assert.equal(job.vectors_json, null);
    assert.equal((await (await f.request(`/${f.id}`)).json() as any).draft.testedAt, null);
  }
});

test('publication checks current authority after visibility without saving a revoked proof', async t => {
  const f = await knowledgeReviewFixture(); t.after(f.close); const r = await runtime();
  const testId = crypto.randomUUID(); await f.request(`/${f.id}/tests`, { jobId: testId, expectedVersion: 2, cases: f.cases });
  await r.runKnowledgeReview(f.env, { organizationId: 'company', jobId: testId }, immediateSteps);
  const jobId = crypto.randomUUID(); await f.request(`/${f.id}/publish`, { jobId, expectedVersion: 3 });
  const scope = { organizationId: 'company', jobId }; await r.copyReviewPublication(f.env, scope); f.visible();
  const query = f.env.KNOWLEDGE_INDEX.queryById.bind(f.env.KNOWLEDGE_INDEX);
  f.env.KNOWLEDGE_INDEX.queryById = async (...args) => { const result = await query(...args); f.sqlite.exec("UPDATE member SET role='owner' WHERE id='admin'; UPDATE member SET role='member' WHERE id='owner'"); return result; };
  await r.confirmReviewPublication(f.env, scope);
  assert.equal(f.sqlite.prepare('SELECT state FROM knowledge_review_job WHERE id=?').get(jobId)?.state, 'cancelled');
  assert.equal(f.sqlite.prepare('SELECT active_revision FROM knowledge_document WHERE id=?').get(f.id)?.active_revision, null);
  assert.equal(f.sqlite.prepare('SELECT published_at FROM knowledge_revision WHERE document_id=?').get(f.id)?.published_at, null);
});

test('admission rollback and lost acknowledgement preserve one frozen test and one input reservation', async t => {
  const f = await knowledgeReviewFixture(); t.after(f.close); const jobId = crypto.randomUUID(), body = { jobId, expectedVersion: 2, cases: f.cases };
  const initial = Number(f.sqlite.prepare('SELECT reserved_bytes FROM knowledge_index_usage').get()?.reserved_bytes);
  f.before(sql => { if (sql.startsWith('INSERT INTO knowledge_review_job')) throw new Error('synthetic insertion failure'); });
  assert.equal((await f.request(`/${f.id}/tests`, body)).status, 503); f.before(undefined);
  assert.equal(f.sqlite.prepare('SELECT version FROM knowledge_document WHERE id=?').get(f.id)?.version, 2);
  assert.equal(f.sqlite.prepare('SELECT reserved_bytes FROM knowledge_index_usage').get()?.reserved_bytes, initial);
  const batch = f.db.batch.bind(f.db); let lose = true;
  f.db.batch = async <T>(statements: D1PreparedStatement[]) => { const result = await batch<T>(statements); if (lose) { lose = false; throw new Error('synthetic lost commit acknowledgement'); } return result; };
  assert.equal((await f.request(`/${f.id}/tests`, body)).status, 503);
  assert.equal((await f.request(`/${f.id}/tests`, body)).status, 202);
  assert.equal((await f.request(`/${f.id}/tests`, { ...body, cases: [{ ...f.cases[0], minimumScore: .8 }] })).status, 409);
  assert.equal((await f.request(`/${f.id}/reviews/${jobId}`, undefined, 'other', 'other')).status, 404);
  assert.equal(f.sqlite.prepare('SELECT reserved_bytes FROM knowledge_index_usage').get()?.reserved_bytes, initial + new TextEncoder().encode(f.cases[0].question).length);
  f.sqlite.prepare('DELETE FROM knowledge_document WHERE id=?').run(f.id);
  assert.equal(f.sqlite.prepare('SELECT reserved_bytes FROM knowledge_index_usage').get()?.reserved_bytes, initial + new TextEncoder().encode(f.cases[0].question).length);
});

test('publication reserves room for both admission and final version increments', async t => {
  const f = await knowledgeReviewFixture(); t.after(f.close); const testId = crypto.randomUUID();
  await f.request(`/${f.id}/tests`, { jobId: testId, expectedVersion: 2, cases: f.cases });
  await (await runtime()).runKnowledgeReview(f.env, { organizationId: 'company', jobId: testId }, immediateSteps);
  const version = Number.MAX_SAFE_INTEGER - 1;
  f.sqlite.prepare('UPDATE knowledge_document SET version=? WHERE id=?').run(version, f.id);
  f.sqlite.prepare('UPDATE knowledge_review_job SET document_version=? WHERE id=?').run(version, testId);
  assert.equal((await f.request(`/${f.id}/publish`, { jobId: crypto.randomUUID(), expectedVersion: version })).status, 409);
  assert.equal(f.sqlite.prepare('SELECT version FROM knowledge_document WHERE id=?').get(f.id)?.version, version);
});

test('a failed replacement publication retains the previous active revision and bounded polling', async t => {
  const f = await knowledgeReviewFixture(); t.after(f.close); const r = await runtime();
  const testId = crypto.randomUUID(); await f.request(`/${f.id}/tests`, { jobId: testId, expectedVersion: 2, cases: f.cases });
  await r.runKnowledgeReview(f.env, { organizationId: 'company', jobId: testId }, immediateSteps);
  const firstId = crypto.randomUUID(); await f.request(`/${f.id}/publish`, { jobId: firstId, expectedVersion: 3 }); f.visible();
  await r.runKnowledgeReview(f.env, { organizationId: 'company', jobId: firstId }, immediateSteps);
  assert.equal((await f.request(`/${f.id}/draft`, { expectedVersion: 5, title: 'Second', source: { format: 'text', content: 'The new model is 28 cm wide.' } })).status, 200);
  const indexId = crypto.randomUUID(); await f.request(`/${f.id}/index`, { jobId: indexId, expectedVersion: 6 });
  await runKnowledgeIndex(f.env, { organizationId: 'company', jobId: indexId }, immediateSteps);
  const chunk = f.sqlite.prepare('SELECT id FROM knowledge_chunk WHERE document_id=? AND revision=2').get(f.id)!.id;
  const nextTest = crypto.randomUUID(); await f.request(`/${f.id}/tests`, { jobId: nextTest, expectedVersion: 7, cases: [{ ...f.cases[0], expectedChunkId: chunk }] });
  await r.runKnowledgeReview(f.env, { organizationId: 'company', jobId: nextTest }, immediateSteps);
  const nextPublication = crypto.randomUUID(); await f.request(`/${f.id}/publish`, { jobId: nextPublication, expectedVersion: 8 });
  f.env.KNOWLEDGE_INDEX.queryById = async () => ({ matches: [], count: 0 });
  let sleeps = 0; const steps = { do: immediateSteps.do, sleep: async () => { sleeps++; } } as unknown as typeof immediateSteps;
  await r.runKnowledgeReview(f.env, { organizationId: 'company', jobId: nextPublication }, steps);
  assert.equal(sleeps, 29);
  assert.equal(f.sqlite.prepare('SELECT state FROM knowledge_review_job WHERE id=?').get(nextPublication)?.state, 'failed');
  const latest = await (await f.request(`/${f.id}`)).json() as any;
  assert.equal(latest.document.activeRevision, 1); assert.equal(latest.active.source.content, 'The blue model is 26 cm wide.');
  assert.equal(latest.draft.publicationReady, false);
});

test('foreign retrieval metadata cannot pass and lost copy acknowledgements reuse published IDs', async t => {
  const f = await knowledgeReviewFixture(); t.after(f.close); const r = await runtime();
  const original = f.env.KNOWLEDGE_INDEX.query.bind(f.env.KNOWLEDGE_INDEX);
  f.env.KNOWLEDGE_INDEX.query = async (...args) => { const result = await original(...args); return { ...result, matches: result.matches.map(row => ({ ...row, namespace: 'foreign' })) }; };
  const first = crypto.randomUUID(); await f.request(`/${f.id}/tests`, { jobId: first, expectedVersion: 2, cases: f.cases });
  await r.runKnowledgeReview(f.env, { organizationId: 'company', jobId: first }, immediateSteps);
  assert.equal(f.sqlite.prepare('SELECT state FROM knowledge_review_job WHERE id=?').get(first)?.state, 'failed');
  assert.equal((await (await f.request(`/${f.id}`)).json() as any).draft.testedAt, null);
  f.env.KNOWLEDGE_INDEX.query = original;
  const next = crypto.randomUUID(); await f.request(`/${f.id}/tests`, { jobId: next, expectedVersion: 3, cases: f.cases });
  await r.runKnowledgeReview(f.env, { organizationId: 'company', jobId: next }, immediateSteps);
  const publication = crypto.randomUUID(); await f.request(`/${f.id}/publish`, { jobId: publication, expectedVersion: 4 });
  const upsert = f.env.KNOWLEDGE_INDEX.upsert.bind(f.env.KNOWLEDGE_INDEX); let lose = true;
  f.env.KNOWLEDGE_INDEX.upsert = async rows => { const result = await upsert(rows); if (lose) { lose = false; throw new Error('synthetic lost copy receipt'); } return result; };
  const scope = { organizationId: 'company', jobId: publication };
  await assert.rejects(r.copyReviewPublication(f.env, scope)); assert.equal(await r.copyReviewPublication(f.env, scope), true);
  f.visible(); assert.equal(await r.confirmReviewPublication(f.env, scope), 'done');
  assert.equal(f.rows.size, 2); assert.equal(f.counts().modelCalls, 3, 'publication retries do not re-embed');
});

test('an explicit retry after publication failure reuses the passing test without another model call', async t => {
  const f = await knowledgeReviewFixture(); t.after(f.close); const r = await runtime(), testId = crypto.randomUUID();
  await f.request(`/${f.id}/tests`, { jobId: testId, expectedVersion: 2, cases: f.cases });
  await r.runKnowledgeReview(f.env, { organizationId: 'company', jobId: testId }, immediateSteps);
  const first = crypto.randomUUID(); await f.request(`/${f.id}/publish`, { jobId: first, expectedVersion: 3 });
  const upsert = f.env.KNOWLEDGE_INDEX.upsert;
  f.env.KNOWLEDGE_INDEX.upsert = async () => { throw new Error('synthetic unavailable copy'); };
  await r.runKnowledgeReview(f.env, { organizationId: 'company', jobId: first }, immediateSteps);
  assert.equal(f.sqlite.prepare('SELECT state FROM knowledge_review_job WHERE id=?').get(first)?.state, 'failed');
  f.env.KNOWLEDGE_INDEX.upsert = upsert;
  const retryId = crypto.randomUUID(); assert.equal((await f.request(`/${f.id}/publish`, { jobId: retryId, expectedVersion: 4 })).status, 202);
  f.visible(); await r.runKnowledgeReview(f.env, { organizationId: 'company', jobId: retryId }, immediateSteps);
  assert.equal((await (await f.request(`/${f.id}`)).json() as any).document.activeRevision, 1);
  assert.equal(f.counts().modelCalls, 2);
});
