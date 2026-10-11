import type { KnowledgeTestCases } from '../../shared/knowledge.ts';
import type { IndexScope } from './bindings.ts';
import { knowledgeAccess, knowledgeActorValues, type KnowledgeActor } from './storage.ts';
import { knowledgeProfile } from './vectorize.ts';

export type ReviewJob = {
  organization_id: string; id: string; document_id: string; kind: 'test' | 'publish'; revision: number; document_version: number; content_hash: string; profile: string;
  actor_user_id: string; actor_member_id: string; test_job_id: string | null; cases_json: string | null; results_json: string | null; input_bytes: number; quota_day: string;
  state: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'unknown' | 'cancelled'; attempted_at: number | null; vectors_json: string | null;
  mutation_id: string | null; error_code: string | null; created_at: number; updated_at: number; completed_at: number | null; wake_after: number; deadline_at: number;
};
export const reviewJobDTO = (job: ReviewJob) => ({ id: job.id, documentId: job.document_id, revision: job.revision, documentVersion: job.document_version, kind: job.kind,
  state: job.state, cases: job.cases_json ? JSON.parse(job.cases_json) : null, results: job.results_json ? JSON.parse(job.results_json) : null,
  inputBytes: job.input_bytes, errorCode: job.error_code, createdAt: job.created_at, updatedAt: job.updated_at, completedAt: job.completed_at });
export const reviewScopeValues = (scope: IndexScope) => [scope.organizationId, scope.jobId];
export const activeReviewStates = "('queued','running','waiting')";
const reviewMemberGuard = `EXISTS (SELECT 1 FROM member actor JOIN user caller ON caller.id=actor.user_id WHERE actor.id=job.actor_member_id
  AND actor.organization_id=job.organization_id AND actor.user_id=job.actor_user_id AND actor.role IN ('owner','admin') AND caller.email_verified=1)`;
export const currentReviewGuard = `job.state IN ${activeReviewStates} AND job.deadline_at>unixepoch()*1000 AND job.profile='${knowledgeProfile.id}' AND ${reviewMemberGuard}
  AND (job.kind='test' OR job.document_version<9007199254740991)
  AND EXISTS (SELECT 1 FROM knowledge_document doc JOIN knowledge_revision rev ON rev.organization_id=doc.organization_id AND rev.document_id=doc.id AND rev.revision=doc.draft_revision
    WHERE doc.organization_id=job.organization_id AND doc.id=job.document_id AND doc.version=job.document_version AND doc.mutation_id=job.id
      AND doc.draft_revision=job.revision AND rev.content_hash=job.content_hash AND rev.status='ready' AND rev.index_profile=job.profile AND rev.mutation_id IS NOT NULL
      AND (doc.active_revision IS NULL OR doc.active_revision<>doc.draft_revision)
      AND (job.kind='test' OR EXISTS (SELECT 1 FROM knowledge_review_job test WHERE test.organization_id=job.organization_id AND test.id=job.test_job_id
        AND test.document_id=job.document_id AND test.revision=job.revision AND test.kind='test' AND test.state='succeeded'
        AND test.content_hash=job.content_hash AND test.profile=job.profile AND test.completed_at=rev.tested_at)))`;
export function readReviewJob(db: D1Database, scope: IndexScope) {
  return db.prepare('SELECT * FROM knowledge_review_job WHERE organization_id=? AND id=?').bind(...reviewScopeValues(scope)).first<ReviewJob>();
}
export function currentReviewJob(db: D1Database, scope: IndexScope) {
  return db.prepare(`SELECT job.* FROM knowledge_review_job job WHERE job.organization_id=? AND job.id=? AND ${currentReviewGuard}`)
    .bind(...reviewScopeValues(scope)).first<ReviewJob>();
}
export function readAuthorizedReview(db: D1Database, actor: KnowledgeActor, documentId: string, jobId: string) {
  return db.prepare(`SELECT * FROM knowledge_review_job WHERE organization_id=? AND document_id=? AND id=? AND EXISTS (${knowledgeAccess})`)
    .bind(actor.orgId, documentId, jobId, ...knowledgeActorValues(actor)).first<ReviewJob>();
}
export function reviewAudit(db: D1Database, scope: IndexScope) {
  return db.prepare(`INSERT INTO knowledge_audit_event(id,request_id,organization_id,document_id,actor_user_id,action,outcome,expected_version,created_at)
    SELECT json_array(organization_id,id,'review-completed'),id,organization_id,document_id,actor_user_id,kind||'.completed',state,document_version,unixepoch()*1000
    FROM knowledge_review_job WHERE organization_id=? AND id=? AND state NOT IN ${activeReviewStates} ON CONFLICT DO NOTHING`).bind(...reviewScopeValues(scope));
}
export async function finishReviewJob(db: D1Database, scope: IndexScope, state: 'failed' | 'unknown' | 'cancelled', error: string) {
  await db.batch([db.prepare(`UPDATE knowledge_review_job SET state=?,error_code=?,vectors_json=NULL,updated_at=unixepoch()*1000,completed_at=unixepoch()*1000
    WHERE organization_id=? AND id=? AND state IN ${activeReviewStates}`).bind(state, error, ...reviewScopeValues(scope)), reviewAudit(db, scope)]);
}

export async function admitReviewJob(db: D1Database, actor: KnowledgeActor, documentId: string, jobId: string, expectedVersion: number, cases: KnowledgeTestCases | null, limit: number) {
  const kind = cases ? 'test' : 'publish', casesJson = cases ? JSON.stringify(cases) : null;
  const inputBytes = cases ? new TextEncoder().encode(cases.map(value => value.question).join('')).length : 0;
  const fresh = `doc.organization_id=? AND doc.id=? AND doc.version=? AND doc.mutation_id=? AND NOT EXISTS (SELECT 1 FROM knowledge_review_job WHERE organization_id=doc.organization_id AND id=doc.mutation_id)`;
  const freshValues = [actor.orgId, documentId, expectedVersion + 1, jobId];
  const passingTest = `SELECT test.id FROM knowledge_review_job previous JOIN knowledge_review_job test ON test.organization_id=previous.organization_id
    AND test.id=CASE WHEN previous.kind='test' THEN previous.id ELSE previous.test_job_id END
    WHERE previous.organization_id=doc.organization_id AND previous.document_id=doc.id AND previous.document_version=? AND previous.revision=doc.draft_revision
      AND ((previous.kind='test' AND previous.state='succeeded') OR (previous.kind='publish' AND previous.state IN ('failed','unknown','cancelled')))
      AND test.kind='test' AND test.state='succeeded' AND test.document_id=doc.id AND test.revision=doc.draft_revision
      AND test.content_hash=rev.content_hash AND test.profile=rev.index_profile AND test.completed_at=rev.tested_at`;
  const results = await db.batch([
    db.prepare(`UPDATE knowledge_document AS doc SET version=version+1,mutation_id=?,updated_at=unixepoch()*1000
      WHERE doc.organization_id=? AND doc.id=? AND doc.version=? AND doc.version<9007199254740991 AND EXISTS (${knowledgeAccess})
      AND (?='test' OR doc.version<9007199254740990)
      AND (doc.active_revision IS NULL OR doc.active_revision<>doc.draft_revision)
      AND NOT EXISTS (SELECT 1 FROM knowledge_review_job WHERE organization_id=doc.organization_id AND id=?)
      AND (SELECT COUNT(*) FROM knowledge_review_job WHERE organization_id=doc.organization_id AND quota_day=date('now'))<100
      AND EXISTS (SELECT 1 FROM knowledge_revision rev WHERE rev.organization_id=doc.organization_id AND rev.document_id=doc.id AND rev.revision=doc.draft_revision
        AND rev.status='ready' AND rev.index_profile=? AND rev.mutation_id IS NOT NULL
        AND ((?='test' AND NOT EXISTS (SELECT 1 FROM json_each(?) c WHERE NOT EXISTS (SELECT 1 FROM knowledge_chunk chunk
          WHERE chunk.organization_id=doc.organization_id AND chunk.document_id=doc.id AND chunk.revision=doc.draft_revision AND chunk.id=json_extract(c.value,'$.expectedChunkId'))))
          OR (?='publish' AND EXISTS (${passingTest}))))
      AND (?='publish' OR ?+COALESCE((SELECT reserved_bytes FROM knowledge_index_usage WHERE day=date('now')),0)<=?) RETURNING version`)
      .bind(jobId, actor.orgId, documentId, expectedVersion, ...knowledgeActorValues(actor), kind, jobId, knowledgeProfile.id, kind, casesJson, kind, expectedVersion, kind, inputBytes, limit),
    db.prepare(`INSERT INTO knowledge_index_usage(day,reserved_bytes,jobs) SELECT date('now'),?,1 FROM knowledge_document doc WHERE ${fresh} AND ?='test'
      ON CONFLICT(day) DO UPDATE SET reserved_bytes=reserved_bytes+excluded.reserved_bytes,jobs=jobs+1`).bind(inputBytes, ...freshValues, kind),
    db.prepare(`INSERT INTO knowledge_review_job(organization_id,id,document_id,kind,revision,document_version,content_hash,profile,actor_user_id,actor_member_id,test_job_id,cases_json,input_bytes,quota_day,state,created_at,updated_at,wake_after,deadline_at)
      SELECT doc.organization_id,?,doc.id,?,doc.draft_revision,doc.version,rev.content_hash,rev.index_profile,actor.user_id,actor.id,
        CASE WHEN ?='publish' THEN (${passingTest}) ELSE NULL END,
        ?,?,date('now'),'queued',unixepoch()*1000,unixepoch()*1000,0,unixepoch()*1000+900000
      FROM knowledge_document doc JOIN knowledge_revision rev ON rev.organization_id=doc.organization_id AND rev.document_id=doc.id AND rev.revision=doc.draft_revision
      JOIN member actor ON actor.organization_id=doc.organization_id AND actor.user_id=? WHERE ${fresh}`)
      .bind(jobId, kind, kind, expectedVersion, casesJson, inputBytes, actor.actorUserId, ...freshValues),
    db.prepare(`UPDATE knowledge_revision SET tested_at=CASE WHEN ?='test' THEN NULL ELSE tested_at END,published_profile=NULL,published_mutation_id=NULL,published_at=NULL
      WHERE organization_id=? AND document_id=? AND EXISTS (SELECT 1 FROM knowledge_review_job job WHERE job.organization_id=knowledge_revision.organization_id
        AND job.document_id=knowledge_revision.document_id AND job.revision=knowledge_revision.revision AND job.id=? AND job.document_version=? AND job.state='queued')`)
      .bind(kind, actor.orgId, documentId, jobId, expectedVersion + 1),
  ]);
  return results[0].results.length > 0;
}
