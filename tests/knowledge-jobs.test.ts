import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { knowledgeFixture } from './fixtures/knowledge.ts';

const document = () => ({ id: crypto.randomUUID(), title: 'Delivery policy', kind: 'policy', storeId: null, productRef: null,
  language: 'en', source: { format: 'text', content: 'Delivery time depends on the confirmed order.' } });
async function fixture(t: TestContext) {
  const f = await knowledgeFixture(); t.after(f.close);
  const value = document(), created = await f.request('', value); assert.equal(created.status, 200);
  let starts = 0;
  Object.assign(f.env, { KNOWLEDGE_INDEXING_ENABLED: 'true', KNOWLEDGE_DAILY_INPUT_BYTES: '100000', KNOWLEDGE_AI: {}, KNOWLEDGE_INDEX: {},
    KNOWLEDGE_WORKFLOW: { async create() { starts++; return { id: 'synthetic' }; }, async get() { throw new Error('synthetic missing instance'); } } });
  return { ...f, id: value.id, starts: () => starts };
}

test('index admission is durable, scoped and idempotent; indexing does not publish', async t => {
  const f = await fixture(t), jobId = crypto.randomUUID(), body = { jobId, expectedVersion: 1 };
  const response = await f.request(`/${f.id}/index`, body);
  assert.equal(response.status, 202, await response.clone().text());
  const result = await response.json() as any;
  assert.equal(result.job.id, jobId); assert.equal(result.job.state, 'queued'); assert.equal(result.job.documentVersion, 2);
  assert.equal((await f.request(`/${f.id}/index`, body)).status, 202);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM knowledge_index_job').get()?.n, 1);
  assert.equal(f.sqlite.prepare('SELECT jobs FROM knowledge_index_usage').get()?.jobs, 1);
  assert.equal((await f.request(`/${f.id}/index`, { ...body, expectedVersion: 2 })).status, 409);
  assert.equal((await f.request(`/${f.id}/index`, { ...body, jobId: crypto.randomUUID() })).status, 409);
  assert.equal((await f.request(`/${f.id}/index-jobs/${jobId}`, undefined, 'other', 'other')).status, 404);
  assert.equal((await f.request(`/${f.id}/index`, body, 'staff')).status, 403);
  assert.equal((await f.request(`/${f.id}/publish`, { expectedVersion: 2 })).status, 409);
  assert.equal(f.sqlite.prepare('SELECT active_revision FROM knowledge_document WHERE id=?').get(f.id)?.active_revision, null);
  const job = await (await f.request(`/${f.id}/index-jobs/${jobId}`)).json() as any;
  assert.equal('vectors_json' in job.job, false); assert.equal('source' in job.job, false);
});

test('job IDs cannot be reused for another document and an unsuccessful batch consumes no allowance', async t => {
  const f = await fixture(t), jobId = crypto.randomUUID();
  assert.equal((await f.request(`/${f.id}/index`, { jobId, expectedVersion: 1 })).status, 202);
  const other = document(); assert.equal((await f.request('', other)).status, 200);
  assert.equal((await f.request(`/${other.id}/index`, { jobId, expectedVersion: 1 })).status, 409);
  const newJob = crypto.randomUUID();
  f.before(sql => { if (sql.startsWith('INSERT INTO knowledge_index_job')) throw new Error('synthetic failed insert'); });
  assert.equal((await f.request(`/${other.id}/index`, { jobId: newJob, expectedVersion: 1 })).status, 503);
  f.before(undefined);
  assert.equal(f.sqlite.prepare('SELECT version FROM knowledge_document WHERE id=?').get(other.id)?.version, 1);
  assert.equal(f.sqlite.prepare('SELECT jobs FROM knowledge_index_usage').get()?.jobs, 1);
});

test('indexing requires explicit configuration and reserves a deployment input allowance atomically', async t => {
  const f = await fixture(t), body = { jobId: crypto.randomUUID(), expectedVersion: 1 };
  Object.assign(f.env, { KNOWLEDGE_INDEXING_ENABLED: 'false' });
  assert.equal((await f.request(`/${f.id}/index`, body)).status, 503);
  Object.assign(f.env, { KNOWLEDGE_INDEXING_ENABLED: 'true', KNOWLEDGE_DAILY_INPUT_BYTES: '1' });
  assert.equal((await f.request(`/${f.id}/index`, body)).status, 429);
  assert.equal(f.sqlite.prepare('SELECT version FROM knowledge_document WHERE id=?').get(f.id)?.version, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM knowledge_index_job').get()?.n, 0);
  assert.equal(f.starts(), 0);
});

test('deployment allowance is shared across companies and survives source deletion', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(`/${f.id}/index`, { jobId: crypto.randomUUID(), expectedVersion: 1 })).status, 202);
  const bytes = Number(f.sqlite.prepare('SELECT reserved_bytes FROM knowledge_index_usage').get()?.reserved_bytes);
  Object.assign(f.env, { KNOWLEDGE_DAILY_INPUT_BYTES: String(bytes) });
  f.sqlite.prepare('DELETE FROM knowledge_document WHERE id=?').run(f.id);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM knowledge_index_job').get()?.n, 0);
  const other = document(); assert.equal((await f.request('', other, 'other', 'other')).status, 200);
  assert.equal((await f.request(`/${other.id}/index`, { jobId: crypto.randomUUID(), expectedVersion: 1 }, 'other', 'other')).status, 429);
  assert.equal(f.sqlite.prepare('SELECT reserved_bytes FROM knowledge_index_usage').get()?.reserved_bytes, bytes);
});

test('a committed admission with a lost acknowledgement is read back without reserving twice', async t => {
  const f = await fixture(t), original = f.db.batch.bind(f.db), jobId = crypto.randomUUID(); let lose = true;
  f.db.batch = async <T>(statements: D1PreparedStatement[]) => { const result = await original<T>(statements); if (lose) { lose = false; throw new Error('synthetic lost batch acknowledgement'); } return result; };
  const body = { jobId, expectedVersion: 1 };
  assert.equal((await f.request(`/${f.id}/index`, body)).status, 503);
  assert.equal((await f.request(`/${f.id}/index`, body)).status, 202);
  assert.equal(f.sqlite.prepare('SELECT jobs FROM knowledge_index_usage').get()?.jobs, 1);
  assert.equal(f.sqlite.prepare('SELECT version FROM knowledge_document WHERE id=?').get(f.id)?.version, 2);
});
