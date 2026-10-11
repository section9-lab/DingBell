import * as v from 'valibot';

const text = (max: number) => v.pipe(v.string(), v.transform(value => value.normalize('NFC').replace(/\r\n?/g, '\n').trim()),
  v.minLength(1), v.maxLength(max), v.check(value => value.isWellFormed() && !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)));
const reference = v.pipe(v.string(), v.minLength(1), v.maxLength(128), v.check(value => !!value.trim() && value.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(value)));
export const knowledgeSourceSchema = v.variant('format', [
  v.strictObject({ format: v.literal('text'), content: text(8192) }),
  v.strictObject({ format: v.literal('markdown'), content: text(8192) }),
  v.strictObject({ format: v.literal('product'), facts: v.pipe(v.array(v.strictObject({ label: text(80), value: text(1000) })), v.minLength(1), v.maxLength(40),
    v.check(facts => new Set(facts.map(fact => fact.label)).size === facts.length)) }),
]);
export const knowledgeDraftSchema = v.pipe(v.strictObject({ title: text(160), source: knowledgeSourceSchema }),
  v.check(value => new TextEncoder().encode(JSON.stringify(value.source)).length <= 8192));
export const knowledgeScopeSchema = v.strictObject({ kind: v.picklist(['product', 'policy', 'guide', 'faq']),
  storeId: v.nullable(reference), productRef: v.nullable(reference), language: v.picklist(['ru', 'zh-CN', 'en']) });
export const knowledgeFiltersSchema = v.strictObject({ kind: v.optional(knowledgeScopeSchema.entries.kind),
  storeId: v.optional(v.nullable(reference)), language: v.optional(knowledgeScopeSchema.entries.language),
  publication: v.optional(v.picklist(['published', 'unpublished'])) });
export type KnowledgeFilters = v.InferOutput<typeof knowledgeFiltersSchema>;
export const knowledgeVersionSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER - 1));
const productId = v.pipe(v.string(), v.regex(/^(0|[1-9][0-9]{0,39})$/));
export const productImportScopeSchema = v.strictObject({ storeId: v.nonNullable(knowledgeScopeSchema.entries.storeId), productId,
  language: knowledgeScopeSchema.entries.language });
export const productImportCommandSchema = v.strictObject({ ...productImportScopeSchema.entries,
  snapshotId: v.pipe(v.string(), v.uuid()), expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER - 1)) });
export const productCatalogSchema = v.strictObject({ storeId: productImportScopeSchema.entries.storeId, after: v.optional(v.union([v.literal(''), productId]), '') });
export type ProductImportScope = v.InferOutput<typeof productImportScopeSchema>;
const digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
export const knowledgeTestCasesSchema = v.pipe(v.array(v.strictObject({
  question: v.pipe(text(2400), v.check(value => new TextEncoder().encode(value).length <= 2400)),
  expectedChunkId: digest, minimumScore: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
})), v.minLength(1), v.maxLength(5), v.check(cases => new Set(cases.map(value => value.question)).size === cases.length));
export type KnowledgeTestCases = v.InferOutput<typeof knowledgeTestCasesSchema>;
export const knowledgeCitationSchema = v.strictObject({ documentId: v.pipe(v.string(), v.uuid()), revision: knowledgeVersionSchema, chunkId: digest, bodyHash: digest });
export const knowledgeCitationRequestSchema = v.strictObject({ storeId: reference, productRef: v.nullable(reference), language: knowledgeScopeSchema.entries.language,
  citations: v.pipe(v.array(knowledgeCitationSchema), v.minLength(1), v.maxLength(10), v.check(values => new Set(values.map(value => value.chunkId)).size === values.length)) });
export type KnowledgeCitationRequest = v.InferOutput<typeof knowledgeCitationRequestSchema>;
export type KnowledgeDraft = v.InferOutput<typeof knowledgeDraftSchema>;
export type KnowledgeScope = v.InferOutput<typeof knowledgeScopeSchema>;
export function validKnowledgeScope(scope: KnowledgeScope, draft: KnowledgeDraft) {
  return (!scope.productRef || !!scope.storeId) && (scope.kind === 'product'
    ? !!scope.productRef && draft.source.format === 'product' : draft.source.format !== 'product');
}
