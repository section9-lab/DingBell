import { knowledgeProfile, knowledgeVectorIds, deleteKnowledgeVectors, areKnowledgeVectorsDeleted } from './vectorize.ts';

export type KnowledgeVectorCleanupJob = {
  organization_id: string; document_id: string; revision: number; profile: string; vector_ids_json: string;
  state: 'queued' | 'deleting' | 'confirming' | 'succeeded' | 'failed'; attempts: number; claim_token: string | null;
  lease_until: number | null; wake_after: number; mutation_id: string | null; error_code: string | null; created_at: number; updated_at: number;
};
const jobKey = (job: Pick<KnowledgeVectorCleanupJob, 'organization_id' | 'document_id' | 'revision' | 'profile'>) =>
  [job.organization_id, job.document_id, job.revision, job.profile] as const;
function parseIds(value: string) {
  const ids: unknown = JSON.parse(value);
  if (!Array.isArray(ids) || !ids.length || ids.length > 32 || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw new Error('KNOWLEDGE_CLEANUP_INVALID');
  return ids as string[];
}

/** Queue only a revision that can no longer become active directly. Restoring history creates a new revision with new chunk IDs. */
export async function queueStaleKnowledgeVectorCleanup(db: D1Database, organizationId: string, documentId: string, revision: number, now: number) {
  const candidate = await db.prepare(`SELECT rev.index_profile,rev.published_profile FROM knowledge_revision rev
    JOIN knowledge_document doc ON doc.organization_id=rev.organization_id AND doc.id=rev.document_id
    WHERE rev.organization_id=? AND rev.document_id=? AND rev.revision=? AND rev.revision<>doc.draft_revision
      AND (doc.active_revision IS NULL OR rev.revision<>doc.active_revision)
      AND (rev.index_profile=? OR rev.published_profile=?)`).bind(organizationId, documentId, revision, knowledgeProfile.id, knowledgeProfile.id)
    .first<{ index_profile: string | null; published_profile: string | null }>();
  if (!candidate) return false;
  const chunks = await db.prepare(`SELECT id FROM knowledge_chunk WHERE organization_id=? AND document_id=? AND revision=? ORDER BY ordinal`)
    .bind(organizationId, documentId, revision).all<{ id: string }>();
  if (!chunks.results.length || chunks.results.length > 16) throw new Error('KNOWLEDGE_CLEANUP_INVALID');
  const ids = await knowledgeVectorIds(chunks.results.map(row => row.id));
  const result = await db.prepare(`INSERT INTO knowledge_vector_cleanup
    (organization_id,document_id,revision,profile,vector_ids_json,state,attempts,wake_after,created_at,updated_at)
    SELECT ?,?,?,?,?, 'queued',0,?,?,? WHERE EXISTS (SELECT 1 FROM knowledge_document doc
      WHERE doc.organization_id=? AND doc.id=? AND doc.draft_revision<>? AND (doc.active_revision IS NULL OR doc.active_revision<>?))
    ON CONFLICT DO NOTHING RETURNING revision`).bind(organizationId, documentId, revision, knowledgeProfile.id, JSON.stringify(ids), now, now, now,
      organizationId, documentId, revision, revision).first();
  return !!result;
}

export async function queueStaleKnowledgeVectorCleanups(db: D1Database, now: number, limit = 10) {
  if (limit < 1 || limit > 20) throw new Error('KNOWLEDGE_CLEANUP_INVALID');
  const rows = await db.prepare(`SELECT rev.organization_id,rev.document_id,rev.revision FROM knowledge_revision rev
    JOIN knowledge_document doc ON doc.organization_id=rev.organization_id AND doc.id=rev.document_id
    WHERE rev.revision<>doc.draft_revision AND (doc.active_revision IS NULL OR rev.revision<>doc.active_revision)
      AND (rev.index_profile=? OR rev.published_profile=?)
      AND NOT EXISTS (SELECT 1 FROM knowledge_vector_cleanup cleanup WHERE cleanup.organization_id=rev.organization_id
        AND cleanup.document_id=rev.document_id AND cleanup.revision=rev.revision AND cleanup.profile=?)
    ORDER BY rev.organization_id,rev.document_id,rev.revision LIMIT ?`).bind(knowledgeProfile.id, knowledgeProfile.id, knowledgeProfile.id, limit)
    .all<{ organization_id: string; document_id: string; revision: number }>();
  let queued = 0;
  for (const row of rows.results) if (await queueStaleKnowledgeVectorCleanup(db, row.organization_id, row.document_id, row.revision, now)) queued++;
  return queued;
}

export function claimKnowledgeVectorCleanups(db: D1Database, token: string, now: number, limit = 10) {
  if (!token || token.length > 64 || limit < 1 || limit > 20) throw new Error('KNOWLEDGE_CLEANUP_INVALID');
  return db.prepare(`UPDATE knowledge_vector_cleanup SET
      state=CASE WHEN state='confirming' THEN 'confirming' ELSE 'deleting' END,attempts=attempts+1,claim_token=?,lease_until=?,updated_at=?
    WHERE rowid IN (SELECT rowid FROM knowledge_vector_cleanup WHERE state IN ('queued','deleting','confirming','failed') AND attempts<20
      AND wake_after<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY wake_after,created_at LIMIT ?)
    RETURNING *`).bind(token, now + 60000, now, now, now, limit).all<KnowledgeVectorCleanupJob>();
}

export async function repairKnowledgeVectorCleanups(env: { DB?: D1Database; KNOWLEDGE_INDEX?: Vectorize; KNOWLEDGE_VECTOR_CLEANUP_ENABLED?: string }) {
  if (!env.DB || !env.KNOWLEDGE_INDEX || env.KNOWLEDGE_VECTOR_CLEANUP_ENABLED !== 'true') return;
  const now = Date.now();
  await queueStaleKnowledgeVectorCleanups(env.DB, now, 10);
  const token = crypto.randomUUID(), jobs = await claimKnowledgeVectorCleanups(env.DB, token, now, 10);
  await Promise.allSettled(jobs.results.map(job => runKnowledgeVectorCleanup(env.DB!, env.KNOWLEDGE_INDEX!, job, token, now)));
}

export async function runKnowledgeVectorCleanup(db: D1Database, index: Vectorize, job: KnowledgeVectorCleanupJob, token: string, now: number) {
  if (job.claim_token !== token || job.lease_until === null || job.lease_until <= now) throw new Error('KNOWLEDGE_CLEANUP_CLAIM_LOST');
  const ids = parseIds(job.vector_ids_json), key = jobKey(job);
  try {
    if (job.state === 'deleting') {
      const mutationId = await deleteKnowledgeVectors(index, ids);
      const result = await db.prepare(`UPDATE knowledge_vector_cleanup SET state='confirming',mutation_id=?,error_code=NULL,claim_token=NULL,lease_until=NULL,wake_after=?,updated_at=?
        WHERE organization_id=? AND document_id=? AND revision=? AND profile=? AND state='deleting' AND claim_token=? AND lease_until>? RETURNING revision`)
        .bind(mutationId, now + 5000, now, ...key, token, now).first();
      if (!result) throw new Error('KNOWLEDGE_CLEANUP_CLAIM_LOST');
      return 'confirming' as const;
    }
    if (!await areKnowledgeVectorsDeleted(index, ids)) {
      const result = await db.prepare(`UPDATE knowledge_vector_cleanup SET claim_token=NULL,lease_until=NULL,wake_after=?,updated_at=?
        WHERE organization_id=? AND document_id=? AND revision=? AND profile=? AND state='confirming' AND claim_token=? AND lease_until>? RETURNING revision`)
        .bind(now + Math.min(60000, 1000 * 2 ** Math.min(job.attempts, 6)), now, ...key, token, now).first();
      if (!result) throw new Error('KNOWLEDGE_CLEANUP_CLAIM_LOST');
      return 'confirming' as const;
    }
    const result = await db.prepare(`UPDATE knowledge_vector_cleanup SET state='succeeded',error_code=NULL,claim_token=NULL,lease_until=NULL,wake_after=?,updated_at=?
      WHERE organization_id=? AND document_id=? AND revision=? AND profile=? AND state='confirming' AND claim_token=? AND lease_until>? RETURNING revision`)
      .bind(now, now, ...key, token, now).first();
    if (!result) throw new Error('KNOWLEDGE_CLEANUP_CLAIM_LOST');
    return 'succeeded' as const;
  } catch (error) {
    if (error instanceof Error && error.message === 'KNOWLEDGE_CLEANUP_CLAIM_LOST') throw error;
    await db.prepare(`UPDATE knowledge_vector_cleanup SET state='failed',error_code='VECTOR_OPERATION_FAILED',claim_token=NULL,lease_until=NULL,wake_after=?,updated_at=?
      WHERE organization_id=? AND document_id=? AND revision=? AND profile=? AND claim_token=? AND lease_until>?`)
      .bind(now + Math.min(60000, 1000 * 2 ** Math.min(job.attempts, 6)), now, ...key, token, now).run();
    return 'failed' as const;
  }
}
