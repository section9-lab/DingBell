import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { prepareKnowledge } from '../../src/modules/knowledge/content.ts';
import { writeKnowledge } from '../../src/modules/knowledge/storage.ts';
import { admitIndexJob } from '../../src/modules/knowledge/index-storage.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function modules() {
  const entries: { type: 'ESModule'; path: string; contents: string }[] = [], visited = new Set<string>();
  async function add(path: string) {
    if (visited.has(path)) return; visited.add(path);
    let contents = stripTypeScriptTypes(await readFile(path, 'utf8'), { mode: 'transform' });
    if (/from ['"]valibot['"]/.test(contents)) {
      const dependency = fileURLToPath(import.meta.resolve('valibot'));
      contents = contents.replace(/from ['"]valibot['"]/g, `from ${JSON.stringify('./' + relative(dirname(path), dependency))}`); await add(dependency);
    }
    entries.push({ type: 'ESModule', path, contents });
    for (const match of contents.matchAll(/\bfrom\s*['"](\.[^'"]+)['"]/g)) await add(resolve(dirname(path), match[1]!));
  }
  await add(join(root, 'tests/fixtures/knowledge-index-worker.ts')); return entries;
}
export async function nativeKnowledgeIndexFixture() {
  const path = await mkdtemp(join(tmpdir(), 'dingbell-knowledge-index-'));
  const options = { modules: await modules(), modulesRoot: root, compatibilityDate: '2026-06-01',
    bindings: { KNOWLEDGE_INDEXING_ENABLED: 'true', KNOWLEDGE_DAILY_INPUT_BYTES: '100000' },
    d1Databases: { DB: 'synthetic-knowledge-index' }, d1Persist: join(path, 'd1'),
    workflows: { KNOWLEDGE_WORKFLOW: { name: 'synthetic-knowledge-index', className: 'TestKnowledgeIndexWorkflow' },
      KNOWLEDGE_REVIEW_WORKFLOW: { name: 'synthetic-knowledge-review', className: 'TestKnowledgeReviewWorkflow' } }, workflowsPersist: join(path, 'workflows'),
    outboundService: async () => { throw new Error('Unexpected network request in native knowledge fixture'); },
  };
  let mf = new Miniflare(options), db: D1Database;
  const close = async () => { await mf.dispose(); await rm(path, { recursive: true, force: true }); };
  try {
    db = await mf.getD1Database('DB') as unknown as D1Database;
    for (const name of (await readdir(join(root, 'migrations'))).filter(name => name.endsWith('.sql')).sort())
      await db.batch((await readFile(join(root, 'migrations', name), 'utf8')).split('--> statement-breakpoint').map(sql => sql.trim()).filter(Boolean).map(sql => db.prepare(sql)));
    await db.batch([
      db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('company','Company','company',1)"),
      db.prepare("INSERT INTO user(id,name,email,email_verified) VALUES('owner','Owner','native-index@example.invalid',1)"),
      db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('owner-member','company','owner','owner',1)"),
      db.prepare("INSERT INTO session(id,token,user_id,expires_at,updated_at) VALUES('login','synthetic-native-index-token','owner',?,1)").bind(Date.now() + 3_600_000),
      db.prepare('CREATE TABLE test_index_call(id INTEGER PRIMARY KEY,kind TEXT NOT NULL)'),
      db.prepare('CREATE TABLE test_index_gate(visible INTEGER NOT NULL,mode TEXT NOT NULL)'),
      db.prepare("INSERT INTO test_index_gate VALUES(0,'normal')"),
      db.prepare('CREATE TABLE test_index_vector(id TEXT PRIMARY KEY,value TEXT NOT NULL)'),
    ]);
    const documentId = crypto.randomUUID(), jobId = crypto.randomUUID(), actor = { orgId: 'company', actorUserId: 'owner', sessionId: 'login' };
    const scope = { kind: 'policy' as const, storeId: null, productRef: null, language: 'en' as const };
    const draft = await prepareKnowledge('company', documentId, 1, scope, { title: 'Synthetic policy', source: { format: 'text', content: 'Use the instructions supplied with your product.' } });
    await writeKnowledge(db, actor, documentId, scope, draft, 0, 'synthetic-create');
    if (!await admitIndexJob(db, actor, documentId, jobId, 1, 100000)) throw new Error('Synthetic index admission failed');
    return { documentId, jobId, get db() { return db; }, close,
      retrieve: () => mf.dispatchFetch('https://fixture.invalid/__fixture/retrieve'),
      dispatch: () => mf.dispatchFetch('https://fixture.invalid/__fixture/repair'),
      dispatchReviews: () => mf.dispatchFetch('https://fixture.invalid/__fixture/reviews/repair'),
      wakeReview: (id: string) => mf.dispatchFetch(`https://fixture.invalid/__fixture/reviews/wake?organizationId=company&jobId=${id}`),
      reviewStatus: async (id: string) => (await mf.dispatchFetch(`https://fixture.invalid/__fixture/reviews/status?organizationId=company&jobId=${id}`)).json() as Promise<{ status: string }>,
      wake: () => mf.dispatchFetch(`https://fixture.invalid/__fixture/wake?organizationId=company&jobId=${jobId}`),
      status: async () => (await mf.dispatchFetch(`https://fixture.invalid/__fixture/status?organizationId=company&jobId=${jobId}`)).json() as Promise<{ status: string }>,
      restart: async () => { await mf.dispose(); mf = new Miniflare(options); db = await mf.getD1Database('DB') as unknown as D1Database; },
    };
  } catch (error) { await close().catch(() => {}); throw error; }
}
