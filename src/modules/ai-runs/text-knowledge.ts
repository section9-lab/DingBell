import * as v from 'valibot';
import { aiRunSchema, aiScopeSchema, } from '../conversations/ai-state.ts';
import type { ControlScope } from '../conversations/control-types.ts';
import { knowledgeHash } from '../knowledge/content.ts';
import { grepPublishedText, readPublishedKnowledge, knowledgeTextProfile, resolveTextKnowledgeCitations } from '../knowledge/text-profile.ts';
import { retrievalScopeSchema, type RetrievalScope } from '../knowledge/retrieval.ts';
import { aiKnowledgeEvidenceSchema, aiKnowledgeScope, type AiKnowledgeBindings } from './knowledge.ts';
import { currentPayload, readAiExecution, type AiRunReader } from './storage.ts';

export const textKnowledgeProfiles = ['support-knowledge-v1', 'support-reply-v1'] as const;
export const grepInputSchema = v.strictObject({ query: v.pipe(v.string(), v.minLength(2), v.maxLength(300)) });
export const readInputSchema = v.strictObject({ documentId: v.pipe(v.string(), v.uuid()) });
export const evidenceLimit = 10;
type None = { status: 'unavailable' | 'unconfirmed' | 'changed' | 'empty'; canSend: false; evidence: null };
const none = (status: None['status']): None => ({ status, canSend: false as const, evidence: null });
async function authority(env: AiKnowledgeBindings, read: AiRunReader, scope: ControlScope, runId: string) {
  if (!env.DB) return null;
  scope = v.parse(aiScopeSchema, scope);
  v.parse(v.pipe(v.string(), v.uuid()), runId);
  const db = env.DB, execution = await readAiExecution(db, scope, runId);
  if (!execution || execution.closure || !textKnowledgeProfiles.includes(execution.config.model.promptVersion as typeof textKnowledgeProfiles[number])) return null;
  if (execution.config.model.promptVersion === 'support-reply-v1'
    && !(env.AI_OUTBOUND_ENABLED === 'true' && env.OUTBOUND_ENABLED === 'true')) return null;
  const run = v.parse(aiRunSchema, execution.payload.run);
  if (Date.now() >= run.deadlineAt) return null;
  if (JSON.stringify(await read({ ...scope }, runId)) !== JSON.stringify(run)) return null;
  const live = await db.prepare(`SELECT 1 FROM ai_execution e JOIN (SELECT ? AS value) plan WHERE e.id=? AND e.closure IS NULL AND ${currentPayload}`)
    .bind(JSON.stringify(execution.payload), runId).first();
  return live ? { db, execution, run } : null;
}
type Frozen = { chunks: string };
const frozenRow = (db: D1Database, runId: string) => db.prepare('SELECT chunks FROM ai_knowledge_evidence WHERE run_id=?').bind(runId).first<Frozen>();
async function readFrozen(db: D1Database, runId: string, scope: RetrievalScope, questionHash: string) {
  const row = await frozenRow(db, runId);
  if (!row) return null;
  const evidence = v.safeParse(aiKnowledgeEvidenceSchema, { runId, scope, questionHash, chunks: JSON.parse(row.chunks) });
  return evidence.success ? evidence.output : null;
}
/**
 * Agentic retrieval: the assistant names the words it wants to find, the
 * application only searches knowledge the merchant already approved. Evidence
 * accumulates per run but can never shrink or change, so a later reply tool
 * call revalidates exactly the text this run was shown.
 */
export async function grepAiKnowledge(env: AiKnowledgeBindings, read: AiRunReader, scope: ControlScope, runId: string, value: unknown) {
  try {
    const input = v.parse(grepInputSchema, value), auth = await authority(env, read, scope, runId);
    if (!auth) return none('unavailable');
    const { db } = auth, knowledgeScope = await aiKnowledgeScope(db, scope, auth.run);
    const questionHash = await knowledgeHash(auth.run.admission.question);
    const frozen = await readFrozen(db, runId, knowledgeScope, questionHash);
    if (await frozenRow(db, runId) && !frozen) return none('changed');
    const merged = [...(frozen?.chunks ?? [])];
    if (merged.length < evidenceLimit) {
      for (const match of await grepPublishedText(db, scope.organizationId, knowledgeScope, input.query)) {
        if (merged.length >= evidenceLimit) break;
        if (!merged.some(chunk => chunk.chunkId === match.chunkId)) merged.push(match);
      }
    }
    if (!merged.length) return none('empty');
    // Freeze only text that is still the merchant's active publication.
    if (!await resolveTextKnowledgeCitations(db, scope.organizationId, knowledgeScope, merged)) return none('changed');
    const evidence = v.parse(aiKnowledgeEvidenceSchema, { runId, scope: knowledgeScope, questionHash, chunks: merged });
    const stamped = Date.now();
    await db.prepare(`INSERT INTO ai_knowledge_evidence(run_id,organization_id,scope,profile,question_hash,chunks,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET chunks=excluded.chunks,updated_at=excluded.updated_at
      WHERE ai_knowledge_evidence.chunks<>excluded.chunks`)
      .bind(runId, scope.organizationId, JSON.stringify(knowledgeScope), knowledgeTextProfile.id, questionHash, JSON.stringify(merged), stamped, stamped).run();
    const confirmed = await readFrozen(db, runId, knowledgeScope, questionHash);
    return confirmed && JSON.stringify(confirmed) === JSON.stringify(evidence)
      ? { status: 'found' as const, canSend: false as const, evidence: confirmed }
      : none('changed');
  } catch { return none('unconfirmed'); }
}
/** Read the full published markdown body of a specific knowledge document for this run. */
export async function readAiKnowledge(env: AiKnowledgeBindings, read: AiRunReader, scope: ControlScope, runId: string, value: unknown) {
  try {
    const input = v.parse(readInputSchema, value), auth = await authority(env, read, scope, runId);
    if (!auth) return { status: 'unavailable' as const, canSend: false as const, document: null };
    const knowledgeScope = await aiKnowledgeScope(auth.db, scope, auth.run);
    const document = await readPublishedKnowledge(auth.db, scope.organizationId, knowledgeScope, input.documentId);
    return document ? { status: 'found' as const, canSend: false as const, document }
      : { status: 'empty' as const, canSend: false as const, document: null };
  } catch { return { status: 'unconfirmed' as const, canSend: false as const, document: null }; }
}
/** Citation validity only: a match never proves the text answers the question. */
export async function reviewAiTextEvidence(env: AiKnowledgeBindings, read: AiRunReader, scope: ControlScope, runId: string, value: unknown) {
  try {
    const auth = await authority(env, read, scope, runId);
    if (!auth) return null;
    const parsed = v.safeParse(aiKnowledgeEvidenceSchema, structuredClone(value));
    if (!parsed.success) return null;
    const requested = parsed.output;
    const frozen = await readFrozen(auth.db, runId, requested.scope, requested.questionHash);
    if (!frozen || frozen.runId !== runId || JSON.stringify(frozen) !== JSON.stringify(requested)) return null;
    const resolved = await resolveTextKnowledgeCitations(auth.db, scope.organizationId, requested.scope, requested.chunks);
    if (!resolved || resolved.some((row, index) => JSON.stringify(row) !== JSON.stringify(((({ score, ...chunk }) => chunk)(requested.chunks[index]))))) return null;
    return frozen;
  } catch { return null; }
}
export type RunKnowledgeEvidence = { raw: string; scope: RetrievalScope; questionHash: string; profile: string };
/**
 * One durable evidence record per run, whichever retrieval path produced it.
 * Callers must still revalidate the chunks; this only identifies the record.
 */
export async function readRunKnowledgeEvidence(db: D1Database, runId: string) {
  const row = await db.prepare(`SELECT chunks AS raw,scope,question_hash AS questionHash,profile FROM ai_knowledge_evidence WHERE run_id=?`)
    .bind(runId).first<{ raw: string; scope: string; questionHash: string; profile: string }>();
  if (!row) return null;
  const scope = v.safeParse(retrievalScopeSchema, JSON.parse(row.scope));
  return scope.success && /^[0-9a-f]{64}$/.test(row.questionHash) ? { ...row, scope: scope.output } : null;
}
/** Text retrieval is the only evidence path; it produces the shared evidence shape. */
export async function reviewRunKnowledgeEvidence(env: AiKnowledgeBindings, read: AiRunReader, scope: ControlScope, runId: string, value: unknown) {
  return await reviewAiTextEvidence(env, read, scope, runId, value);
}
