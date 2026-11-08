import * as v from 'valibot';
import { aiRunSchema, aiScopeSchema } from '../conversations/ai-state.ts';
import type { ControlScope } from '../conversations/control-types.ts';
import { knowledgeHash } from '../knowledge/content.ts';
import { knowledgeTextProfile, resolveTextKnowledgeDocuments } from '../knowledge/text-profile.ts';
import { retrievalScopeSchema, type RetrievalScope } from '../knowledge/retrieval.ts';
import { readKnowledgeVirtualFile, readKnowledgeVirtualFiles } from '../knowledge/virtual-files.ts';
import { runKnowledgeDiscovery } from '../knowledge/virtual-bash.ts';
import { isOutboundPromptVersion, isSupportKnowledgePromptVersion } from '../../shared/ai-versions.ts';
import { aiDocumentEvidenceSchema, aiKnowledgeScope, type AiKnowledgeBindings } from './knowledge.ts';
import { currentPayload, readAiExecution, type AiRunReader } from './storage.ts';

export const fileReadInputSchema = v.strictObject({
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  startLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER))),
  lineCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200))),
});
export const discoveryInputSchema = v.strictObject({ command: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)) });
const documentReadInputSchema = v.strictObject({
  documentId: v.pipe(v.string(), v.uuid()),
  revision: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER)),
  contentHash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  title: v.pipe(v.string(), v.maxLength(160)),
  excerpt: v.pipe(v.string(), v.maxLength(8192)),
});
export const evidenceLimit = 10;
/** Internal authorization for one live support run. It never grants send authority. */
export async function knowledgeAuthority(env: AiKnowledgeBindings, read: AiRunReader, scope: ControlScope, runId: string) {
  if (!env.DB) return null;
  scope = v.parse(aiScopeSchema, scope);
  v.parse(v.pipe(v.string(), v.uuid()), runId);
  const db = env.DB, execution = await readAiExecution(db, scope, runId);
  if (!execution || execution.closure || !isSupportKnowledgePromptVersion(execution.config.model.promptVersion)) return null;
  if (isOutboundPromptVersion(execution.config.model.promptVersion)
    && !(env.AI_OUTBOUND_ENABLED === 'true' && env.OUTBOUND_ENABLED === 'true')) return null;
  const run = v.parse(aiRunSchema, execution.payload.run);
  if (Date.now() >= run.deadlineAt) return null;
  if (JSON.stringify(await read({ ...scope }, runId)) !== JSON.stringify(run)) return null;
  const live = await db.prepare(`SELECT 1 FROM ai_execution e JOIN (SELECT ? AS value) plan WHERE e.id=? AND e.closure IS NULL AND ${currentPayload}`)
    .bind(JSON.stringify(execution.payload), runId).first();
  return live ? { db, execution, run } : null;
}
type Frozen = { documents: string };
const frozenRow = (db: D1Database, runId: string) => db.prepare('SELECT documents FROM ai_document_evidence WHERE run_id=?').bind(runId).first<Frozen>();
async function readFrozen(db: D1Database, runId: string, scope: RetrievalScope, questionHash: string) {
  const row = await frozenRow(db, runId);
  if (!row) return null;
  const evidence = v.safeParse(aiDocumentEvidenceSchema, { runId, scope, questionHash, documents: JSON.parse(row.documents) });
  return evidence.success ? evidence.output : null;
}
/** Freeze only documents that are still the merchant's active publication. */
async function freezeDocuments(db: D1Database, runId: string, organizationId: string, scope: RetrievalScope, questionHash: string, documents: { documentId: string; revision: number; contentHash: string; title: string; excerpt: string }[]) {
  if (!await resolveTextKnowledgeDocuments(db, organizationId, scope, documents)) return null;
  const evidence = v.parse(aiDocumentEvidenceSchema, { runId, scope, questionHash, documents });
  const stamped = Date.now();
  await db.prepare(`INSERT INTO ai_document_evidence(run_id,organization_id,scope,profile,question_hash,documents,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET documents=excluded.documents,updated_at=excluded.updated_at
    WHERE ai_document_evidence.documents<>excluded.documents`)
    .bind(runId, organizationId, JSON.stringify(scope), knowledgeTextProfile.id, questionHash, JSON.stringify(documents), stamped, stamped).run();
  const confirmed = await readFrozen(db, runId, scope, questionHash);
  return confirmed && JSON.stringify(confirmed) === JSON.stringify(evidence) ? confirmed : null;
}
/** Record one document the agent actually read. Shell output is deliberately not accepted. */
export async function recordAiDocumentRead(env: AiKnowledgeBindings, read: AiRunReader, scope: ControlScope, runId: string, value: unknown) {
  try {
    const input = v.parse(documentReadInputSchema, value), auth = await knowledgeAuthority(env, read, scope, runId);
    if (!auth) return { status: 'unavailable' as const, canSend: false as const, evidence: null };
    const { db } = auth, knowledgeScope = await aiKnowledgeScope(db, scope, auth.run), questionHash = await knowledgeHash(auth.run.admission.question);
    const frozen = await readFrozen(db, runId, knowledgeScope, questionHash);
    if (await frozenRow(db, runId) && !frozen) return { status: 'changed' as const, canSend: false as const, evidence: null };
    const documents = [...(frozen?.documents ?? [])], existing = documents.find(document => document.documentId === input.documentId);
    if (existing) {
      if (existing.revision !== input.revision || existing.contentHash !== input.contentHash) return { status: 'changed' as const, canSend: false as const, evidence: null };
    } else {
      if (documents.length >= evidenceLimit) return { status: 'unavailable' as const, canSend: false as const, evidence: null };
      documents.push({ documentId: input.documentId, revision: input.revision, contentHash: input.contentHash, title: input.title, excerpt: input.excerpt });
    }
    const confirmed = await freezeDocuments(db, runId, scope.organizationId, knowledgeScope, questionHash, documents);
    return confirmed ? { status: 'found' as const, canSend: false as const, evidence: confirmed }
      : { status: 'changed' as const, canSend: false as const, evidence: null };
  } catch { return { status: 'unconfirmed' as const, canSend: false as const, evidence: null }; }
}
/** Bounded, read-only discovery. Its stdout is never evidence and never a send permission. */
export async function discoverAiKnowledge(env: AiKnowledgeBindings, read: AiRunReader, scope: ControlScope, runId: string, value: unknown, signal?: AbortSignal) {
  try {
    const input = v.parse(discoveryInputSchema, value), auth = await knowledgeAuthority(env, read, scope, runId);
    if (!auth) return { status: 'unavailable' as const, canSend: false as const, stdout: '', stderr: '', exitCode: 1 };
    const knowledgeScope = await aiKnowledgeScope(auth.db, scope, auth.run), files = await readKnowledgeVirtualFiles(auth.db, scope.organizationId, knowledgeScope);
    signal?.throwIfAborted();
    if (!await knowledgeAuthority(env, read, scope, runId)) return { status: 'unconfirmed' as const, canSend: false as const, stdout: '', stderr: '', exitCode: 1 };
    const result = await runKnowledgeDiscovery(files, input.command, signal);
    if (!await knowledgeAuthority(env, read, scope, runId)) return { status: 'unconfirmed' as const, canSend: false as const, stdout: '', stderr: '', exitCode: 1 };
    return { status: 'ok' as const, canSend: false as const, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  } catch { return { status: 'unavailable' as const, canSend: false as const, stdout: '', stderr: '', exitCode: 1 }; }
}
/** Read a bounded range from the authorized virtual snapshot and freeze that exact document. */
export async function readAiKnowledgeFile(env: AiKnowledgeBindings, read: AiRunReader, scope: ControlScope, runId: string, value: unknown, signal?: AbortSignal) {
  try {
    const input = v.parse(fileReadInputSchema, value), auth = await knowledgeAuthority(env, read, scope, runId);
    if (!auth) return { status: 'unavailable' as const, canSend: false as const, document: null };
    const knowledgeScope = await aiKnowledgeScope(auth.db, scope, auth.run), files = await readKnowledgeVirtualFiles(auth.db, scope.organizationId, knowledgeScope);
    const document = readKnowledgeVirtualFile(files, input.path, input.startLine, input.lineCount);
    if (!document) return { status: 'empty' as const, canSend: false as const, document: null };
    signal?.throwIfAborted();
    const recorded = await recordAiDocumentRead(env, read, scope, runId, {
      documentId: document.documentId, revision: document.revision, contentHash: document.contentHash,
      title: document.title, excerpt: document.content.slice(0, 8192),
    });
    if (recorded.status !== 'found') return { status: recorded.status, canSend: false as const, document: null };
    if (!await knowledgeAuthority(env, read, scope, runId)) return { status: 'unconfirmed' as const, canSend: false as const, document: null };
    return { status: 'found' as const, canSend: false as const, document };
  } catch { return { status: 'unconfirmed' as const, canSend: false as const, document: null }; }
}
export type RunKnowledgeEvidence = { raw: string; scope: RetrievalScope; questionHash: string; profile: string };
/** One durable evidence record per run; historical chunk evidence stays readable but is not reused. */
export async function readRunKnowledgeEvidence(db: D1Database, runId: string) {
  const row = await db.prepare(`SELECT documents AS raw,scope,question_hash AS questionHash,profile FROM ai_document_evidence WHERE run_id=?`)
    .bind(runId).first<{ raw: string; scope: string; questionHash: string; profile: string }>();
  if (!row) return null;
  const scope = v.safeParse(retrievalScopeSchema, JSON.parse(row.scope));
  return scope.success && /^[0-9a-f]{64}$/.test(row.questionHash) ? { ...row, scope: scope.output } : null;
}
