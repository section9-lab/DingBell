import * as v from 'valibot';
import { knowledgeSourceSchema } from '../../shared/knowledge.ts';
import { renderKnowledgeMarkdown } from './content.ts';
import { retrievalScopeSchema, type RetrievalScope } from './retrieval.ts';
import { knowledgeTextProfile, textPublicationSQL } from './text-profile-id.ts';

// These bounds are deliberately fail-closed: returning a partial directory would make
// a complete grep indistinguishable from a search that missed later publications.
const MAX_DOCUMENTS = 500;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_READ_LINES = 200;
const MAX_READ_BYTES = 16 * 1024;
const documentIdSchema = v.pipe(v.string(), v.uuid());

type Row = {
  documentId: string; revision: number; title: string; productRef: string | null;
  markdown: string | null; source: string; contentHash: string;
};
export type KnowledgeVirtualFile = {
  path: string; documentId: string; revision: number; contentHash: string; content: string;
};

/**
 * Build an in-memory, scope-filtered snapshot; callers must independently check the
 * live agent run before and after I/O. This is not an authorization entry point.
 */
export async function readKnowledgeVirtualFiles(db: D1Database, organizationId: string, scope: RetrievalScope): Promise<KnowledgeVirtualFile[]> {
  v.parse(v.pipe(v.string(), v.minLength(1), v.maxLength(256)), organizationId);
  scope = v.parse(retrievalScopeSchema, scope);
  const query = () => db.prepare(`SELECT doc.id AS documentId,rev.revision,rev.title,doc.product_ref AS productRef,
      rev.markdown,rev.source_json AS source,rev.content_hash AS contentHash
    FROM knowledge_document doc JOIN knowledge_revision rev
      ON rev.organization_id=doc.organization_id AND rev.document_id=doc.id AND rev.revision=doc.active_revision
    WHERE doc.organization_id=? AND doc.language=? AND (doc.store_id IS NULL OR doc.store_id=?)
      AND (doc.product_ref IS NULL OR doc.product_ref=?) AND ${textPublicationSQL('rev')}
    ORDER BY doc.id LIMIT ?`)
    .bind(organizationId, scope.language, scope.storeId, scope.productRef, knowledgeTextProfile.id, MAX_DOCUMENTS + 1)
    .all<Row>();
  const rows = (await query()).results;
  if (rows.length > MAX_DOCUMENTS) throw new Error('KNOWLEDGE_DIRECTORY_TOO_LARGE');
  const encoder = new TextEncoder();
  let totalBytes = 0;
  const files = rows.map(row => {
    const documentId = v.parse(documentIdSchema, row.documentId);
    const content = row.markdown ?? renderKnowledgeMarkdown(row.title, row.productRef, v.parse(knowledgeSourceSchema, JSON.parse(row.source)));
    totalBytes += encoder.encode(content).length;
    if (totalBytes > MAX_CONTENT_BYTES) throw new Error('KNOWLEDGE_DIRECTORY_TOO_LARGE');
    return { path: `/knowledge/${documentId}.md`, documentId, revision: row.revision, contentHash: row.contentHash, content };
  });
  // Hashing/materialization can yield in other backends; never return a stale snapshot
  // after publication, scope or content changes between the two reads.
  const confirmed = (await query()).results;
  if (JSON.stringify(rows) !== JSON.stringify(confirmed)) throw new Error('KNOWLEDGE_DIRECTORY_CHANGED');
  return files;
}

export type KnowledgeFileRead = {
  path: string; documentId: string; revision: number; contentHash: string;
  startLine: number; endLine: number; totalLines: number; content: string;
};

/** Read a bounded line range from an already authorized snapshot, never from the host filesystem. */
export function readKnowledgeVirtualFile(
  files: readonly KnowledgeVirtualFile[], path: string, startLine = 1, lineCount = MAX_READ_LINES,
): KnowledgeFileRead | null {
  if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > MAX_READ_LINES) {
    throw new RangeError('INVALID_KNOWLEDGE_READ_RANGE');
  }
  // Exact server-generated paths only: no traversal, aliases, or user-selected title paths.
  const file = files.find(value => value.path === path && value.path === `/knowledge/${value.documentId}.md`);
  if (!file) return null;
  const lines = file.content.split('\n');
  const selected = lines.slice(startLine - 1, startLine - 1 + lineCount);
  const content = selected.join('\n');
  if (new TextEncoder().encode(content).length > MAX_READ_BYTES) throw new Error('KNOWLEDGE_READ_TOO_LARGE');
  return {
    path: file.path, documentId: file.documentId, revision: file.revision, contentHash: file.contentHash,
    startLine, endLine: selected.length ? startLine + selected.length - 1 : startLine - 1, totalLines: lines.length, content,
  };
}
