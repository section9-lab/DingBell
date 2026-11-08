import { NOW_MS_WHOLE_SECONDS } from '../../platform/database/sql.ts';
import * as v from 'valibot';
import { knowledgeSourceSchema } from '../../shared/knowledge.ts';
import type { RetrievalScope, ResolvedKnowledge } from './retrieval.ts';
import { renderKnowledgeMarkdown } from './content.ts';
import { knowledgeTextProfile, readableKnowledgeProfiles, textPublicationSQL } from './text-profile-id.ts';
import { knowledgeAccess, knowledgeActorValues, type KnowledgeActor } from './storage.ts';

export { knowledgeTextProfile, readableKnowledgeProfiles };
/** Result bounds apply after matching, never to an arbitrary prefix of the catalog. */
export const textKnowledgeMatchLimit = 6;
/** @deprecated Chunk-level match used by historical admin/evaluation paths, not by the reply chain. */
export type TextKnowledgeMatch = ResolvedKnowledge & { score: number };
const tokenPattern = /[\p{L}\p{N}]+/gu;
export function textKnowledgeTokens(query: string) {
  const tokens = new Set<string>();
  for (const word of query.normalize('NFC').toLowerCase().match(tokenPattern) ?? []) {
    if (Array.from(word).length < 2 || Array.from(word).length > 48 || tokens.size >= 12) continue;
    tokens.add(word);
  }
  return [...tokens];
}
/**
 * FTS5 performs matching/ranking before the result bound. Only current, approved
 * publications in the requested scope can leave SQL; index hits grant no authority.
 * Two-character queries (notably Chinese) use LIKE: SQLite documents that these
 * cannot use its trigram index, but they must not become false "no knowledge" results.
 */
/** Kept for knowledge evaluation fixtures; the reply chain uses the virtual read path. */
export async function grepPublishedText(db: D1Database, orgId: string, scope: RetrievalScope, query: string, limit = textKnowledgeMatchLimit) {
  const tokens = textKnowledgeTokens(query);
  if (!tokens.length) return [] as TextKnowledgeMatch[];
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('INVALID_KNOWLEDGE_LIMIT');
  const shortQuery = tokens.some(token => Array.from(token).length < 3);
  const matched = shortQuery
    ? tokens.map(() => '(knowledge_text_search.body LIKE ? OR knowledge_text_search.title LIKE ?)').join(' OR ')
    : 'knowledge_text_search MATCH ?';
  const searchValues = shortQuery
    ? tokens.flatMap(token => [`%${token}%`, `%${token}%`])
    : [tokens.map(token => `"${token}"`).join(' OR ')];
  const score = shortQuery ? '1.0' : '-bm25(knowledge_text_search,0,0,0,0,2,1)';
  return (await db.prepare(`SELECT chunk.document_id AS documentId,chunk.revision,chunk.id AS chunkId,chunk.body_hash AS bodyHash,
    chunk.body,rev.title,rev.content_hash AS contentHash,${score} AS score
    FROM knowledge_text_search
    JOIN knowledge_chunk chunk ON chunk.organization_id=knowledge_text_search.organization_id AND chunk.id=knowledge_text_search.chunk_id
    JOIN knowledge_document doc ON doc.organization_id=chunk.organization_id AND doc.id=chunk.document_id AND doc.active_revision=chunk.revision
    JOIN knowledge_revision rev ON rev.organization_id=chunk.organization_id AND rev.document_id=chunk.document_id AND rev.revision=chunk.revision
    WHERE (${matched}) AND chunk.organization_id=? AND doc.language=?
      AND (doc.store_id IS NULL OR doc.store_id=?) AND (doc.product_ref IS NULL OR doc.product_ref=?)
      AND ${textPublicationSQL('rev')} ORDER BY score DESC,chunk.id LIMIT ?`)
    .bind(...searchValues, orgId, scope.language, scope.storeId, scope.productRef, knowledgeTextProfile.id, Math.min(limit, textKnowledgeMatchLimit))
    .all<TextKnowledgeMatch>()).results;
}
/** Read the full published markdown body of a knowledge document by its id, for direct retrieval. */
export async function readPublishedKnowledge(db: D1Database, orgId: string, scope: RetrievalScope, documentId: string) {
  const row = await db.prepare(`SELECT rev.markdown AS markdown,rev.source_json AS source,doc.product_ref AS productRef,
    rev.title AS title,rev.content_hash AS contentHash,rev.revision
    FROM knowledge_document doc
    JOIN knowledge_revision rev ON rev.organization_id=doc.organization_id AND rev.document_id=doc.id AND rev.revision=doc.active_revision
    WHERE doc.organization_id=? AND doc.id=? AND doc.active_revision IS NOT NULL AND doc.language=?
      AND (doc.store_id IS NULL OR doc.store_id=?) AND (doc.product_ref IS NULL OR doc.product_ref=?)
      AND ${textPublicationSQL('rev')}`)
    .bind(orgId, documentId, scope.language, scope.storeId, scope.productRef, knowledgeTextProfile.id)
    .first<{ markdown: string | null; source: string; productRef: string | null; title: string; contentHash: string; revision: number }>();
  if (!row) return null;
  const markdown = row.markdown ?? renderKnowledgeMarkdown(row.title, row.productRef, v.parse(knowledgeSourceSchema, JSON.parse(row.source)));
  if (!markdown.trim()) return null;
  return { documentId, revision: row.revision, title: row.title, markdown, contentHash: row.contentHash };
}
/**
 * Approve the saved revision for agentic text retrieval and make it active.
 * The merchant's explicit approval is the whole gate: no embedding cost, no
 * index copy, and the previous active revision is replaced in the same commit.
 */
export async function approveTextKnowledge(db: D1Database, actor: KnowledgeActor, id: string, expectedVersion: number) {
  const documentGuard = `EXISTS (SELECT 1 FROM knowledge_document doc WHERE doc.organization_id=? AND doc.id=? AND doc.version=?
    AND (doc.active_revision IS NULL OR doc.active_revision<>doc.draft_revision) AND EXISTS (${knowledgeAccess}))`;
  const results = await db.batch([
    db.prepare(`UPDATE knowledge_revision SET published_profile=?,published_at=${NOW_MS_WHOLE_SECONDS},
      published_mutation_id=COALESCE(published_mutation_id,'text-approval:'||revision)
      WHERE organization_id=? AND document_id=? AND revision=(SELECT draft_revision FROM knowledge_document WHERE organization_id=? AND id=?)
       AND status IN ('draft','ready') AND ${documentGuard}
       AND EXISTS (SELECT 1 FROM knowledge_chunk chunk WHERE chunk.organization_id=knowledge_revision.organization_id
        AND chunk.document_id=knowledge_revision.document_id AND chunk.revision=knowledge_revision.revision)`)
      .bind(knowledgeTextProfile.id, actor.orgId, id, actor.orgId, id,
        actor.orgId, id, expectedVersion, ...knowledgeActorValues(actor)),
    db.prepare(`UPDATE knowledge_document SET active_revision=draft_revision,version=version+1,updated_at=${NOW_MS_WHOLE_SECONDS}
      WHERE organization_id=? AND id=? AND version=? AND version<9007199254740991 AND ${documentGuard}
      AND EXISTS (SELECT 1 FROM knowledge_revision rev WHERE rev.organization_id=knowledge_document.organization_id
        AND rev.document_id=knowledge_document.id AND rev.revision=knowledge_document.draft_revision
        AND rev.published_profile=? AND rev.published_at IS NOT NULL AND rev.published_mutation_id IS NOT NULL)
      RETURNING version`)
      .bind(actor.orgId, id, expectedVersion, actor.orgId, id, expectedVersion, ...knowledgeActorValues(actor), knowledgeTextProfile.id),
  ]);
  return results[1].results.length > 0;
}
export async function resolveTextKnowledgeDocuments(db: D1Database, orgId: string, scope: RetrievalScope, citations: { documentId: string; revision: number; contentHash: string }[]) {
  if (!citations.length) return null;
  const query = () => db.prepare(`SELECT doc.id AS documentId,rev.revision,rev.content_hash AS contentHash,rev.title
    FROM json_each(?) wanted
    JOIN knowledge_document doc ON doc.organization_id=? AND doc.id=json_extract(wanted.value,'$.documentId')
     AND doc.active_revision=json_extract(wanted.value,'$.revision')
    JOIN knowledge_revision rev ON rev.organization_id=doc.organization_id AND rev.document_id=doc.id AND rev.revision=doc.active_revision
    WHERE (doc.store_id IS NULL OR doc.store_id=?) AND (doc.product_ref IS NULL OR doc.product_ref=?) AND doc.language=?
     AND rev.content_hash=json_extract(wanted.value,'$.contentHash') AND ${textPublicationSQL('rev')}
    ORDER BY CAST(wanted.key AS INTEGER)`).bind(JSON.stringify(citations), orgId, scope.storeId, scope.productRef, scope.language, knowledgeTextProfile.id);
  const first = await query().all<{ documentId: string; revision: number; contentHash: string; title: string }>();
  if (first.results.length !== citations.length) return null;
  const confirmed = await query().all<{ documentId: string; revision: number; contentHash: string; title: string }>();
  return JSON.stringify(confirmed.results) === JSON.stringify(first.results) ? confirmed.results : null;
}
