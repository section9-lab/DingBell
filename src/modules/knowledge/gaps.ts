import type { KnowledgeGapFilters } from '../../shared/knowledge-gaps.ts';
import type { KnowledgeScope } from '../../shared/knowledge.ts';
import { knowledgeAccess, knowledgeActorValues, type KnowledgeActor } from './storage.ts';

type GapRow = { job_id: string; case_index: number; document_id: string; revision: number; title: string; question: string;
  minimum_score: number; observed_score: number | null; created_at: number; kind: KnowledgeScope['kind']; store_id: string | null; product_ref: string | null;
  language: KnowledgeScope['language']; state: 'pending' | 'retested' | 'published'; proof_job: string | null; proof_revision: number | null };
function proof(revision: 'active_revision' | 'draft_revision') {
  return `(SELECT test.id FROM knowledge_review_job test JOIN knowledge_revision rev
    ON rev.organization_id=test.organization_id AND rev.document_id=test.document_id AND rev.revision=test.revision
    JOIN json_each(test.cases_json) question JOIN json_each(test.results_json,'$.cases') result ON result.key=question.key
    WHERE test.organization_id=f.organization_id AND test.document_id=f.document_id AND test.revision=f.${revision} AND test.revision>=f.revision
      AND test.document_version>f.failed_document_version
      AND test.kind='test' AND test.state='succeeded' AND test.content_hash=rev.content_hash AND test.profile=rev.index_profile
      AND rev.status='ready' AND rev.tested_at=test.completed_at AND json_extract(test.results_json,'$.passed')=1
      AND json_extract(question.value,'$.question')=f.question AND json_extract(question.value,'$.minimumScore')>=f.minimum_score
      AND json_extract(result.value,'$.passed')=1
      AND EXISTS (SELECT 1 FROM json_each(result.value,'$.matches') match
        WHERE json_extract(match.value,'$.chunkId')=json_extract(question.value,'$.expectedChunkId') AND json_extract(match.value,'$.score')>=f.minimum_score)
      ${revision === 'active_revision' ? "AND rev.published_profile=test.profile AND rev.published_at>=test.completed_at AND length(rev.published_mutation_id)>0" : ''}
    ORDER BY test.id LIMIT 1)`;
}
export async function listKnowledgeGaps(db: D1Database, actor: KnowledgeActor, filters: KnowledgeGapFilters) {
  const rows = await db.prepare(`WITH failed_cases AS (
    SELECT job.organization_id,job.id AS job_id,CAST(question.key AS INTEGER) AS case_index,job.document_id,job.revision,job.document_version AS failed_document_version,source.title,
      json_extract(question.value,'$.question') AS question,json_extract(question.value,'$.minimumScore') AS minimum_score,
      (SELECT MAX(json_extract(match.value,'$.score')) FROM json_each(result.value,'$.matches') match
        WHERE json_extract(match.value,'$.chunkId')=json_extract(question.value,'$.expectedChunkId')) AS observed_score,
      job.completed_at AS created_at,doc.kind,doc.store_id,doc.product_ref,doc.language,doc.active_revision,doc.draft_revision
    FROM knowledge_review_job job JOIN knowledge_document doc ON doc.organization_id=job.organization_id AND doc.id=job.document_id
      JOIN knowledge_revision source ON source.organization_id=job.organization_id AND source.document_id=job.document_id AND source.revision=job.revision
      JOIN json_each(job.cases_json) question JOIN json_each(job.results_json,'$.cases') result ON result.key=question.key
    WHERE job.organization_id=? AND job.kind='test' AND job.state='failed' AND job.error_code='RETRIEVAL_TEST_FAILED'
      AND job.completed_at IS NOT NULL AND json_extract(result.value,'$.passed')=0 AND EXISTS (${knowledgeAccess})
      AND (? IS NULL OR doc.kind=?) AND (? IS NULL OR doc.language=?) AND (?=0 OR doc.store_id IS ?)
      AND job.id>=substr(?,1,36) AND (job.id||':'||question.key)>?
  ), evaluated AS (SELECT f.*,${proof('active_revision')} AS active_test,${proof('draft_revision')} AS draft_test FROM failed_cases f),
  progress AS (SELECT *,CASE WHEN active_test IS NOT NULL THEN 'published' WHEN draft_test IS NOT NULL THEN 'retested' ELSE 'pending' END AS state,
    COALESCE(active_test,draft_test) AS proof_job,CASE WHEN active_test IS NOT NULL THEN active_revision WHEN draft_test IS NOT NULL THEN draft_revision ELSE NULL END AS proof_revision FROM evaluated)
  SELECT * FROM progress WHERE (? IS NULL OR state=?) ORDER BY job_id,case_index LIMIT 21`)
    .bind(actor.orgId, ...knowledgeActorValues(actor), filters.kind ?? null, filters.kind ?? null, filters.language ?? null, filters.language ?? null,
      filters.storeId === undefined ? 0 : 1, filters.storeId ?? null, filters.after, filters.after, filters.state ?? null, filters.state ?? null).all<GapRow>();
  return { gaps: rows.results.slice(0, 20).map(row => ({ jobId: row.job_id, caseIndex: row.case_index, documentId: row.document_id, revision: row.revision,
    title: row.title, question: row.question, minimumScore: row.minimum_score, observedScore: row.observed_score, createdAt: row.created_at,
    kind: row.kind, storeId: row.store_id, productRef: row.product_ref, language: row.language, state: row.state,
    proof: row.proof_job ? { jobId: row.proof_job, revision: row.proof_revision! } : null })),
    nextAfter: rows.results.length > 20 ? `${rows.results[19].job_id}:${rows.results[19].case_index}` : null };
}
