import * as v from 'valibot';
import { readAiExecution } from './storage.ts';
import type { ControlScope } from '../conversations/control-types.ts';
import { safeImage } from '../conversations/context.ts';
import { SUPPORT_KNOWLEDGE_VERSIONS, SUPPORT_REPLY_V3 } from '../../shared/ai-versions.ts';

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const snapshotTime = v.pipe(v.string(), v.maxLength(64));
/** Product facts are merchant data, not instructions; scope and identity are resolved by the application. */
const productVersions = SUPPORT_KNOWLEDGE_VERSIONS;
const availabilitySchema = v.picklist(['in_stock', 'out_of_stock', 'unknown']);
const profileStatusSchema = v.picklist(['complete', 'partial', 'unavailable']);
const missingFieldSchema = v.picklist(['description', 'attributes', 'dimensions', 'weight', 'images', 'stock']);
const attributeSchema = v.strictObject({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  value: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
});

/** v2 is frozen: in-flight runs must keep the exact surface they were admitted with. */
export const aiProductContextV2Schema = v.pipe(v.strictObject({
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

/**
 * v3 is the customer-safe service profile. It deliberately omits internal product IDs, offer IDs,
 * sourcing and costing. It contains only facts a buyer can already see on the public listing.
 */
export const aiProductContextV3Schema = v.pipe(v.strictObject({
  status: v.picklist(['matched', 'not_provided', 'not_imported', 'ambiguous', 'unavailable', 'unconfirmed']),
  sku: v.nullable(identifier),
  resolvedFrom: v.nullable(v.picklist(['message', 'conversation'])),
  product: v.nullable(v.strictObject({
    name: v.nullable(v.pipe(v.string(), v.maxLength(4096))),
    price: v.nullable(v.pipe(v.string(), v.maxLength(64))),
    currency: v.nullable(v.pipe(v.string(), v.maxLength(16))),
    archived: v.nullable(v.boolean()),
    availability: availabilitySchema,
    stockObservedAt: v.nullable(snapshotTime),
    description: v.nullable(v.pipe(v.string(), v.maxLength(4000))),
    attributes: v.pipe(v.array(attributeSchema), v.maxLength(40)),
    dimensions: v.nullable(v.strictObject({
      length: v.pipe(v.number(), v.finite(), v.minValue(0)),
      width: v.pipe(v.number(), v.finite(), v.minValue(0)),
      height: v.pipe(v.number(), v.finite(), v.minValue(0)),
      unit: v.pipe(v.string(), v.minLength(1), v.maxLength(8)),
    })),
    weight: v.nullable(v.strictObject({
      value: v.pipe(v.number(), v.finite(), v.minValue(0)),
      unit: v.pipe(v.string(), v.minLength(1), v.maxLength(8)),
    })),
    images: v.pipe(v.array(v.pipe(v.string(), v.maxLength(2048))), v.maxLength(10)),
    createdAt: v.nullable(snapshotTime),
    observedAt: v.nullable(snapshotTime),
    profileStatus: profileStatusSchema,
    missingFields: v.pipe(v.array(missingFieldSchema), v.maxLength(6)),
  })),
  canSend: v.literal(false),
}), v.check(row => row.status === 'matched' ? row.product !== null : row.product === null));

export const aiProductContextSchema = v.union([aiProductContextV2Schema, aiProductContextV3Schema]);
export type AiProductContextV2 = v.InferOutput<typeof aiProductContextV2Schema>;
export type AiProductContextV3 = v.InferOutput<typeof aiProductContextV3Schema>;
export type AiProductContext = AiProductContextV2 | AiProductContextV3;

interface ProductRowV2 {
  id: string; offerId: string | null; name: string | null; price: string | null; currency: string | null;
  archived: number | null; primaryImage: string | null;
  skuSource: 'list' | 'details' | 'both'; listObservedAt: number; factsObservedAt: number | null;
}
interface ProductRowV3 {
  name: string | null; price: string | null; currency: string | null;
  archived: number | null; primaryImage: string | null; images: string | null; createdAt: string | null;
  stockHasStock: number | null; stockObservedAt: number | null;
  listObservedAt: number; factsObservedAt: number | null;
  description: string | null; attributesJSON: string | null;
  lengthMm: number | null; widthMm: number | null; heightMm: number | null; dimensionUnit: string | null;
  weightG: number | null; weightUnit: string | null;
  descriptionState: string | null; attributesState: string | null; profileObservedAt: number | null;
}

type NothingStatus = 'not_provided' | 'not_imported' | 'ambiguous' | 'unavailable' | 'unconfirmed';
const nothing = (status: NothingStatus, sku: string | null = null, resolvedFrom: 'message' | 'conversation' | null = null): AiProductContext =>
  ({ status, sku, resolvedFrom, product: null, canSend: false });
const at = (value: number | null) => value === null ? null : new Date(value).toISOString();

/** Resolve only the admitted message's SKU, or the most recent inbound SKU in the same conversation. */
async function resolveSku(db: D1Database, scope: ControlScope, messageId: string):
  Promise<{ status: 'matched'; sku: string; resolvedFrom: 'message' | 'conversation' } | { status: 'not_provided' | 'unavailable' }> {
  const bounds = [scope.organizationId, scope.storeId, scope.conversationId];
  const direct = await db.prepare(`SELECT sku FROM message
    WHERE id=? AND organization_id=? AND store_id=? AND conversation_id=?`)
    .bind(messageId, ...bounds).first<{ sku: string | null }>();
  if (!direct) return { status: 'unavailable' };
  if (direct.sku !== null) return { status: 'matched', sku: direct.sku, resolvedFrom: 'message' };
  const recent = await db.prepare(`SELECT sku FROM message
    WHERE organization_id=? AND store_id=? AND conversation_id=? AND direction='inbound' AND sku IS NOT NULL
    ORDER BY event_at DESC, id DESC LIMIT 1`).bind(...bounds).first<{ sku: string }>();
  return recent ? { status: 'matched', sku: recent.sku, resolvedFrom: 'conversation' } : { status: 'not_provided' };
}

function imageList(raw: string | null, primary: string | null) {
  const parsed = (() => {
    if (!raw) return [];
    try { const value: unknown = JSON.parse(raw); return Array.isArray(value) ? value : []; } catch { return []; }
  })();
  const images = parsed.map(value => typeof value === 'string' ? safeImage(value) : null)
    .filter((value): value is string => value !== null);
  const main = safeImage(primary);
  return (main && !images.includes(main) ? [main, ...images] : images).slice(0, 10);
}

function attributeList(raw: string | null) {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      if (typeof row.name !== 'string' || typeof row.value !== 'string') return [];
      const name = row.name.trim().slice(0, 120), text = row.value.trim().slice(0, 1000);
      return name && text ? [{ name, value: text }] : [];
    }).slice(0, 40);
  } catch { return []; }
}

function positive(value: number | null) {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

function profileStatus(descriptionState: string | null, attributesState: string | null) {
  if (descriptionState === null && attributesState === null) return 'unavailable' as const;
  return descriptionState === 'complete' && attributesState === 'complete' ? 'complete' as const : 'partial' as const;
}

function readV3(row: ProductRowV3): AiProductContextV3 {
  const images = imageList(row.images, row.primaryImage);
  const attributes = attributeList(row.attributesJSON);
  const length = positive(row.lengthMm), width = positive(row.widthMm), height = positive(row.heightMm);
  const weight = positive(row.weightG);
  const dimensions = length !== null && width !== null && height !== null && row.dimensionUnit
    ? { length, width, height, unit: row.dimensionUnit }
    : null;
  const observedAt = at(row.profileObservedAt ?? row.factsObservedAt ?? row.listObservedAt);
  const availability = row.stockObservedAt === null ? 'unknown' as const
    : row.stockHasStock === 1 ? 'in_stock' as const
      : row.stockHasStock === 0 ? 'out_of_stock' as const : 'unknown' as const;
  const description = row.description?.trim().slice(0, 4000) || null;
  const missingFields: ('description' | 'attributes' | 'dimensions' | 'weight' | 'images' | 'stock')[] = [];
  if (!description) missingFields.push('description');
  if (!attributes.length) missingFields.push('attributes');
  if (!dimensions) missingFields.push('dimensions');
  if (weight === null || !row.weightUnit) missingFields.push('weight');
  if (!images.length) missingFields.push('images');
  if (availability === 'unknown') missingFields.push('stock');
  const archived = row.archived === null ? null : !!row.archived;
  return {
    status: 'matched', sku: '', resolvedFrom: null, canSend: false,
    product: {
      name: row.name, price: row.price, currency: row.currency, archived, availability,
      stockObservedAt: at(row.stockObservedAt), description, attributes, dimensions,
      weight: weight !== null && row.weightUnit ? { value: weight, unit: row.weightUnit } : null,
      images, createdAt: row.createdAt, observedAt,
      profileStatus: profileStatus(row.descriptionState, row.attributesState), missingFields,
    },
  };
}

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

  const resolved = await resolveSku(db, scope, execution.payload.run.request.messageId);
  if (resolved.status !== 'matched') return nothing(resolved.status);

  if (execution.config.model.promptVersion === SUPPORT_REPLY_V3) {
    const rows = (await db.prepare(`SELECT json_extract(product.facts,'$.name') AS name,
        json_extract(product.facts,'$.price') AS price,json_extract(product.facts,'$.currency') AS currency,
        COALESCE(json_extract(product.facts,'$.archived'),json_extract(product.listing,'$.archived')) AS archived,
        json_extract(product.facts,'$.primaryImage') AS primaryImage,json_extract(product.facts,'$.images') AS images,
        json_extract(product.facts,'$.createdAt') AS createdAt,
        product.stock_has_stock AS stockHasStock,product.stock_observed_at AS stockObservedAt,
        product.list_observed_at AS listObservedAt,product.facts_observed_at AS factsObservedAt,
        profile.description,profile.attributes_json AS attributesJSON,
        profile.length_mm AS lengthMm,profile.width_mm AS widthMm,profile.height_mm AS heightMm,profile.dimension_unit AS dimensionUnit,
        profile.weight_g AS weightG,profile.weight_unit AS weightUnit,
        profile.description_state AS descriptionState,profile.attributes_state AS attributesState,profile.observed_at AS profileObservedAt
      FROM product_sku AS alias
      JOIN product ON product.id=alias.product_id AND product.store_id=alias.store_id AND product.organization_id=alias.organization_id
      LEFT JOIN product_service_profile profile ON profile.organization_id=product.organization_id AND profile.store_id=product.store_id AND profile.product_id=product.id
      WHERE alias.organization_id=? AND alias.store_id=? AND alias.sku=?
      GROUP BY product.id ORDER BY product.id LIMIT 2`)
      .bind(scope.organizationId, scope.storeId, resolved.sku).all<ProductRowV3>()).results;
    if (rows.length === 0) return nothing('not_imported', resolved.sku, resolved.resolvedFrom);
    if (rows.length > 1) return nothing('ambiguous', resolved.sku, resolved.resolvedFrom);
    return { ...readV3(rows[0]!), sku: resolved.sku, resolvedFrom: resolved.resolvedFrom };
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
    .bind(scope.organizationId, scope.storeId, resolved.sku).all<ProductRowV2>()).results;
  if (rows.length === 0) return nothing('not_imported', resolved.sku, resolved.resolvedFrom);
  if (rows.length > 1) return nothing('ambiguous', resolved.sku, resolved.resolvedFrom);

  const row = rows[0]!;
  return {
    status: 'matched', sku: resolved.sku, resolvedFrom: resolved.resolvedFrom, canSend: false,
    product: {
      productId: row.id, offerId: row.offerId, name: row.name, price: row.price, currency: row.currency,
      archived: row.archived === null ? null : !!row.archived, primaryImage: safeImage(row.primaryImage),
      skuSource: row.skuSource, observedAt: at(row.factsObservedAt ?? row.listObservedAt),
    },
  };
}
