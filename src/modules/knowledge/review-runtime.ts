import type { WorkflowStep } from 'cloudflare:workers';
import * as v from 'valibot';
import { knowledgeTestCasesSchema } from '../../shared/knowledge.ts';
import { knowledgeIndexConfig, type IndexScope } from './bindings.ts';
import { manifestFor, type IndexEnvironment } from './index-runtime.ts';
import { currentReviewGuard, currentReviewJob, finishReviewJob, readReviewJob, reviewAudit, reviewScopeValues } from './review-storage.ts';
import { copyKnowledgeToPublished, embedKnowledge, isKnowledgeVisible, queryKnowledgeDraft } from './vectorize.ts';

export async function usableReviewJob(env: IndexEnvironment, scope: IndexScope) {
  const job = await readReviewJob(env.DB, scope);
  if (!job || !['queued', 'running', 'waiting'].includes(job.state)) return null;
  if (!await currentReviewJob(env.DB, scope)) {
    await finishReviewJob(env.DB, scope, job.deadline_at <= Date.now() ? (job.kind === 'test' && job.state === 'running' ? 'unknown' : 'failed') : 'cancelled',
      job.deadline_at <= Date.now() ? 'REVIEW_DEADLINE' : 'STALE_OR_REVOKED'); return null;
  }
  if (!knowledgeIndexConfig(env) || !env.KNOWLEDGE_REVIEW_WORKFLOW) { await finishReviewJob(env.DB, scope, 'cancelled', 'INDEXING_DISABLED'); return null; }
  return job;
}
export async function embedReviewTest(env: IndexEnvironment, scope: IndexScope) {
  const job = await usableReviewJob(env, scope); if (!job) return false;
  if (job.kind !== 'test') throw new Error('KNOWLEDGE_REVIEW_KIND');
  if (job.vectors_json && job.state === 'waiting') return true;
  if (job.attempted_at !== null) { await finishReviewJob(env.DB, scope, 'unknown', 'EMBEDDING_UNCONFIRMED'); return false; }
  const cases = v.parse(knowledgeTestCasesSchema, JSON.parse(job.cases_json!));
  await manifestFor(env.DB, { organization_id: job.organization_id, document_id: job.document_id, revision: job.revision, content_hash: job.content_hash });
  const claimed = await env.DB.prepare(`UPDATE knowledge_review_job AS job SET state='running',attempted_at=unixepoch()*1000,updated_at=unixepoch()*1000
    WHERE job.organization_id=? AND job.id=? AND job.attempted_at IS NULL AND ${currentReviewGuard} RETURNING id`).bind(...reviewScopeValues(scope)).first();
  if (!claimed) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const vectors = await Promise.race([embedKnowledge(env.KNOWLEDGE_AI!, cases.map(value => value.question)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('EMBEDDING_TIMEOUT')), 45_000);
    })]);
    const saved = await env.DB.prepare(`UPDATE knowledge_review_job AS job SET state='waiting',vectors_json=?,updated_at=unixepoch()*1000
      WHERE job.organization_id=? AND job.id=? AND job.state='running' AND ${currentReviewGuard} RETURNING id`).bind(JSON.stringify(vectors), ...reviewScopeValues(scope)).first();
    if (!saved) await finishReviewJob(env.DB, scope, 'cancelled', 'STALE_OR_REVOKED');
    return !!saved;
  } catch {
    if ((await usableReviewJob(env, scope))?.vectors_json) return true;
    await finishReviewJob(env.DB, scope, 'unknown', 'EMBEDDING_UNCONFIRMED'); return false;
  } finally { clearTimeout(timer); }
}
export async function evaluateReviewTest(env: IndexEnvironment, scope: IndexScope) {
  const job = await usableReviewJob(env, scope); if (!job) return;
  if (job.kind !== 'test' || job.state !== 'waiting' || !job.vectors_json) throw new Error('KNOWLEDGE_TEST_NOT_EMBEDDED');
  const cases = v.parse(knowledgeTestCasesSchema, JSON.parse(job.cases_json!)), vectors: number[][] = JSON.parse(job.vectors_json);
  if (vectors.length !== cases.length) throw new Error('KNOWLEDGE_EMBEDDING_INVALID');
  const manifest = await manifestFor(env.DB, { organization_id: job.organization_id, document_id: job.document_id, revision: job.revision, content_hash: job.content_hash });
  const results = [];
  for (let i = 0; i < cases.length; i++) {
    if (!await usableReviewJob(env, scope)) return;
    const matches = await queryKnowledgeDraft(env.KNOWLEDGE_INDEX!, manifest, vectors[i]);
    results.push({ passed: matches.some(value => value.chunkId === cases[i].expectedChunkId && value.score >= cases[i].minimumScore), matches });
  }
  const passed = results.every(value => value.passed), state = passed ? 'succeeded' : 'failed';
  await env.DB.batch([
    env.DB.prepare(`UPDATE knowledge_review_job AS job SET state=?,results_json=?,vectors_json=NULL,error_code=?,completed_at=unixepoch()*1000,updated_at=unixepoch()*1000
      WHERE job.organization_id=? AND job.id=? AND ${currentReviewGuard} RETURNING id`)
      .bind(state, JSON.stringify({ passed, cases: results }), passed ? null : 'RETRIEVAL_TEST_FAILED', ...reviewScopeValues(scope)),
    env.DB.prepare(`UPDATE knowledge_revision SET tested_at=(SELECT CASE WHEN state='succeeded' THEN completed_at ELSE NULL END FROM knowledge_review_job WHERE organization_id=? AND id=?)
      WHERE organization_id=? AND document_id=? AND revision=? AND EXISTS (SELECT 1 FROM knowledge_review_job job JOIN knowledge_document doc ON doc.organization_id=job.organization_id AND doc.id=job.document_id
        WHERE job.organization_id=knowledge_revision.organization_id AND job.id=? AND job.state IN ('succeeded','failed') AND job.results_json IS NOT NULL
          AND doc.version=job.document_version AND doc.mutation_id=job.id AND doc.draft_revision=job.revision)`)
      .bind(...reviewScopeValues(scope), job.organization_id, job.document_id, job.revision, job.id), reviewAudit(env.DB, scope),
  ]);
  await usableReviewJob(env, scope);
}
export async function copyReviewPublication(env: IndexEnvironment, scope: IndexScope) {
  const job = await usableReviewJob(env, scope); if (!job) return false;
  if (job.kind !== 'publish') throw new Error('KNOWLEDGE_REVIEW_KIND');
  if (job.mutation_id) return true;
  const manifest = await manifestFor(env.DB, { organization_id: job.organization_id, document_id: job.document_id, revision: job.revision, content_hash: job.content_hash });
  if (!await usableReviewJob(env, scope)) return false;
  const receipt = await copyKnowledgeToPublished(env.KNOWLEDGE_INDEX!, manifest);
  const saved = await env.DB.prepare(`UPDATE knowledge_review_job AS job SET state='waiting',mutation_id=?,updated_at=unixepoch()*1000
    WHERE job.organization_id=? AND job.id=? AND ${currentReviewGuard} RETURNING id`).bind(receipt, ...reviewScopeValues(scope)).first();
  if (!saved) await finishReviewJob(env.DB, scope, 'cancelled', 'STALE_OR_REVOKED');
  return !!saved;
}
export async function confirmReviewPublication(env: IndexEnvironment, scope: IndexScope): Promise<'waiting' | 'done'> {
  const job = await usableReviewJob(env, scope); if (!job) return 'done';
  if (job.kind !== 'publish' || !job.mutation_id) throw new Error('KNOWLEDGE_RECEIPT_MISSING');
  const manifest = await manifestFor(env.DB, { organization_id: job.organization_id, document_id: job.document_id, revision: job.revision, content_hash: job.content_hash });
  if (!await isKnowledgeVisible(env.KNOWLEDGE_INDEX!, manifest, true).catch(() => false)) return 'waiting';
  const committed = `EXISTS (SELECT 1 FROM knowledge_review_job job JOIN knowledge_document doc ON doc.organization_id=job.organization_id AND doc.id=job.document_id
    WHERE job.organization_id=? AND job.id=? AND job.state='succeeded' AND doc.version=job.document_version AND doc.mutation_id=job.id AND doc.draft_revision=job.revision)`;
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE knowledge_review_job AS job SET state='succeeded',completed_at=unixepoch()*1000,updated_at=unixepoch()*1000
      WHERE job.organization_id=? AND job.id=? AND ${currentReviewGuard} RETURNING id`).bind(...reviewScopeValues(scope)),
    env.DB.prepare(`UPDATE knowledge_revision SET published_profile=?,published_mutation_id=?,published_at=unixepoch()*1000
      WHERE organization_id=? AND document_id=? AND revision=? AND ${committed}`)
      .bind(job.profile, job.mutation_id, job.organization_id, job.document_id, job.revision, ...reviewScopeValues(scope)),
    env.DB.prepare(`UPDATE knowledge_document SET active_revision=draft_revision,version=version+1,updated_at=unixepoch()*1000
      WHERE organization_id=? AND id=? AND version=? AND version<9007199254740991 AND mutation_id=? AND ${committed}`)
      .bind(job.organization_id, job.document_id, job.document_version, job.id, ...reviewScopeValues(scope)), reviewAudit(env.DB, scope),
  ]);
  if (!results[0].results.length) await usableReviewJob(env, scope);
  return 'done';
}
export async function runKnowledgeReview(env: IndexEnvironment, scope: IndexScope, step: WorkflowStep) {
  const job = await usableReviewJob(env, scope); if (!job) return;
  const retry = { retries: { limit: 3, delay: '2 seconds' as const, backoff: 'exponential' as const }, timeout: '30 seconds' as const };
  try {
    if (job.kind === 'test') {
      if (!await step.do('embed saved questions', { retries: { limit: 0, delay: '1 second' }, timeout: '1 minute' }, () => embedReviewTest(env, scope))) return;
      await step.do('evaluate saved questions', retry, () => evaluateReviewTest(env, scope)); return;
    }
    if (!await step.do('copy published vectors', retry, () => copyReviewPublication(env, scope))) return;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (attempt) await step.sleep(`wait for publication ${attempt}`, '10 seconds');
      if (await step.do(`confirm publication ${attempt}`, retry, () => confirmReviewPublication(env, scope)) === 'done') return;
    }
    await step.do('record publication timeout', retry, () => finishReviewJob(env.DB, scope, 'failed', 'PUBLISHED_INDEX_NOT_VISIBLE'));
  } catch {
    await step.do('record interrupted review', retry, async () => {
      const current = await usableReviewJob(env, scope); if (!current) return;
      await finishReviewJob(env.DB, scope, current.kind === 'test' && current.state === 'running' ? 'unknown' : 'failed', 'REVIEW_INTERRUPTED');
    });
  }
}
