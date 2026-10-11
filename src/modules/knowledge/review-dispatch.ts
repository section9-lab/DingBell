import type { IndexScope, KnowledgeBindings } from './bindings.ts';
import { knowledgeHash } from './content.ts';
import type { IndexEnvironment } from './index-runtime.ts';
import { usableReviewJob } from './review-runtime.ts';
import { activeReviewStates, finishReviewJob, reviewScopeValues } from './review-storage.ts';

async function dispatchReview(env: IndexEnvironment, scope: IndexScope) {
  await env.DB.prepare(`UPDATE knowledge_review_job SET wake_after=? WHERE organization_id=? AND id=? AND state IN ${activeReviewStates}`)
    .bind(Date.now() + 60_000, ...reviewScopeValues(scope)).run();
  const job = await usableReviewJob(env, scope); if (!job) return;
  const id = `knowledge-review-${await knowledgeHash([scope.organizationId, scope.jobId])}`;
  let status: string;
  try { status = (await (await env.KNOWLEDGE_REVIEW_WORKFLOW!.get(id)).status()).status; }
  catch { await env.KNOWLEDGE_REVIEW_WORKFLOW!.create({ id, params: scope }); return; }
  if (['complete', 'errored', 'terminated'].includes(status))
    await finishReviewJob(env.DB, scope, job.kind === 'test' && job.state === 'running' ? 'unknown' : 'failed', 'REVIEW_WORKFLOW_STOPPED');
}
export async function repairKnowledgeReviews(env: KnowledgeBindings & { DB?: D1Database }) {
  if (!env.DB) return;
  const due = await env.DB.prepare(`SELECT organization_id AS organizationId,id AS jobId FROM knowledge_review_job
    WHERE state IN ${activeReviewStates} AND wake_after<=? ORDER BY wake_after,created_at,id LIMIT 50`).bind(Date.now()).all<IndexScope>();
  for (let i = 0; i < due.results.length; i += 5) await Promise.allSettled(due.results.slice(i, i + 5).map(async scope => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([dispatchReview(env as IndexEnvironment, scope), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('REVIEW_DISPATCH_TIMEOUT')), 3_000);
    })]); } finally { clearTimeout(timer); }
  }));
}
