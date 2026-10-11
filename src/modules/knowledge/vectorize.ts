import * as v from 'valibot';
import { knowledgeCitationSchema, type KnowledgeCitationRequest, type KnowledgeScope } from '../../shared/knowledge.ts';
import { knowledgeHash, type PreparedKnowledge } from './content.ts';

export const knowledgeProfile = { id: 'bge-m3-1024-bytes2400-v1', model: '@cf/baai/bge-m3', dimensions: 1024 } as const;
function validVectors(value: unknown, count: number): value is number[][] {
  return Array.isArray(value) && value.length === count && value.every(row => Array.isArray(row) && row.length === knowledgeProfile.dimensions
    && row.every(item => typeof item === 'number' && Number.isFinite(item)) && row.some(item => item !== 0));
}
export async function embedKnowledge(ai: Ai, texts: string[]) {
  if (!texts.length || texts.length > 16 || texts.some(text => !text.trim() || !text.isWellFormed() || new TextEncoder().encode(text).length > 2400))
    throw new Error('KNOWLEDGE_INPUT_LIMIT');
  const response = await ai.run(knowledgeProfile.model, { text: texts, truncate_inputs: false });
  if (!response || typeof response !== 'object' || !('data' in response) || !validVectors(response.data, texts.length)
    || (response.shape && (response.shape.length !== 2 || response.shape[0] !== texts.length || response.shape[1] !== knowledgeProfile.dimensions)))
    throw new Error('KNOWLEDGE_EMBEDDING_INVALID');
  return response.data;
}
async function keys(orgId: string, scope: Pick<KnowledgeScope, 'storeId' | 'productRef'>) {
  return { namespace: await knowledgeHash(['company', orgId]), scopeKey: scope.storeId === null ? 'all' : await knowledgeHash(['store', orgId, scope.storeId]),
    productKey: scope.productRef === null ? 'all' : await knowledgeHash(['product', orgId, scope.storeId, scope.productRef]) };
}
export async function knowledgeManifest(orgId: string, documentId: string, revision: number, scope: KnowledgeScope, prepared: PreparedKnowledge) {
  if (!prepared.chunks.length || prepared.chunks.length > 16) throw new Error('KNOWLEDGE_INPUT_LIMIT');
  return { ...await keys(orgId, scope), documentId, revision, language: scope.language, chunks: prepared.chunks,
    revisionKey: await knowledgeHash([orgId, documentId, revision, prepared.contentHash, knowledgeProfile.id]) };
}
type Manifest = Awaited<ReturnType<typeof knowledgeManifest>>;
export type KnowledgeActiveRevision = { documentId: string; revision: number; contentHash: string };
export const knowledgeRevisionBatchSize = 20;
const vectorId = (chunkId: string, eligible: boolean) => knowledgeHash([knowledgeProfile.id, eligible ? 'published' : 'draft', chunkId]);
function metadata(manifest: Manifest, chunk: Manifest['chunks'][number], eligible: boolean) {
  return { scope: manifest.scopeKey, product: manifest.productKey, language: manifest.language, revision: manifest.revisionKey,
    documentId: manifest.documentId, revisionNumber: manifest.revision, profile: knowledgeProfile.id, chunkId: chunk.id, bodyHash: chunk.bodyHash, eligible };
}
export async function indexKnowledge(index: Vectorize, manifest: Manifest, vectors: number[][], eligible = false) {
  if (!validVectors(vectors, manifest.chunks.length)) throw new Error('KNOWLEDGE_EMBEDDING_INVALID');
  const receipt = await index.upsert(await Promise.all(manifest.chunks.map(async (chunk, ordinal) => ({ id: await vectorId(chunk.id, eligible), values: vectors[ordinal], namespace: manifest.namespace, metadata: metadata(manifest, chunk, eligible) }))));
  if (typeof receipt.mutationId !== 'string' || !receipt.mutationId) throw new Error('KNOWLEDGE_INDEX_INVALID');
  return receipt.mutationId;
}
// The returned receipt confirms acceptance only. Verify the published copy with isKnowledgeVisible before recording readiness.
export async function copyKnowledgeToPublished(index: Vectorize, manifest: Manifest) {
  const ids = await Promise.all(manifest.chunks.map(chunk => vectorId(chunk.id, false)));
  const rows = await index.getByIds(ids);
  if (!Array.isArray(rows) || rows.length !== ids.length || rows.some(row => !row || typeof row.id !== 'string')
    || new Set(rows.map(row => row.id)).size !== ids.length) throw new Error('KNOWLEDGE_INDEX_INVALID');
  const vectors = manifest.chunks.map((chunk, ordinal) => {
    const row = rows.find(row => row.id === ids[ordinal]), expected = metadata(manifest, chunk, false);
    if (!row || row.namespace !== manifest.namespace || !row.metadata
      || Object.entries(expected).some(([key, value]) => row.metadata![key] !== value)) throw new Error('KNOWLEDGE_INDEX_INVALID');
    return row.values;
  });
  if (!validVectors(vectors, manifest.chunks.length)) throw new Error('KNOWLEDGE_EMBEDDING_INVALID');
  return indexKnowledge(index, manifest, vectors, true);
}
export async function queryKnowledgeDraft(index: Vectorize, manifest: Manifest, vector: number[]) {
  if (!validVectors([vector], 1)) throw new Error('KNOWLEDGE_EMBEDDING_INVALID');
  const topK = Math.min(3, manifest.chunks.length);
  const result = await index.query(vector, { namespace: manifest.namespace, topK, returnMetadata: 'all',
    filter: { scope: manifest.scopeKey, product: manifest.productKey, language: manifest.language, revision: manifest.revisionKey, eligible: false } });
  if (!Array.isArray(result.matches) || result.matches.length > topK || new Set(result.matches.map(row => row.id)).size !== result.matches.length)
    throw new Error('KNOWLEDGE_INDEX_INVALID');
  return Promise.all(result.matches.map(async row => {
    const chunk = manifest.chunks.find(chunk => chunk.id === row.metadata?.chunkId);
    if (!chunk || row.id !== await vectorId(chunk.id, false) || row.namespace !== manifest.namespace || !Number.isFinite(row.score)
      || Object.entries(metadata(manifest, chunk, false)).some(([key, value]) => row.metadata?.[key] !== value)) throw new Error('KNOWLEDGE_INDEX_INVALID');
    return { chunkId: chunk.id, bodyHash: chunk.bodyHash, score: row.score };
  }));
}
export async function isKnowledgeVisible(index: Vectorize, manifest: Manifest, eligible = false) {
  const expectedIds = await Promise.all(manifest.chunks.map(chunk => vectorId(chunk.id, eligible)));
  const result = await index.queryById(expectedIds[0], { namespace: manifest.namespace, topK: manifest.chunks.length, returnMetadata: 'all',
    filter: { scope: manifest.scopeKey, product: manifest.productKey, language: manifest.language, revision: manifest.revisionKey, eligible } });
  if (!Array.isArray(result.matches) || result.matches.length !== manifest.chunks.length || new Set(result.matches.map(row => row.id)).size !== manifest.chunks.length) return false;
  return manifest.chunks.every((chunk, ordinal) => {
    const match = result.matches.find(row => row.id === expectedIds[ordinal]), expected = metadata(manifest, chunk, eligible);
    return !!match && match.namespace === manifest.namespace && Number.isFinite(match.score)
      && Object.entries(expected).every(([key, value]) => match.metadata?.[key] === value);
  });
}
export async function queryKnowledge(index: Vectorize, orgId: string, scope: Omit<KnowledgeCitationRequest, 'citations'>, vector: number[], revisions: KnowledgeActiveRevision[]) {
  if (!validVectors([vector], 1)) throw new Error('KNOWLEDGE_EMBEDDING_INVALID');
  if (!revisions?.length || revisions.length > knowledgeRevisionBatchSize || new Set(revisions.map(row => row.documentId)).size !== revisions.length)
    throw new Error('KNOWLEDGE_INPUT_LIMIT');
  const { namespace, scopeKey, productKey } = await keys(orgId, scope), stores = ['all', scopeKey], products = [...new Set(['all', productKey])];
  const revisionKeys = await Promise.all(revisions.map(row => knowledgeHash([orgId, row.documentId, row.revision, row.contentHash, knowledgeProfile.id])));
  const filter = { scope: { $in: stores }, product: { $in: products }, language: scope.language, eligible: true, revision: { $in: revisionKeys } };
  if (new TextEncoder().encode(JSON.stringify(filter)).length >= 2048) throw new Error('KNOWLEDGE_INPUT_LIMIT');
  const result = await index.query(vector, { namespace, topK: 10, returnMetadata: 'all', filter });
  if (!result || !Array.isArray(result.matches) || result.matches.length > 10 || result.matches.some(row => !row || typeof row.id !== 'string')
    || new Set(result.matches.map(row => row.id)).size !== result.matches.length) throw new Error('KNOWLEDGE_INDEX_INVALID');
  return Promise.all(result.matches.map(async row => {
    const m = row.metadata;
    if (row.namespace !== namespace || !Number.isFinite(row.score) || !m || m.eligible !== true || m.profile !== knowledgeProfile.id
      || m.language !== scope.language || typeof m.scope !== 'string' || typeof m.product !== 'string'
      || !stores.includes(m.scope) || !products.includes(m.product)) throw new Error('KNOWLEDGE_INDEX_INVALID');
    const parsed = v.safeParse(knowledgeCitationSchema, { documentId: m.documentId, revision: m.revisionNumber, chunkId: m.chunkId, bodyHash: m.bodyHash });
    const ordinal = revisions.findIndex(revision => revision.documentId === m.documentId && revision.revision === m.revisionNumber);
    if (!parsed.success || ordinal < 0 || m.revision !== revisionKeys[ordinal] || row.id !== await vectorId(parsed.output.chunkId, true)) throw new Error('KNOWLEDGE_INDEX_INVALID');
    // These are untrusted candidate references. The caller must resolve them through D1 before using any content.
    return { ...parsed.output, score: row.score };
  }));
}
