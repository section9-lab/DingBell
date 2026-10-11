import type { WorkflowStep } from 'cloudflare:workers';
import * as v from 'valibot';
import { knowledgeDraftSchema, type KnowledgeScope } from '../../shared/knowledge.ts';
import { knowledgeIndexConfig, type IndexScope, type KnowledgeBindings } from './bindings.ts';
import { prepareKnowledge } from './content.ts';
import { currentIndexGuard, currentIndexJob, finishIndexJob, indexScopeValues, readIndexJob, type IndexJob } from './index-storage.ts';
import { embedKnowledge, indexKnowledge, isKnowledgeVisible, knowledgeManifest } from './vectorize.ts';

export type IndexEnvironment = KnowledgeBindings & { DB: D1Database };
export async function usableIndexJob(env: IndexEnvironment, scope: IndexScope) {
  const job = await readIndexJob(env.DB, scope);
  if (!job || !['queued', 'embedding', 'indexing'].includes(job.state)) return null;
  if (!await currentIndexJob(env.DB, scope)) {
    await finishIndexJob(env.DB, scope, job.deadline_at <= Date.now() ? (job.state === 'embedding' ? 'unknown' : 'failed') : 'cancelled',
      job.deadline_at <= Date.now() ? 'INDEX_DEADLINE' : 'STALE_OR_REVOKED'); return null;
  }
  if (!knowledgeIndexConfig(env)) { await finishIndexJob(env.DB, scope, 'cancelled', 'INDEXING_DISABLED'); return null; }
  return job;
}
export async function manifestFor(db: D1Database, job: Pick<IndexJob, 'organization_id' | 'document_id' | 'revision' | 'content_hash'> & { input_bytes?: number }) {
  const row = await db.prepare(`SELECT doc.kind,doc.store_id AS storeId,doc.product_ref AS productRef,doc.language,rev.title,rev.source_json
    FROM knowledge_document doc JOIN knowledge_revision rev ON rev.organization_id=doc.organization_id AND rev.document_id=doc.id
    WHERE doc.organization_id=? AND doc.id=? AND rev.revision=?`).bind(job.organization_id, job.document_id, job.revision)
    .first<KnowledgeScope & { title: string; source_json: string }>();
  if (!row) throw new Error('KNOWLEDGE_MANIFEST_INVALID');
  const { kind, storeId, productRef, language } = row, scope = { kind, storeId, productRef, language };
  const prepared = await prepareKnowledge(job.organization_id, job.document_id, job.revision, scope,
    v.parse(knowledgeDraftSchema, { title: row.title, source: JSON.parse(row.source_json) }));
  const stored = await db.prepare(`SELECT id,ordinal,body,body_hash AS bodyHash FROM knowledge_chunk WHERE organization_id=? AND document_id=? AND revision=? ORDER BY ordinal`)
    .bind(job.organization_id, job.document_id, job.revision).all<(typeof prepared.chunks)[number]>();
  if (prepared.contentHash !== job.content_hash || (job.input_bytes !== undefined && new TextEncoder().encode(prepared.chunks.map(c => c.body).join('')).length !== job.input_bytes)
    || stored.results.length !== prepared.chunks.length || prepared.chunks.some((c, i) => Object.entries(c).some(([key, value]) => stored.results[i][key as keyof typeof c] !== value)))
    throw new Error('KNOWLEDGE_MANIFEST_INVALID');
  return knowledgeManifest(job.organization_id, job.document_id, job.revision, scope, prepared);
}

export async function embedIndexJob(env: IndexEnvironment, scope: IndexScope): Promise<boolean> {
  const job = await usableIndexJob(env, scope); if (!job) return false;
  if (job.state === 'indexing' && job.vectors_json) return true;
  if (job.attempted_at !== null) { await finishIndexJob(env.DB, scope, 'unknown', 'EMBEDDING_UNCONFIRMED', true); return false; }
  const manifest = await manifestFor(env.DB, job);
  const claimed = await env.DB.prepare(`UPDATE knowledge_index_job AS job SET state='embedding',attempted_at=unixepoch()*1000,updated_at=unixepoch()*1000
    WHERE job.organization_id=? AND job.id=? AND job.attempted_at IS NULL AND ${currentIndexGuard} RETURNING id`).bind(...indexScopeValues(scope)).first();
  if (!claimed) return false;
  // Neither a Workflow replay nor a lost response may start this external call twice.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const vectors = await Promise.race([embedKnowledge(env.KNOWLEDGE_AI!, manifest.chunks.map(chunk => chunk.body)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('EMBEDDING_TIMEOUT')), 45_000); })]);
    const saved = await env.DB.prepare(`UPDATE knowledge_index_job AS job SET state='indexing',vectors_json=?,updated_at=unixepoch()*1000
      WHERE job.organization_id=? AND job.id=? AND job.state='embedding' AND ${currentIndexGuard} RETURNING id`)
      .bind(JSON.stringify(vectors), ...indexScopeValues(scope)).first();
    if (!saved) { await finishIndexJob(env.DB, scope, 'cancelled', 'STALE_OR_REVOKED'); return false; }
    return true;
  } catch {
    // The D1 save may have committed before its acknowledgement was lost.
    const saved = await readIndexJob(env.DB, scope);
    if (saved?.state === 'indexing' && saved.vectors_json) return true;
    await finishIndexJob(env.DB, scope, 'unknown', 'EMBEDDING_UNCONFIRMED', true); return false;
  } finally { clearTimeout(timer); }
}

export async function upsertIndexJob(env: IndexEnvironment, scope: IndexScope): Promise<boolean> {
  const job = await usableIndexJob(env, scope); if (!job) return false;
  if (job.state !== 'indexing' || !job.vectors_json) throw new Error('KNOWLEDGE_EMBEDDING_MISSING');
  if (job.mutation_id) return true;
  const manifest = await manifestFor(env.DB, job);
  if (!await currentIndexJob(env.DB, scope)) { await finishIndexJob(env.DB, scope, 'cancelled', 'STALE_OR_REVOKED'); return false; }
  const receipt = await indexKnowledge(env.KNOWLEDGE_INDEX!, manifest, JSON.parse(job.vectors_json));
  const saved = await env.DB.prepare(`UPDATE knowledge_index_job AS job SET mutation_id=?,updated_at=unixepoch()*1000
    WHERE job.organization_id=? AND job.id=? AND job.state='indexing' AND ${currentIndexGuard} RETURNING id`)
    .bind(receipt, ...indexScopeValues(scope)).first();
  if (!saved) await finishIndexJob(env.DB, scope, 'cancelled', 'STALE_OR_REVOKED');
  return !!saved;
}

export async function confirmIndexJob(env: IndexEnvironment, scope: IndexScope): Promise<'waiting' | 'done'> {
  const job = await usableIndexJob(env, scope); if (!job) return 'done';
  if (job.state !== 'indexing' || !job.mutation_id) throw new Error('KNOWLEDGE_RECEIPT_MISSING');
  const manifest = await manifestFor(env.DB, job);
  // A missing queryById result may throw until the asynchronous mutation is visible.
  if (!await isKnowledgeVisible(env.KNOWLEDGE_INDEX!, manifest).catch(() => false)) return 'waiting';
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE knowledge_index_job AS job SET state='succeeded',vectors_json=NULL,updated_at=unixepoch()*1000
      WHERE job.organization_id=? AND job.id=? AND job.state='indexing' AND ${currentIndexGuard} RETURNING id`).bind(...indexScopeValues(scope)),
    env.DB.prepare(`UPDATE knowledge_revision SET status='ready',tested_at=NULL,index_profile=?,mutation_id=? WHERE organization_id=? AND document_id=? AND revision=? AND mutation_id=?
      AND EXISTS (SELECT 1 FROM knowledge_index_job WHERE organization_id=? AND id=? AND state='succeeded')`)
      .bind(job.profile, job.mutation_id, job.organization_id, job.document_id, job.revision, job.id, ...indexScopeValues(scope)),
  ]);
  if (!result[0].results.length) await finishIndexJob(env.DB, scope, 'cancelled', 'STALE_OR_REVOKED');
  return 'done';
}

export async function runKnowledgeIndex(env: IndexEnvironment, scope: IndexScope, step: WorkflowStep) {
  const retry = { retries: { limit: 3, delay: '2 seconds' as const, backoff: 'exponential' as const }, timeout: '30 seconds' as const };
  try {
    if (!await step.do('embed immutable revision', { retries: { limit: 0, delay: '1 second' }, timeout: '1 minute' }, () => embedIndexJob(env, scope))) return;
    if (!await step.do('upsert draft vectors', retry, () => upsertIndexJob(env, scope))) return;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (attempt) await step.sleep(`wait for index ${attempt}`, '10 seconds');
      if (await step.do(`confirm index ${attempt}`, retry, () => confirmIndexJob(env, scope)) === 'done') return;
    }
    await step.do('record visibility deadline', retry, () => finishIndexJob(env.DB, scope, 'failed', 'INDEX_NOT_VISIBLE'));
  } catch {
    await step.do('record interrupted index', retry, async () => {
      const job = await readIndexJob(env.DB, scope);
      await finishIndexJob(env.DB, scope, job?.state === 'embedding' ? 'unknown' : 'failed', job?.state === 'embedding' ? 'EMBEDDING_UNCONFIRMED' : 'INDEX_INTERRUPTED');
    });
  }
}
