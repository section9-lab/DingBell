import { MAX_TIMESTAMP_MS } from '../../shared/time.ts';
import * as v from 'valibot';
import { knowledgeDraftSchema, knowledgeScopeSchema, productImportCommandSchema, validKnowledgeScope,
  type KnowledgeDraft, type KnowledgeScope, type KnowledgeFilters, type ProductImportScope } from '../../shared/knowledge.ts';
import { ApiError, request } from './api.ts';
import { knowledgeFileBytes, knowledgeFileRows, knowledgeFileScopeSchema, type KnowledgeFileScope } from '../../shared/knowledge-file.ts';

const version = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER));
const time = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_TIMESTAMP_MS));
const digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const uuid = v.pipe(v.string(), v.uuid());
const status = v.picklist(['draft', 'ready', 'failed']);
const revision = v.object({ revision: version, ...knowledgeDraftSchema.entries, contentHash: digest, status,
  testedAt: v.nullable(time), createdAt: time, rollbackOf: v.nullable(version), textPublished: v.boolean(), publicationReady: v.boolean() });
const summary = { id: uuid, ...knowledgeScopeSchema.entries, version, draftRevision: version, activeRevision: v.nullable(version) };
const coherent = (row: { version: number; draftRevision: number; activeRevision: number | null }) => row.draftRevision <= row.version
  && (row.activeRevision === null || row.activeRevision <= row.draftRevision);
const detailSchema = (companyId: string, id: string) => v.pipe(v.object({ companyId: v.literal(companyId),
  document: v.object({ ...summary, id: v.literal(id), updatedAt: time }), draft: revision, active: v.nullable(revision),
}), v.check(value => coherent(value.document) && value.draft.revision === value.document.draftRevision
  && validKnowledgeScope(value.document, value.draft)
  && (value.active === null ? value.document.activeRevision === null : value.active.revision === value.document.activeRevision
    && value.active.textPublished && validKnowledgeScope(value.document, value.active))));
const path = (companyId: string, id?: string) => `/api/companies/${encodeURIComponent(companyId)}/knowledge${id ? `/${encodeURIComponent(id)}` : ''}`;
export type KnowledgeDetail = v.InferOutput<ReturnType<typeof detailSchema>>;
export type KnowledgeRevision = v.InferOutput<typeof revision>;

const filePreview = v.object({ companyId: v.string(), scope: knowledgeFileScopeSchema,
  file: v.object({ name: v.string(), format: v.picklist(['text', 'markdown', 'csv']), bytes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(knowledgeFileBytes)), sha256: digest }),
  manifestHash: digest, entries: v.pipe(v.array(v.object({ documentId: uuid, ...knowledgeDraftSchema.entries, contentHash: digest, exists: v.boolean() })),
    v.minLength(1), v.maxLength(knowledgeFileRows), v.check(entries => new Set(entries.map(entry => entry.documentId)).size === entries.length
      && entries.every(entry => v.safeParse(knowledgeDraftSchema, { title: entry.title, source: entry.source }).success && entry.source.format !== 'product'))) });
export type KnowledgeFilePreview = v.InferOutput<typeof filePreview>;
function fileRequest(companyId: string, file: File, scope: KnowledgeFileScope, title: string, confirmed?: KnowledgeFilePreview) {
  const form = new FormData(); form.append('file', file); form.append('scope', JSON.stringify(scope)); form.append('title', title);
  if (confirmed) form.append('manifestHash', confirmed.manifestHash);
  const schema = v.pipe(filePreview, v.check(value => value.companyId === companyId && value.file.name === file.name && value.file.bytes === file.size
    && value.scope.kind === scope.kind && value.scope.storeId === scope.storeId && value.scope.language === scope.language
    && (!confirmed || (value.manifestHash === confirmed.manifestHash && value.entries.length === confirmed.entries.length && value.entries.every((entry, index) => {
      const expected = confirmed.entries[index]; return entry.exists && entry.documentId === expected.documentId && entry.title === expected.title
        && entry.contentHash === expected.contentHash && JSON.stringify(entry.source) === JSON.stringify(expected.source);
    })))));
  return request(`${path(companyId)}/${confirmed ? 'file-import' : 'file-preview'}`, schema, { method: 'POST', body: form });
}
export async function previewKnowledgeUpload(companyId: string, file: File, scope: KnowledgeFileScope, title: string) {
  try { return await fileRequest(companyId, file, scope, title); }
  catch (error) { if (error instanceof ApiError && error.code === 'OPERATION_UNCONFIRMED') throw new ApiError('KNOWLEDGE_FILE_PREVIEW_FAILED', error.requestId); throw error; }
}
export function importKnowledgeUpload(companyId: string, file: File, title: string, preview: KnowledgeFilePreview) {
  return fileRequest(companyId, file, preview.scope, title, preview);
}

export function readKnowledgeList(companyId: string, filters: KnowledgeFilters = {}, after = '', signal?: AbortSignal) {
  const params = new URLSearchParams({ after });
  for (const [key, value] of Object.entries(filters)) if (value !== undefined) params.set(key, value ?? '');
  return request(`${path(companyId)}?${params}`, v.pipe(v.object({ companyId: v.literal(companyId),
    documents: v.pipe(v.array(v.object({ ...summary, title: v.string(), status })), v.maxLength(20)), nextAfter: v.nullable(v.string()),
  }), v.check(value => value.documents.every((row, index) => coherent(row) && row.id > (index ? value.documents[index - 1].id : after)
    && (filters.kind === undefined || row.kind === filters.kind) && (filters.language === undefined || row.language === filters.language)
    && (filters.storeId === undefined || row.storeId === filters.storeId)
    && (filters.publication === undefined || (filters.publication === 'published') === (row.activeRevision !== null)))
    && (value.nextAfter === null || (value.documents.length === 20 && value.nextAfter === value.documents.at(-1)?.id)))), { signal });
}
export function readKnowledge(companyId: string, id: string, signal?: AbortSignal) { return request(path(companyId, id), detailSchema(companyId, id), { signal }); }
export function createKnowledge(companyId: string, id: string, scope: KnowledgeScope, draft: KnowledgeDraft) {
  return request(path(companyId), detailSchema(companyId, id), { method: 'POST', body: JSON.stringify({ id, ...scope, ...draft }) });
}
type Changes = { draft: KnowledgeDraft & { expectedVersion: number }; publish: { expectedVersion: number }; withdraw: { expectedVersion: number }; text: { expectedVersion: number }; restore: { expectedVersion: number; revision: number } };
export function updateKnowledge<A extends keyof Changes>(companyId: string, id: string, action: A, body: Changes[A]) {
  return request(`${path(companyId, id)}/${action}`, detailSchema(companyId, id), { method: 'POST', body: JSON.stringify(body) });
}
export function readKnowledgeVersions(companyId: string, id: string, before: number, signal?: AbortSignal) {
  return request(`${path(companyId, id)}/versions?before=${before}`, v.pipe(v.object({ companyId: v.literal(companyId), documentId: v.literal(id),
    revisions: v.pipe(v.array(revision), v.maxLength(10)), nextBefore: v.nullable(version),
  }), v.check(value => value.revisions.every((row, index) => row.revision < (index ? value.revisions[index - 1].revision : before))
    && (value.nextBefore === null || (value.revisions.length === 10 && value.nextBefore === value.revisions.at(-1)?.revision)))), { signal });
}
export function readKnowledgeProducts(companyId: string, storeId: string, after = '', signal?: AbortSignal) {
  return request(`${path(companyId)}/product-sources?${new URLSearchParams({storeId,after})}`, v.pipe(v.object({companyId:v.literal(companyId),storeId:v.literal(storeId),
    products:v.pipe(v.array(v.object({productId:v.pipe(v.string(),v.regex(/^(0|[1-9][0-9]{0,39})$/)),offerId:v.string(),name:v.nullable(v.string()),observedAt:v.nullable(time),state:v.picklist(['ready','pending','unavailable','archived'])})),v.maxLength(20)),nextAfter:v.nullable(v.string()),
  }),v.check(value=>value.products.every((row,index)=>row.productId>(index?value.products[index-1].productId:after))
    &&(value.nextAfter===null||(value.products.length===20&&value.nextAfter===value.products.at(-1)?.productId)))),{signal});
}
const productPreviewSchema = (companyId:string,input:ProductImportScope) => v.pipe(v.object({companyId:v.literal(companyId),documentId:uuid,
  source:v.object({storeId:v.literal(input.storeId),productId:v.literal(input.productId),snapshotId:uuid,observedAt:time}),
  scope:v.object({...knowledgeScopeSchema.entries,kind:v.literal('product'),storeId:v.literal(input.storeId),productRef:v.literal(input.productId),language:v.literal(input.language)}),
  expectedVersion:productImportCommandSchema.entries.expectedVersion,draft:knowledgeDraftSchema,importedRevision:v.nullable(version),
  currentDraft:v.nullable(v.object({revision:version,...knowledgeDraftSchema.entries})),activeRevision:v.nullable(version),
}),v.check(value=>validKnowledgeScope(value.scope,value.draft)&&(value.currentDraft===null?value.expectedVersion===0:value.currentDraft.revision<=value.expectedVersion)
  &&(value.importedRevision===null||value.importedRevision<=(value.currentDraft?.revision??0))
  &&(value.activeRevision===null||value.activeRevision<=(value.currentDraft?.revision??0))));
export type KnowledgeProductPreview=v.InferOutput<ReturnType<typeof productPreviewSchema>>;
export function readKnowledgeProductPreview(companyId:string,input:ProductImportScope,signal?:AbortSignal){
  return request(`${path(companyId)}/product-import?${new URLSearchParams(input)}`,productPreviewSchema(companyId,input),{signal});
}
export function importKnowledgeProduct(companyId:string,preview:KnowledgeProductPreview){
  return request(`${path(companyId)}/product-import`,v.object({companyId:v.literal(companyId),documentId:v.literal(preview.documentId),revision:version,status:v.picklist(['imported','already_imported','unchanged'])}),
    {method:'POST',body:JSON.stringify({storeId:preview.scope.storeId,productId:preview.source.productId,language:preview.scope.language,snapshotId:preview.source.snapshotId,expectedVersion:preview.expectedVersion})});
}
