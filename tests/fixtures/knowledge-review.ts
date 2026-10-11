import assert from 'node:assert/strict';
import { knowledgeFixture } from './knowledge.ts';
import { runKnowledgeIndex } from '../../src/modules/knowledge/index-runtime.ts';
import type { WorkflowStep } from 'cloudflare:workers';

export const immediateSteps = { do: async (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback(), sleep: async () => {} } as unknown as WorkflowStep;
export async function knowledgeReviewFixture() {
  const f = await knowledgeFixture();
  let modelCalls = 0, copies = 0, publishedVisible = false, score = .9, modelError = false;
  let beforeModel: (() => void | Promise<void>) | undefined, beforeQuery: (() => void) | undefined;
  const rows = new Map<string, VectorizeVector>();
  const filtered = (options: any) => [...rows.values()].filter(row => row.namespace === options.namespace
    && Object.entries(options.filter).every(([key, value]) => row.metadata?.[key] === value));
  const env = Object.assign(f.env, { KNOWLEDGE_INDEXING_ENABLED: 'true', KNOWLEDGE_DAILY_INPUT_BYTES: '100000',
    KNOWLEDGE_WORKFLOW: {} as Workflow, KNOWLEDGE_REVIEW_WORKFLOW: {} as Workflow,
    KNOWLEDGE_AI: { async run(_model: string, input: { text: string[] }) { modelCalls++; await beforeModel?.(); if (modelError) throw new Error('private synthetic model failure');
      return { data: input.text.map(() => Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0)), shape: [input.text.length, 1024] }; } } as unknown as Ai,
    KNOWLEDGE_INDEX: {
      async upsert(values: VectorizeVector[]) { if (values[0]?.metadata?.eligible) copies++; for (const row of values) rows.set(row.id, structuredClone(row)); return { mutationId: crypto.randomUUID() }; },
      async getByIds(ids: string[]) { return ids.map(id => rows.get(id)).filter(Boolean); },
      async queryById(_id: string, options: any) { return { matches: options.filter.eligible && !publishedVisible ? [] : filtered(options).map(row => ({ ...row, score: 1 })) }; },
      async query(_vector: number[], options: any) { beforeQuery?.(); return { matches: filtered(options).slice(0, options.topK).map(row => ({ ...row, score })) }; },
    } as unknown as Vectorize,
  });
  const id = crypto.randomUUID(), indexJobId = crypto.randomUUID();
  const draft = { id, title: 'Synthetic guide', kind: 'guide', storeId: 'store-a', productRef: 'sku-a', language: 'en', source: { format: 'text', content: 'The blue model is 26 cm wide.' } };
  assert.equal((await f.request('', draft)).status, 200);
  assert.equal((await f.request(`/${id}/index`, { jobId: indexJobId, expectedVersion: 1 })).status, 202);
  await runKnowledgeIndex(env, { organizationId: 'company', jobId: indexJobId }, immediateSteps);
  const chunkId = f.sqlite.prepare('SELECT id FROM knowledge_chunk WHERE document_id=?').get(id)!.id as string;
  const cases = [{ question: 'How wide is the blue model?', expectedChunkId: chunkId, minimumScore: .7 }];
  return { ...f, env, id, cases, counts: () => ({ modelCalls, copies }), visible: () => { publishedVisible = true; }, score: (value: number) => { score = value; },
    modelError: () => { modelError = true; }, beforeModel: (fn: typeof beforeModel) => { beforeModel = fn; }, beforeQuery: (fn: typeof beforeQuery) => { beforeQuery = fn; }, rows };
}
