export type IndexScope = { organizationId: string; jobId: string };
export type KnowledgeBindings = {
  KNOWLEDGE_WORKFLOW?: Workflow<IndexScope>;
  KNOWLEDGE_REVIEW_WORKFLOW?: Workflow<IndexScope>;
  KNOWLEDGE_AI?: Ai;
  KNOWLEDGE_INDEX?: Vectorize;
  KNOWLEDGE_INDEXING_ENABLED?: string;
  KNOWLEDGE_VECTOR_CLEANUP_ENABLED?: string;
  KNOWLEDGE_DAILY_INPUT_BYTES?: string;
};
export function knowledgeIndexConfig(env: KnowledgeBindings) {
  const value = env.KNOWLEDGE_DAILY_INPUT_BYTES;
  if (env.KNOWLEDGE_INDEXING_ENABLED !== 'true' || !env.KNOWLEDGE_WORKFLOW || !env.KNOWLEDGE_AI || !env.KNOWLEDGE_INDEX
    || !value || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 1_000_000_000) return null;
  return { dailyInputBytes: Number(value) };
}
