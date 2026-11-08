import * as v from 'valibot';
import { readAiExecution } from './storage.ts';
import type { ControlScope } from '../conversations/control-types.ts';
import { safeImage } from '../conversations/context.ts';
import { SUPPORT_KNOWLEDGE_VERSIONS } from '../../shared/ai-versions.ts';

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const snapshotTime = v.pipe(v.string(), v.maxLength(64));
/** Product facts are merchant data, not instructions; scope and identity are resolved by the application. */
const productVersions = SUPPORT_KNOWLEDGE_VERSIONS;

export const aiProductContextSchema = v.pipe(v.strictObject({
  status: v.picklist(['matched', 'not_provided', 'not_imported', 'ambiguous', 'unavailable', 'unconfirmed']),
  sku: v.nullable(identifier),
  resolvedFrom: v.nullable(v.picklist(['message', 'conversation'])),
  product: v.nullable(v.strictObject({
    productId: identifier,
    offerId: v.nullable(identifier),
    name: v.nullable(v.pipe(v.string(), v.maxLength(1024))),
    price: v.nullable(v.pipe(v.string(), v.maxLength(64))),
    currency: v.nullable(v.pipe(v.string(), v.maxLength(16))),
    archived: v.nullable(v.boolean()),
    primaryImage: v.nullable(v.pipe(v.string(), v.maxLength(2048))),
    skuSource: v.picklist(['list', 'details', 'both']),
    observedAt: v.nullable(snapshotTime),
  })),
  canSend: v.literal(false),
}), v.check(row => row.status === 'matched' ? row.product !== null : row.product === null));

export type AiProductContext = v.InferOutput<typeof aiProductContextSchema>;

interface ProductRow {
  id: string; offerId: string | null; name: string | null; price: string | null; currency: string | null;
  archived: number | null; primaryImage: string | null;
  skuSource: 'list' | 'details' | 'both'; listObservedAt: number; factsObservedAt: number | null;
}

const nothing = (status: 'not_provided' | 'not_imported' | 'ambiguous' | 'unavailable' | 'unconfirmed', sku: string | null = null, resolvedFrom: 'message' | 'conversation' | null = null): AiProductContext =>
  ({ status, sku, resolvedFrom, product: null, canSend: false });
const at = (value: number | null) => value === null ? null : new Date(value).toISOString();

/**
 * Resolves the product a customer is asking about from frozen execution state only.
 * The model cannot name a SKU: the item comes from the message that started this run, or,
 * because Ozon attaches a SKU only to the message a chat was opened from, from the most
 * recent inbound message in the same conversation. Order status stays out of this tool.
 */
export async function readAiProductContext(env: { DB?: D1Database }, scope: ControlScope, runId: string, options: { allowClosed?: boolean } = {}): Promise<AiProductContext> {
  const db = env.DB;
  if (!db) return nothing('unavailable');
  const execution = await readAiExecution(db, scope, runId);
  if (!execution || (execution.closure && !options.allowClosed)) return nothing('unavailable');
  if (!options.allowClosed && Date.now() >= execution.payload.run.deadlineAt) return nothing('unavailable');
  if (execution.payload.run.schemaVersion === 2) return nothing('unavailable');
  if (!productVersions.includes(execution.config.model.promptVersion as typeof productVersions[number])) return nothing('unavailable');
  if (JSON.stringify(execution.payload.run.scope) !== JSON.stringify(scope)) return nothing('unconfirmed');

  const messageId = execution.payload.run.request.messageId;
  const bounds = [scope.organizationId, scope.storeId, scope.conversationId];
  const direct = await db.prepare(`SELECT sku FROM message
    WHERE id=? AND organization_id=? AND store_id=? AND conversation_id=?`)
    .bind(messageId, ...bounds).first<{ sku: string | null }>();
  if (!direct) return nothing('unavailable');

  let sku = direct.sku, resolvedFrom: 'message' | 'conversation' = 'message';
  if (sku === null) {
    const recent = await db.prepare(`SELECT sku FROM message
      WHERE organization_id=? AND store_id=? AND conversation_id=? AND direction='inbound' AND sku IS NOT NULL
      ORDER BY event_at DESC, id DESC LIMIT 1`).bind(...bounds).first<{ sku: string }>();
    if (!recent) return nothing('not_provided');
    sku = recent.sku; resolvedFrom = 'conversation';
  }

  const rows = (await db.prepare(`SELECT product.id,
      COALESCE(json_extract(product.facts,'$.offerId'),json_extract(product.listing,'$.offerId')) AS offerId,
      json_extract(product.facts,'$.name') AS name,json_extract(product.facts,'$.price') AS price,
      json_extract(product.facts,'$.currency') AS currency,json_extract(product.facts,'$.archived') AS archived,
      json_extract(product.facts,'$.primaryImage') AS primaryImage,
      product.list_observed_at AS listObservedAt,product.facts_observed_at AS factsObservedAt,
      CASE WHEN MIN(alias.source)!=MAX(alias.source) THEN 'both' ELSE MIN(alias.source) END AS skuSource
    FROM product_sku AS alias
    JOIN product ON product.id=alias.product_id AND product.store_id=alias.store_id AND product.organization_id=alias.organization_id
    WHERE alias.organization_id=? AND alias.store_id=? AND alias.sku=?
    GROUP BY product.id ORDER BY product.id LIMIT 2`)
    .bind(scope.organizationId, scope.storeId, sku).all<ProductRow>()).results;
  if (rows.length === 0) return nothing('not_imported', sku, resolvedFrom);
  if (rows.length > 1) return nothing('ambiguous', sku, resolvedFrom);

  const row = rows[0]!;
  return {
    status: 'matched', sku, resolvedFrom, canSend: false,
    product: {
      productId: row.id, offerId: row.offerId, name: row.name, price: row.price, currency: row.currency,
      archived: row.archived === null ? null : !!row.archived, primaryImage: safeImage(row.primaryImage),
      skuSource: row.skuSource, observedAt: at(row.factsObservedAt ?? row.listObservedAt),
    },
  };
}
