import * as v from 'valibot';
import { readAiExecution } from './storage.ts';
import type { ControlScope } from '../conversations/control-types.ts';
import { orderStatusLabel, orderSubstatusLabel } from '../../shared/order-status.ts';
import { SUPPORT_KNOWLEDGE_VERSIONS } from '../../shared/ai-versions.ts';

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const orderVersions = SUPPORT_KNOWLEDGE_VERSIONS;
const MAX_POSTINGS = 5;

/**
 * Order facts are merchant data, not instructions. The model cannot name an order: the
 * number comes from the message that started this run, or from the most recent inbound
 * message in the same conversation, and must resolve to exactly one order in this store.
 */
export const aiOrderContextSchema = v.pipe(v.strictObject({
  status: v.picklist(['matched', 'not_provided', 'not_imported', 'ambiguous', 'unavailable', 'unconfirmed']),
  orderNumber: v.nullable(identifier),
  resolvedFrom: v.nullable(v.picklist(['message', 'conversation'])),
  order: v.nullable(v.strictObject({
    orderId: identifier,
    postings: v.pipe(v.array(v.strictObject({
      postingNumber: identifier,
      fulfillment: v.picklist(['fbs', 'fbo', 'fbp']),
      statusLabel: v.pipe(v.string(), v.maxLength(64)),
      substatusLabel: v.nullable(v.pipe(v.string(), v.maxLength(64))),
      trackingNumber: v.nullable(v.pipe(v.string(), v.maxLength(128))),
      productCount: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10_000))),
      observedAt: v.nullable(v.pipe(v.string(), v.maxLength(64))),
    })), v.maxLength(MAX_POSTINGS)),
  })),
  canSend: v.literal(false),
}), v.check(row => row.status === 'matched' ? row.order !== null : row.order === null));

export type AiOrderContext = v.InferOutput<typeof aiOrderContextSchema>;

const nothing = (status: 'not_provided' | 'not_imported' | 'ambiguous' | 'unavailable' | 'unconfirmed',
  orderNumber: string | null = null, resolvedFrom: 'message' | 'conversation' | null = null): AiOrderContext =>
  ({ status, orderNumber, resolvedFrom, order: null, canSend: false });
const at = (value: number | null) => value === null ? null : new Date(value).toISOString();

interface PostingRow {
  orderId: string; postingNumber: string; fulfillment: 'fbs' | 'fbo' | 'fbp';
  status: string | null; statusIsCode: number | null; substatus: string | null;
  trackingNumber: string | null; productCount: number | null; observedAt: number;
}

/**
 * Reads only imported order snapshots for the frozen conversation. Quantities of parcels and
 * missing fields stay explicit: an unimported or ambiguous order is never presented as fact.
 */
export async function readAiOrderContext(env: { DB?: D1Database }, scope: ControlScope, runId: string, options: { allowClosed?: boolean } = {}): Promise<AiOrderContext> {
  const db = env.DB;
  if (!db) return nothing('unavailable');
  const execution = await readAiExecution(db, scope, runId);
  if (!execution || (execution.closure && !options.allowClosed)) return nothing('unavailable');
  if (!options.allowClosed && Date.now() >= execution.payload.run.deadlineAt) return nothing('unavailable');
  if (execution.payload.run.schemaVersion === 2) return nothing('unavailable');
  if (!orderVersions.includes(execution.config.model.promptVersion as typeof orderVersions[number])) return nothing('unavailable');
  if (JSON.stringify(execution.payload.run.scope) !== JSON.stringify(scope)) return nothing('unconfirmed');

  const messageId = execution.payload.run.request.messageId;
  const bounds = [scope.organizationId, scope.storeId, scope.conversationId];
  const direct = await db.prepare(`SELECT order_number AS orderNumber FROM message
    WHERE id=? AND organization_id=? AND store_id=? AND conversation_id=?`)
    .bind(messageId, ...bounds).first<{ orderNumber: string | null }>();
  if (!direct) return nothing('unavailable');

  let orderNumber = direct.orderNumber, resolvedFrom: 'message' | 'conversation' = 'message';
  if (orderNumber === null) {
    const recent = await db.prepare(`SELECT order_number AS orderNumber FROM message
      WHERE organization_id=? AND store_id=? AND conversation_id=? AND direction='inbound' AND order_number IS NOT NULL
      ORDER BY event_at DESC, id DESC LIMIT 1`).bind(...bounds).first<{ orderNumber: string }>();
    if (!recent) return nothing('not_provided');
    orderNumber = recent.orderNumber; resolvedFrom = 'conversation';
  }

  // Two statements observe the same snapshot: identity and parcels cannot disagree.
  const results = await db.batch([
    db.prepare(`SELECT DISTINCT order_id AS orderId FROM commerce_posting
      WHERE organization_id=? AND store_id=? AND order_number=? ORDER BY order_id LIMIT 2`)
      .bind(scope.organizationId, scope.storeId, orderNumber),
    db.prepare(`WITH snapshots AS (
        SELECT *,CASE WHEN detail_facts IS NOT NULL AND (list_facts IS NULL OR detail_observed_at>=list_observed_at) THEN detail_facts
          ELSE list_facts END AS facts,
          CASE WHEN detail_facts IS NOT NULL AND (list_facts IS NULL OR detail_observed_at>=list_observed_at) THEN detail_observed_at
          ELSE list_observed_at END AS observedAt
        FROM commerce_posting WHERE organization_id=? AND store_id=? AND order_number=?
      ) SELECT order_id AS orderId,posting_number AS postingNumber,fulfillment_type AS fulfillment,
        json_extract(facts,'$.status') AS status,json_extract(facts,'$.statusIsCode') AS statusIsCode,
        json_extract(facts,'$.substatus') AS substatus,json_extract(facts,'$.trackingNumber') AS trackingNumber,
        CASE WHEN json_type(facts,'$.products')='array' THEN json_array_length(facts,'$.products') ELSE NULL END AS productCount,
        observedAt FROM snapshots WHERE facts IS NOT NULL
      ORDER BY posting_number,fulfillment_type LIMIT ${MAX_POSTINGS}`)
      .bind(scope.organizationId, scope.storeId, orderNumber),
  ]);
  const identities = results[0]!.results as unknown as { orderId: string }[];
  if (identities.length === 0) return nothing('not_imported', orderNumber, resolvedFrom);
  if (identities.length > 1) return nothing('ambiguous', orderNumber, resolvedFrom);

  const orderId = identities[0]!.orderId;
  const postings = (results[1]!.results as unknown as PostingRow[]).filter(row => row.orderId === orderId);
  if (postings.length === 0) return nothing('not_imported', orderNumber, resolvedFrom);
  return {
    status: 'matched', orderNumber, resolvedFrom, canSend: false,
    order: {
      orderId,
      postings: postings.map(row => ({
        postingNumber: row.postingNumber, fulfillment: row.fulfillment,
        statusLabel: orderStatusLabel({ status: row.status, statusIsCode: row.statusIsCode === 1, substatus: row.substatus }),
        substatusLabel: orderSubstatusLabel(row.substatus),
        trackingNumber: row.trackingNumber, productCount: row.productCount, observedAt: at(row.observedAt),
      })),
    },
  };
}
