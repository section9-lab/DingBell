import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { KnowledgeIndexWorkflow } from '../../src/modules/knowledge/index-workflow.ts';
import { KnowledgeReviewWorkflow } from '../../src/modules/knowledge/review-workflow.ts';
import type { IndexEnvironment } from '../../src/modules/knowledge/index-runtime.ts';
import { repairKnowledgeIndexes } from '../../src/modules/knowledge/index-dispatch.ts';
import { repairKnowledgeReviews } from '../../src/modules/knowledge/review-dispatch.ts';
import type { IndexScope } from '../../src/modules/knowledge/bindings.ts';
import { knowledgeHash } from '../../src/modules/knowledge/content.ts';
import { retrieveKnowledge } from '../../src/modules/knowledge/storage.ts';

export function environment(env: IndexEnvironment): IndexEnvironment {
  const db = env.DB;
  return { ...env,
    KNOWLEDGE_AI: { async run(_model: string, input: { text: string[] }) {
      await db.prepare("INSERT INTO test_index_call(kind) VALUES('embedding')").run();
      if ((await db.prepare('SELECT mode FROM test_index_gate').first<{ mode: string }>())?.mode === 'model-error') throw new Error('synthetic model error');
      return { shape: [input.text.length, 1024], data: input.text.map(() => Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0)) };
    } } as unknown as Ai,
    KNOWLEDGE_INDEX: { async upsert(rows: VectorizeVector[]) {
      await db.prepare("INSERT INTO test_index_call(kind) VALUES('upsert')").run();
      await db.batch(rows.map(row => db.prepare('INSERT INTO test_index_vector(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').bind(row.id, JSON.stringify(row))));
      return { mutationId: 'synthetic-native-receipt' };
    }, async queryById(_id: string, options: { filter: Record<string, unknown> }) {
      await db.prepare("INSERT INTO test_index_call(kind) VALUES('visibility')").run();
      if (!(await db.prepare('SELECT visible FROM test_index_gate').first<{ visible: number }>())?.visible) return { matches: [] };
      const values = await db.prepare('SELECT value FROM test_index_vector').all<{ value: string }>();
      return { matches: values.results.map(row => JSON.parse(row.value) as VectorizeVector)
        .filter(row => Object.entries(options.filter).every(([key, value]) => row.metadata?.[key] === value)).map(row => ({ ...row, score: 1 })) };
    }, async getByIds(ids: string[]) {
      const rows = await db.prepare('SELECT value FROM test_index_vector WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all<{ value: string }>();
      return rows.results.map(row => JSON.parse(row.value));
    }, async query(_vector: number[], options: { namespace: string; topK: number; filter: Record<string, unknown> }) {
      await db.prepare("INSERT INTO test_index_call(kind) VALUES('query')").run();
      if ((await db.prepare('SELECT mode FROM test_index_gate').first<{ mode: string }>())?.mode === 'query-empty') return { matches: [] };
      const rows = await db.prepare('SELECT value FROM test_index_vector').all<{ value: string }>();
      return { matches: rows.results.map(row => JSON.parse(row.value) as VectorizeVector).filter(row => row.namespace === options.namespace
        && Object.entries(options.filter).every(([key, value]) => value && typeof value === 'object' && '$in' in value && Array.isArray(value.$in)
          ? value.$in.includes(row.metadata?.[key]) : row.metadata?.[key] === value)).slice(0, options.topK).map(row => ({ ...row, score: 1 })) };
    } } as unknown as Vectorize,
  };
}
export class TestKnowledgeIndexWorkflow extends KnowledgeIndexWorkflow {
  async run(event: WorkflowEvent<IndexScope>, step: WorkflowStep) {
    this.env = environment(this.env);
    return super.run(event, step);
  }
}
export class TestKnowledgeReviewWorkflow extends KnowledgeReviewWorkflow {
  async run(event: WorkflowEvent<IndexScope>, step: WorkflowStep) {
    this.env = environment(this.env);
    return super.run(event, step);
  }
}
export default { async fetch(request: Request, env: IndexEnvironment) {
  const url = new URL(request.url);
  if (url.pathname === '/__fixture/retrieve') {
    try { return Response.json(await retrieveKnowledge(env.DB, environment(env).KNOWLEDGE_INDEX!,
      { orgId: 'company', actorUserId: 'owner', sessionId: 'login' }, { storeId: 'store-a', productRef: null, language: 'en' },
      Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0))); }
    catch (error) { return Response.json({ error: (error as Error).message }, { status: 409 }); }
  }
  if (url.pathname === '/__fixture/reviews/repair') { await repairKnowledgeReviews(environment(env)); return Response.json({ ok: true }); }
  if (url.pathname === '/__fixture/reviews/wake' || url.pathname === '/__fixture/reviews/status') {
    const id = `knowledge-review-${await knowledgeHash([url.searchParams.get('organizationId'), url.searchParams.get('jobId')])}`;
    const instance = await env.KNOWLEDGE_REVIEW_WORKFLOW!.get(id);
    if (url.pathname.endsWith('/wake')) await instance.sendEvent({ type: 'synthetic-local-wake', payload: {} });
    return Response.json(await instance.status());
  }
  if (url.pathname === '/__fixture/repair') { await repairKnowledgeIndexes(environment(env)); return Response.json({ ok: true }); }
  if (url.pathname === '/__fixture/status') {
    const id = `knowledge-${await knowledgeHash([url.searchParams.get('organizationId'), url.searchParams.get('jobId')])}`;
    return Response.json(await (await env.KNOWLEDGE_WORKFLOW!.get(id)).status());
  }
  if (url.pathname === '/__fixture/wake') {
    const id = `knowledge-${await knowledgeHash([url.searchParams.get('organizationId'), url.searchParams.get('jobId')])}`;
    await (await env.KNOWLEDGE_WORKFLOW!.get(id)).sendEvent({ type: 'synthetic-local-wake', payload: {} });
    return Response.json({ ok: true });
  }
  return new Response('Not found', { status: 404 });
} };
