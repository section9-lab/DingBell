import * as v from 'valibot';
import { knowledgeHash } from '../knowledge/content.ts';
import type { ControlScope } from '../conversations/control-types.ts';
import { SUPPORT_REPLY_V2 } from '../../shared/ai-versions.ts';
import { readAiProductContext, type AiProductContext } from './product.ts';
import { readAiOrderContext, type AiOrderContext } from './order.ts';
import { readAiExecution } from './storage.ts';

const uuid = v.pipe(v.string(), v.uuid());
const hash = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
const kindSchema = v.picklist(['product', 'order']);
const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(256));

export type AiFactKind = v.InferOutput<typeof kindSchema>;
export type AiFactEvidence = {
  id: string; kind: AiFactKind; ref: string; snapshotHash: string; snapshot: string; observedAt: number;
};
type FactResult<T> = { context: T; evidenceId: string | null };

const row = v.strictObject({
  id: uuid, kind: kindSchema, ref: identifier,
  snapshotHash: hash, snapshot: v.pipe(v.string(), v.maxLength(65536)), observedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

async function ensureFact(db: D1Database, value: {
  runId: string; organizationId: string; storeId: string; conversationId: string;
  kind: AiFactKind; ref: string; snapshotHash: string; snapshot: string;
}) {
  const id = crypto.randomUUID(), now = Date.now();
  await db.prepare(`INSERT INTO ai_fact_evidence(id,run_id,organization_id,store_id,conversation_id,kind,ref,snapshot_hash,snapshot,observed_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,kind,ref,snapshot_hash) DO NOTHING`)
    .bind(id, value.runId, value.organizationId, value.storeId, value.conversationId, value.kind, value.ref, value.snapshotHash, value.snapshot, now, now).run();
  const saved = await db.prepare(`SELECT id FROM ai_fact_evidence WHERE run_id=? AND kind=? AND ref=? AND snapshot_hash=?`)
    .bind(value.runId, value.kind, value.ref, value.snapshotHash).first<{ id: string }>();
  return saved?.id ?? null;
}

async function live(env: { DB?: D1Database }, scope: ControlScope, runId: string) {
  if (!env.DB) return null;
  const execution = await readAiExecution(env.DB, scope, runId);
  if (!execution || execution.closure || Date.now() >= execution.payload.run.deadlineAt) return null;
  return execution.config.model.promptVersion === SUPPORT_REPLY_V2 ? execution : null;
}

/** Freeze one product read for this run. The model receives an opaque id, never a scope. */
export async function recordAiProductFact(env: { DB?: D1Database }, scope: ControlScope, runId: string): Promise<FactResult<AiProductContext>> {
  const empty = (context: AiProductContext): FactResult<AiProductContext> => ({ context, evidenceId: null });
  const execution = await live(env, scope, runId);
  if (!execution) return empty(await readAiProductContext(env, scope, runId));
  const context = await readAiProductContext(env, scope, runId);
  if (context.status !== 'matched' || !context.sku) return empty(context);
  const snapshot = JSON.stringify(context), snapshotHash = await knowledgeHash(context);
  const evidenceId = await ensureFact(env.DB!, { runId, organizationId: scope.organizationId, storeId: scope.storeId, conversationId: scope.conversationId, kind: 'product', ref: context.sku, snapshotHash, snapshot });
  if (!evidenceId) return empty(context);
  const confirmed = await readAiProductContext(env, scope, runId);
  return JSON.stringify(confirmed) === snapshot ? { context: confirmed, evidenceId } : empty(confirmed);
}

/** Freeze one order read for this run. Order data stays limited to imported snapshots. */
export async function recordAiOrderFact(env: { DB?: D1Database }, scope: ControlScope, runId: string): Promise<FactResult<AiOrderContext>> {
  const empty = (context: AiOrderContext): FactResult<AiOrderContext> => ({ context, evidenceId: null });
  const execution = await live(env, scope, runId);
  if (!execution) return empty(await readAiOrderContext(env, scope, runId));
  const context = await readAiOrderContext(env, scope, runId);
  if (context.status !== 'matched' || !context.orderNumber) return empty(context);
  const snapshot = JSON.stringify(context), snapshotHash = await knowledgeHash(context);
  const evidenceId = await ensureFact(env.DB!, { runId, organizationId: scope.organizationId, storeId: scope.storeId, conversationId: scope.conversationId, kind: 'order', ref: context.orderNumber, snapshotHash, snapshot });
  if (!evidenceId) return empty(context);
  const confirmed = await readAiOrderContext(env, scope, runId);
  return JSON.stringify(confirmed) === snapshot ? { context: confirmed, evidenceId } : empty(confirmed);
}

/** Load only facts this exact run recorded in this exact tenant. */
export async function loadAiFactEvidence(db: D1Database, scope: ControlScope, runId: string, ids: readonly string[]): Promise<AiFactEvidence[] | null> {
  const unique = [...new Set(ids)];
  if (!unique.length || unique.length !== ids.length || unique.some(id => !v.is(uuid, id))) return null;
  const placeholders = unique.map(() => '?').join(',');
  const rows = (await db.prepare(`SELECT id,kind,ref,snapshot_hash AS snapshotHash,snapshot,observed_at AS observedAt FROM ai_fact_evidence
    WHERE run_id=? AND organization_id=? AND store_id=? AND conversation_id=? AND id IN (${placeholders})`)
    .bind(runId, scope.organizationId, scope.storeId, scope.conversationId, ...unique).all<AiFactEvidence>()).results;
  if (rows.length !== unique.length) return null;
  return rows.map(value => v.parse(row, value)) as AiFactEvidence[];
}

/** A fact read is evidence only while the same imported snapshot is still current. */
export async function revalidateAiFactEvidence(env: { DB?: D1Database }, scope: ControlScope, runId: string, evidence: readonly AiFactEvidence[], allowClosed: boolean) {
  for (const item of evidence) {
    const context = item.kind === 'product'
      ? await readAiProductContext(env, scope, runId, { allowClosed })
      : await readAiOrderContext(env, scope, runId, { allowClosed });
    if (context.status !== 'matched' || JSON.stringify(context) !== item.snapshot || await knowledgeHash(context) !== item.snapshotHash) return false;
    const ref = item.kind === 'product' ? (context as AiProductContext).sku : (context as AiOrderContext).orderNumber;
    if (ref !== item.ref) return false;
  }
  return true;
}
