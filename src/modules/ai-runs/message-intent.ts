import { NOW_MS } from '../../platform/database/sql.ts';
import * as v from 'valibot';
import { aiRunSchema, aiScopeSchema } from '../conversations/ai-state.ts';
import type { ControlScope } from '../conversations/control-types.ts';
import { knowledgeHash } from '../knowledge/content.ts';
import { resolveTextKnowledgeDocuments } from '../knowledge/text-profile.ts';
import { SUPPORT_REPLY_V2 } from '../../shared/ai-versions.ts';
import { aiSendMessageInputSchema } from '../conversations/send-message-tool.ts';
import { replyBodySchema } from '../conversations/control-state.ts';
import { aiDocumentEvidenceSchema, aiKnowledgeScope, type AiKnowledgeBindings } from './knowledge.ts';
import { readRunKnowledgeEvidence } from './text-knowledge.ts';
import { loadAiFactEvidence, revalidateAiFactEvidence, type AiFactEvidence } from './fact-evidence.ts';
import { currentPayload, readAiExecution, type AiRunReader } from './storage.ts';

type Bindings = AiKnowledgeBindings & { AI_OUTBOUND_ENABLED?: string; OUTBOUND_ENABLED?: string };
type ReviewMode = 'live' | 'completed';
const enabled = (env: Bindings) => !!env.DB && env.AI_OUTBOUND_ENABLED === 'true' && env.OUTBOUND_ENABLED === 'true';
const now = NOW_MS;
const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const uuid = v.pipe(v.string(), v.uuid());
const hash = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
const result = (status: 'prepared' | 'conflict' | 'unavailable' | 'unconfirmed', intentId: string | null = null) => ({ status, intentId, canSend: false as const, sent: false as const });
const from = `ai_execution e
 JOIN store s ON s.id=e.store_id AND s.organization_id=e.organization_id
 JOIN conversation c ON c.id=e.conversation_id AND c.store_id=e.store_id AND c.organization_id=e.organization_id
 JOIN ai_budget b ON b.id=e.budget_id AND b.organization_id=e.organization_id JOIN (SELECT ? AS value) plan`;
const eligible = (mode: ReviewMode) => `e.id=? AND e.payload=plan.value AND e.payload_hash=?
 AND ${mode === 'live' ? 'e.closure IS NULL' : `e.closure=? AND e.receipt=? AND e.generations>0
  AND e.generations=(SELECT COUNT(*) FROM ai_generation WHERE run_id=e.id)
  AND NOT EXISTS (SELECT 1 FROM ai_generation WHERE run_id=e.id AND (usage IS NULL OR charged_micros IS NULL OR settled_at IS NULL))`}
 AND json_extract(e.config,'$.model.promptVersion')='${SUPPORT_REPLY_V2}' AND ${currentPayload}
 AND s.outbound_enabled=1 AND s.status IN ('verified','partial','attention') AND s.platform='ozon'
 AND length(s.platform_store_id)>0 AND length(c.platform_thread_id)>0 AND s.credential_version>0
 AND length(s.credential_key_version)>0 AND length(s.credential_nonce)>0 AND length(s.credential_ciphertext)>0 AND s.expires_at>${now}
 AND EXISTS (SELECT 1 FROM json_each(s.capabilities)
  WHERE json_extract(value,'$.code')='auth' AND json_extract(value,'$.status')='available')
 AND b.enabled=1 AND b.starts_at<=${now} AND b.ends_at>${now} AND b.spent_micros<=b.limit_micros AND b.reserved_micros<=b.limit_micros-b.spent_micros
 AND ? IS (SELECT CASE WHEN COUNT(DISTINCT alias.product_id)=1 THEN MIN(alias.product_id) END
  FROM message m JOIN product_sku alias ON alias.organization_id=m.organization_id AND alias.store_id=m.store_id AND alias.sku=m.sku
  WHERE m.id=json_extract(plan.value,'$.run.request.messageId') AND m.organization_id=e.organization_id AND m.store_id=e.store_id AND m.conversation_id=e.conversation_id)
 AND (?=0 OR EXISTS (SELECT 1 FROM ai_document_evidence d WHERE d.run_id=e.id AND d.organization_id=e.organization_id AND d.documents=? AND d.scope=? AND d.question_hash=?))`;
type Channel = { platformStoreId: string; platformThreadId: string; credentialVersion: number };
const savedReplySchema = v.strictObject({
  id: identifier, body: replyBodySchema, bodyHash: hash,
  citations: v.pipe(v.array(uuid), v.maxLength(10)),
  facts: v.pipe(v.array(v.strictObject({ id: uuid, kind: v.picklist(['product', 'order']), ref: identifier, snapshotHash: hash })), v.maxLength(10)),
  knowledgeEvidence: v.nullable(aiDocumentEvidenceSchema),
  platformStoreId: identifier, platformThreadId: identifier,
  credentialVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  promptVersion: v.literal(SUPPORT_REPLY_V2),
});
type SavedReply = v.InferOutput<typeof savedReplySchema>;

async function authority(env: Bindings, read: AiRunReader, scope: ControlScope, id: string, mode: ReviewMode, citations: readonly string[], factIds: readonly string[]) {
  if (!enabled(env)) return null;
  const db = env.DB!, execution = await readAiExecution(db, scope, id);
  if (!execution || execution.config.model.promptVersion !== SUPPORT_REPLY_V2) return null;
  if (mode === 'live' ? execution.closure !== null : execution.closure?.kind !== 'runtime_closed' || execution.closure.outcome !== 'completed'
    || execution.status !== 'settled' || execution.remainingReservedMicros !== 0 || !execution.receipt || !execution.generations.length
    || execution.generations.some(g => g.usage === null || g.chargedMicros === null || g.settledAt === null)) return null;
  const run = v.parse(aiRunSchema, execution.payload.run);
  const knowledgeScope = await aiKnowledgeScope(db, scope, run);
  const saved = await readRunKnowledgeEvidence(db, id);
  let evidence: v.InferOutput<typeof aiDocumentEvidenceSchema> | null = null, rawEvidence: string | null = null;
  if (saved) {
    const parsedEvidence = v.parse(aiDocumentEvidenceSchema, { runId: id, scope: saved.scope, questionHash: saved.questionHash, documents: JSON.parse(saved.raw) });
    evidence = parsedEvidence; rawEvidence = saved.raw;
    if (!parsedEvidence.documents.length || new Set(parsedEvidence.documents.map(d => d.documentId)).size !== parsedEvidence.documents.length
      || parsedEvidence.runId !== id || parsedEvidence.scope.storeId !== scope.storeId || parsedEvidence.scope.language !== run.admission.language || parsedEvidence.scope.productRef !== knowledgeScope.productRef
      || JSON.stringify(parsedEvidence.scope) !== JSON.stringify(saved.scope) || parsedEvidence.questionHash !== saved.questionHash
      || parsedEvidence.questionHash !== await knowledgeHash(run.admission.question)) return null;
    if (!citations.every(key => parsedEvidence.documents.some(document => document.documentId === key))) return null;
  } else if (citations.length) return null;
  const facts = factIds.length ? await loadAiFactEvidence(db, scope, id, factIds) : [];
  if (!facts || (!evidence && !facts.length)) return null;
  const documentEvidence = evidence;
  const payloadHash = await knowledgeHash({ payload: execution.payload, config: execution.config });
  const documentCount = citations.length ? 1 : 0;
  const bound = [JSON.stringify(execution.payload), id, payloadHash,
    ...(mode === 'completed' ? [JSON.stringify(execution.closure), JSON.stringify(execution.receipt)] : []),
    knowledgeScope.productRef, documentCount, documentEvidence ? rawEvidence : '[]', documentEvidence ? JSON.stringify(documentEvidence.scope) : '{}', documentEvidence?.questionHash ?? '0'.repeat(64)];
  const current = async () => {
    if (!enabled(env) || Date.now() >= run.deadlineAt || JSON.stringify(await read({ ...scope }, id)) !== JSON.stringify(run)) return null;
    return db.prepare(`SELECT s.platform_store_id AS platformStoreId,c.platform_thread_id AS platformThreadId,s.credential_version AS credentialVersion FROM ${from} WHERE ${eligible(mode)}`).bind(...bound).first<Channel>();
  };
  const channel = await current(); if (!channel) return null;
  if (documentEvidence) {
    const resolved = await resolveTextKnowledgeDocuments(db, scope.organizationId, documentEvidence.scope, documentEvidence.documents);
    if (!resolved || resolved.some((row, i) => row.documentId !== documentEvidence.documents[i]!.documentId
      || row.revision !== documentEvidence.documents[i]!.revision || row.contentHash !== documentEvidence.documents[i]!.contentHash)) return null;
  }
  if (facts.length && !await revalidateAiFactEvidence(env, scope, id, facts, mode === 'completed')) return null;
  if (JSON.stringify(await current()) !== JSON.stringify(channel)) return null;
  return { run, evidence, rawEvidence, facts, payloadHash, channel, current };
}

async function saved(db: D1Database, id: string): Promise<SavedReply | null> {
  const row = await db.prepare('SELECT reply FROM ai_execution WHERE id=?').bind(id).first<{ reply: string | null }>();
  if (!row?.reply) return null;
  const parsed = v.safeParse(savedReplySchema, JSON.parse(row.reply));
  return parsed.success ? parsed.output : null;
}

/** Immutable v2 preparation with document and/or product/order fact evidence. */
export async function prepareAiMessage(env: Bindings, read: AiRunReader, scope: ControlScope, id: string, value: unknown) {
  let attempted = false;
  try {
    scope = v.parse(aiScopeSchema, scope);
    const input = v.parse(aiSendMessageInputSchema, structuredClone(value)), c = await authority(env, read, scope, id, 'live', input.citations, input.facts);
    if (!c) return result('unavailable');
    const bodyHash = await knowledgeHash(input.body), intentId = 'ai-reply:' + id;
    if (!enabled(env)) return result('unavailable'); attempted = true;
    const reply = JSON.stringify({
      id: intentId, body: input.body, bodyHash, citations: input.citations,
      facts: c.facts.map(({ id, kind, ref, snapshotHash }) => ({ id, kind, ref, snapshotHash })),
      knowledgeEvidence: c.evidence,
      platformStoreId: c.channel.platformStoreId, platformThreadId: c.channel.platformThreadId, credentialVersion: c.channel.credentialVersion,
      promptVersion: SUPPORT_REPLY_V2,
    });
    await env.DB!.prepare('UPDATE ai_execution SET reply=? WHERE id=? AND payload_hash=? AND reply IS NULL').bind(reply, id, c.payloadHash).run();
    const confirmed = await reviewAiMessage(env, read, scope, id);
    if (!confirmed) return result('unavailable');
    const same = confirmed.body === input.body && JSON.stringify(confirmed.citations) === JSON.stringify(input.citations)
      && JSON.stringify(confirmed.facts.map(fact => fact.id).sort()) === JSON.stringify([...input.facts].sort());
    return result(same ? 'prepared' : 'conflict', confirmed.id);
  } catch { return result(attempted ? 'unconfirmed' : 'unavailable', attempted ? 'ai-reply:' + id : null); }
}

async function review(env: Bindings, read: AiRunReader, scope: ControlScope, id: string, mode: ReviewMode) {
  try {
    scope = v.parse(aiScopeSchema, scope);
    const reply = await saved(env.DB!, id);
    if (!reply || reply.id !== 'ai-reply:' + id) return null;
    const c = await authority(env, read, scope, id, mode, reply.citations, reply.facts.map(fact => fact.id));
    if (!c) return null;
    const input = v.parse(aiSendMessageInputSchema, { body: reply.body, citations: reply.citations, facts: reply.facts.map(fact => fact.id) });
    if (reply.platformStoreId !== c.channel.platformStoreId || reply.platformThreadId !== c.channel.platformThreadId || reply.credentialVersion !== c.channel.credentialVersion) return null;
    if (await knowledgeHash(input.body) !== reply.bodyHash) return null;
    const currentIds = c.facts.map(fact => fact.id).sort(), savedIds = reply.facts.map(fact => fact.id).sort();
    if (JSON.stringify(currentIds) !== JSON.stringify(savedIds)) return null;
    if (reply.knowledgeEvidence && (!c.evidence || JSON.stringify(reply.knowledgeEvidence) !== JSON.stringify(c.evidence))) return null;
    return { ...input, id: reply.id, runId: id, run: c.run, origin: 'ai' as const, actorUserId: null, actorMemberId: null, payloadHash: c.payloadHash,
      bodyHash: reply.bodyHash, knowledgeEvidence: c.evidence, facts: c.facts as AiFactEvidence[],
      platformStoreId: reply.platformStoreId, platformThreadId: reply.platformThreadId, credentialVersion: reply.credentialVersion, createdAt: 0, canSend: false as const };
  } catch { return null; }
}
/** Live-run eligibility only; closing the runtime never promotes an unsubmitted draft. */
export function reviewAiMessage(env: Bindings, read: AiRunReader, scope: ControlScope, id: string) {
  return review(env, read, scope, id, 'live');
}
/** A successful, fully settled runtime is still revalidated by the sender's final commit check. */
export function reviewCompletedAiMessage(env: Bindings, read: AiRunReader, scope: ControlScope, id: string) {
  return review(env, read, scope, id, 'completed');
}
