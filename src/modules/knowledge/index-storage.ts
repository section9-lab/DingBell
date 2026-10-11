import type { IndexScope } from './bindings.ts';
import { knowledgeAccess, knowledgeActorValues, type KnowledgeActor } from './storage.ts';
import { knowledgeProfile } from './vectorize.ts';

export type IndexJob = {
  organization_id: string; id: string; document_id: string; revision: number; document_version: number; content_hash: string; profile: string;
  actor_user_id: string; actor_member_id: string; input_bytes: number; quota_day: string;
  state: 'queued' | 'embedding' | 'indexing' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
  attempted_at: number | null; vectors_json: string | null; mutation_id: string | null; error_code: string | null;
  created_at: number; updated_at: number; wake_after: number; deadline_at: number;
};
export const indexJobDTO = (job: IndexJob) => ({ id: job.id, documentId: job.document_id, revision: job.revision, documentVersion: job.document_version,
  state: job.state, inputBytes: job.input_bytes, attemptedAt: job.attempted_at, errorCode: job.error_code, createdAt: job.created_at, updatedAt: job.updated_at });
export const indexScopeValues = (scope: IndexScope) => [scope.organizationId, scope.jobId];
export function readIndexJob(db: D1Database, scope: IndexScope) {
  return db.prepare('SELECT * FROM knowledge_index_job WHERE organization_id=? AND id=?').bind(...indexScopeValues(scope)).first<IndexJob>();
}
export function readAuthorizedIndexJob(db: D1Database, actor: KnowledgeActor, documentId: string, jobId: string) {
  return db.prepare(`SELECT * FROM knowledge_index_job WHERE organization_id=? AND document_id=? AND id=? AND EXISTS (${knowledgeAccess})`)
    .bind(actor.orgId, documentId, jobId, ...knowledgeActorValues(actor)).first<IndexJob>();
}

export const activeIndexStates = "('queued','embedding','indexing')";
// The initiating membership survives logout, but not removal/rejoin or a role downgrade.
export const currentIndexGuard = `job.state IN ${activeIndexStates} AND job.deadline_at>unixepoch()*1000 AND job.profile='${knowledgeProfile.id}'
  AND EXISTS (SELECT 1 FROM member actor JOIN user caller ON caller.id=actor.user_id WHERE actor.id=job.actor_member_id
    AND actor.organization_id=job.organization_id AND actor.user_id=job.actor_user_id AND actor.role IN ('owner','admin') AND caller.email_verified=1)
  AND EXISTS (SELECT 1 FROM knowledge_document doc JOIN knowledge_revision rev ON rev.organization_id=doc.organization_id AND rev.document_id=doc.id AND rev.revision=doc.draft_revision
    WHERE doc.organization_id=job.organization_id AND doc.id=job.document_id AND doc.version=job.document_version AND doc.mutation_id=job.id
      AND doc.draft_revision=job.revision AND rev.content_hash=job.content_hash AND rev.status='indexing' AND rev.mutation_id=job.id)`;
export function currentIndexJob(db: D1Database, scope: IndexScope) {
  return db.prepare(`SELECT job.* FROM knowledge_index_job job WHERE job.organization_id=? AND job.id=? AND ${currentIndexGuard}`)
    .bind(...indexScopeValues(scope)).first<IndexJob>();
}
export async function finishIndexJob(db: D1Database, scope: IndexScope, state: 'failed' | 'unknown' | 'cancelled', errorCode: string, onlyEmbedding = false) {
  const states = onlyEmbedding ? "('embedding')" : activeIndexStates;
  await db.batch([
    db.prepare(`UPDATE knowledge_revision SET status='failed',tested_at=NULL WHERE organization_id=? AND mutation_id=? AND status='indexing'
      AND EXISTS (SELECT 1 FROM knowledge_index_job job WHERE job.organization_id=knowledge_revision.organization_id AND job.document_id=knowledge_revision.document_id
        AND job.revision=knowledge_revision.revision AND job.id=knowledge_revision.mutation_id AND job.state IN ${states})`).bind(...indexScopeValues(scope)),
    db.prepare(`UPDATE knowledge_index_job SET state=?,error_code=?,vectors_json=NULL,updated_at=unixepoch()*1000 WHERE organization_id=? AND id=? AND state IN ${states}`)
      .bind(state, errorCode, ...indexScopeValues(scope)),
  ]);
}

const inputBytes = `(SELECT SUM(length(CAST(chunk.body AS BLOB))) FROM knowledge_chunk chunk
  WHERE chunk.organization_id=doc.organization_id AND chunk.document_id=doc.id AND chunk.revision=doc.draft_revision)`;
export async function admitIndexJob(db: D1Database, actor: KnowledgeActor, documentId: string, jobId: string, expectedVersion: number, dailyInputBytes: number) {
  const freshHead = `doc.organization_id=? AND doc.id=? AND doc.version=? AND doc.mutation_id=?
    AND NOT EXISTS (SELECT 1 FROM knowledge_index_job job WHERE job.organization_id=doc.organization_id AND job.id=doc.mutation_id)`;
  const freshValues = [actor.orgId, documentId, expectedVersion + 1, jobId];
  const results = await db.batch([
    db.prepare(`UPDATE knowledge_document AS doc SET version=version+1,mutation_id=?,updated_at=unixepoch()*1000
      WHERE doc.organization_id=? AND doc.id=? AND doc.version=? AND doc.version<9007199254740991 AND EXISTS (${knowledgeAccess})
      AND NOT EXISTS (SELECT 1 FROM knowledge_index_job WHERE organization_id=doc.organization_id AND id=?)
      AND (doc.active_revision IS NULL OR doc.active_revision<>doc.draft_revision)
      AND EXISTS (SELECT 1 FROM knowledge_revision rev WHERE rev.organization_id=doc.organization_id AND rev.document_id=doc.id AND rev.revision=doc.draft_revision AND rev.status IN ('draft','failed'))
      AND ${inputBytes} BETWEEN 1 AND 38400 AND ${inputBytes}+COALESCE((SELECT reserved_bytes FROM knowledge_index_usage WHERE day=date('now')),0)<=?
      AND (SELECT COUNT(*) FROM knowledge_index_job WHERE organization_id=doc.organization_id AND quota_day=date('now'))<100 RETURNING version`)
      .bind(jobId, actor.orgId, documentId, expectedVersion, ...knowledgeActorValues(actor), jobId, dailyInputBytes),
    db.prepare(`INSERT INTO knowledge_index_usage(day,reserved_bytes,jobs) SELECT date('now'),${inputBytes},1 FROM knowledge_document doc WHERE ${freshHead}
      ON CONFLICT(day) DO UPDATE SET reserved_bytes=reserved_bytes+excluded.reserved_bytes,jobs=jobs+1`).bind(...freshValues),
    db.prepare(`INSERT INTO knowledge_index_job(organization_id,id,document_id,revision,document_version,content_hash,profile,actor_user_id,actor_member_id,input_bytes,quota_day,state,created_at,updated_at,wake_after,deadline_at)
      SELECT doc.organization_id,?,doc.id,doc.draft_revision,doc.version,rev.content_hash,?,actor.user_id,actor.id,${inputBytes},date('now'),'queued',unixepoch()*1000,unixepoch()*1000,0,unixepoch()*1000+900000
      FROM knowledge_document doc JOIN knowledge_revision rev ON rev.organization_id=doc.organization_id AND rev.document_id=doc.id AND rev.revision=doc.draft_revision
      JOIN member actor ON actor.organization_id=doc.organization_id AND actor.user_id=? WHERE ${freshHead}`)
      .bind(jobId, knowledgeProfile.id, actor.actorUserId, ...freshValues),
    db.prepare(`UPDATE knowledge_revision SET status='indexing',tested_at=NULL,index_profile=NULL,mutation_id=? WHERE organization_id=? AND document_id=? AND status IN ('draft','failed')
      AND EXISTS (SELECT 1 FROM knowledge_index_job job WHERE job.organization_id=knowledge_revision.organization_id AND job.document_id=knowledge_revision.document_id
        AND job.revision=knowledge_revision.revision AND job.id=? AND job.document_version=? AND job.state='queued')`)
      .bind(jobId, actor.orgId, documentId, jobId, expectedVersion + 1),
  ]);
  return results[0].results.length > 0;
}
