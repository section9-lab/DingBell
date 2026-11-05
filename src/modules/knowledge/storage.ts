import * as v from 'valibot';
import { knowledgeSourceSchema, type KnowledgeCitationRequest, type KnowledgeScope, type KnowledgeFilters } from '../../shared/knowledge.ts';
import type { SettingsActor } from '../company-settings/storage.ts';
import { knowledgeHash, type PreparedKnowledge } from './content.ts';
import { storeAccess } from '../stores/storage.ts';
import { isTextPublication } from './text-profile-id.ts';

export type KnowledgeActor = SettingsActor;
export const knowledgeAccess = `SELECT 1 FROM member actor JOIN user caller ON caller.id=actor.user_id JOIN session login ON login.user_id=caller.id
  WHERE actor.organization_id=? AND actor.user_id=? AND login.id=? AND login.expires_at>unixepoch()*1000
  AND caller.email_verified=1 AND actor.role IN ('owner','admin')`;
export const knowledgeActorValues = (actor: KnowledgeActor) => [actor.orgId, actor.actorUserId, actor.sessionId];
type DocumentRow = { id: string; kind: KnowledgeScope['kind']; store_id: string | null; product_ref: string | null; language: KnowledgeScope['language'];
  version: number; draft_revision: number; active_revision: number | null; updated_at: number; mutation_id: string };
export type KnowledgeRevisionRow = { revision: number; title: string; source_json: string; content_hash: string;
  status: 'draft' | 'indexing' | 'ready' | 'failed'; index_profile: string | null; mutation_id: string | null; tested_at: number | null;
  published_profile: string | null; published_mutation_id: string | null; published_at: number | null; created_at: number; rollback_of: number | null };
const revisionDTO = (row: KnowledgeRevisionRow) => ({ revision: row.revision, title: row.title, source: v.parse(knowledgeSourceSchema, JSON.parse(row.source_json)),
  contentHash: row.content_hash, status: row.status, testedAt: row.tested_at, createdAt: row.created_at, rollbackOf: row.rollback_of,
  textPublished: isTextPublication(row),
  publicationReady: isTextPublication(row) });

export async function readKnowledge(db: D1Database, actor: KnowledgeActor, id: string) {
  const row = await db.prepare(`SELECT * FROM knowledge_document WHERE organization_id=? AND id=? AND EXISTS (${knowledgeAccess})`)
    .bind(actor.orgId, id, ...knowledgeActorValues(actor)).first<DocumentRow>();
  if (!row) return null;
  const revisions = await db.prepare(`SELECT * FROM knowledge_revision WHERE organization_id=? AND document_id=? AND revision IN (?,?)`)
    .bind(actor.orgId, id, row.draft_revision, row.active_revision).all<KnowledgeRevisionRow>();
  if (!await db.prepare(knowledgeAccess).bind(...knowledgeActorValues(actor)).first()) return null;
  const draft = revisions.results.find(revision => revision.revision === row.draft_revision);
  const active = revisions.results.find(revision => revision.revision === row.active_revision);
  if (!draft || (row.active_revision !== null && !active)) throw new Error('Missing knowledge revision');
  return { companyId: actor.orgId, document: { id, kind: row.kind, storeId: row.store_id, productRef: row.product_ref, language: row.language,
    version: row.version, draftRevision: row.draft_revision, activeRevision: row.active_revision, updatedAt: row.updated_at },
    draft: revisionDTO(draft), active: active ? revisionDTO(active) : null };
}
export async function listKnowledge(db: D1Database, actor: KnowledgeActor, after: string, filters: KnowledgeFilters = {}) {
  const rows = await db.prepare(`SELECT doc.id,doc.version,doc.kind,doc.store_id,doc.product_ref,doc.language,doc.draft_revision,doc.active_revision,rev.title,rev.status
    FROM knowledge_document doc JOIN knowledge_revision rev ON rev.organization_id=doc.organization_id AND rev.document_id=doc.id AND rev.revision=doc.draft_revision
    WHERE doc.organization_id=? AND doc.id>? AND EXISTS (${knowledgeAccess})
      AND (? IS NULL OR doc.kind=?) AND (? IS NULL OR doc.language=?) AND (?=0 OR doc.store_id IS ?)
      AND (? IS NULL OR (?='published' AND doc.active_revision IS NOT NULL) OR (?='unpublished' AND doc.active_revision IS NULL)) ORDER BY doc.id LIMIT 21`)
    .bind(actor.orgId, after, ...knowledgeActorValues(actor), filters.kind ?? null, filters.kind ?? null, filters.language ?? null, filters.language ?? null,
      filters.storeId === undefined ? 0 : 1, filters.storeId ?? null, filters.publication ?? null, filters.publication ?? null, filters.publication ?? null)
    .all<DocumentRow & { title: string; status: string }>();
  return { documents: rows.results.slice(0, 20).map(row => ({ id: row.id, version: row.version, kind: row.kind, storeId: row.store_id,
    productRef: row.product_ref, language: row.language, draftRevision: row.draft_revision, activeRevision: row.active_revision, title: row.title, status: row.status })),
    nextAfter: rows.results.length > 20 ? rows.results[19].id : null };
}
export async function readKnowledgeHistory(db: D1Database, actor: KnowledgeActor, id: string, before: number) {
  const rows = await db.prepare(`SELECT * FROM knowledge_revision WHERE organization_id=? AND document_id=? AND revision<?
    AND EXISTS (${knowledgeAccess}) ORDER BY revision DESC LIMIT 11`).bind(actor.orgId, id, before, ...knowledgeActorValues(actor)).all<KnowledgeRevisionRow>();
  return { revisions: rows.results.slice(0, 10).map(revisionDTO), nextBefore: rows.results.length > 10 ? rows.results[9].revision : null };
}
export async function readKnowledgeRevision(db: D1Database, actor: KnowledgeActor, id: string, revision: number) {
  const row = await db.prepare(`SELECT * FROM knowledge_revision WHERE organization_id=? AND document_id=? AND revision=? AND EXISTS (${knowledgeAccess})`)
    .bind(actor.orgId, id, revision, ...knowledgeActorValues(actor)).first<KnowledgeRevisionRow>();
  return row ? revisionDTO(row) : null;
}
export async function ownsKnowledgeStore(db: D1Database, actor: KnowledgeActor, storeId: string | null) {
  return !storeId || !!await db.prepare('SELECT 1 FROM store WHERE organization_id=? AND id=?').bind(actor.orgId, storeId).first();
}
export async function writeKnowledge(db: D1Database, actor: KnowledgeActor, id: string, scope: KnowledgeScope, draft: PreparedKnowledge,
  expectedVersion: number, mutationId: string, rollbackOf: number | null = null,
  productSource?: { snapshotId: string; facts: string }) {
  const sourceGuard = productSource ? ` AND EXISTS (SELECT 1 FROM product JOIN product_source_snapshot snapshot
    ON snapshot.organization_id=product.organization_id AND snapshot.store_id=product.store_id AND snapshot.product_id=product.id
    WHERE product.organization_id=? AND product.store_id=? AND product.id=? AND snapshot.id=? AND snapshot.facts=?
      AND product.facts=snapshot.facts AND product.detail_state='complete'
      AND COALESCE(json_extract(product.listing,'$.archived'),0)=0 AND COALESCE(json_extract(product.facts,'$.archived'),0)=0)` : '';
  const sourceValues = productSource ? [actor.orgId, scope.storeId, scope.productRef, productSource.snapshotId, productSource.facts] : [];
  const head = expectedVersion === 0
    ? db.prepare(`INSERT INTO knowledge_document (organization_id,id,kind,store_id,product_ref,language,version,draft_revision,mutation_id,updated_at)
        SELECT ?,?,?,?,?,?,1,1,?,unixepoch()*1000 WHERE EXISTS (${knowledgeAccess})
        AND (? IS NULL OR EXISTS (SELECT 1 FROM store WHERE organization_id=? AND id=?))${sourceGuard} ON CONFLICT DO NOTHING RETURNING version`)
      .bind(actor.orgId, id, scope.kind, scope.storeId, scope.productRef, scope.language, mutationId, ...knowledgeActorValues(actor), scope.storeId, actor.orgId, scope.storeId, ...sourceValues)
    : db.prepare(`UPDATE knowledge_document SET version=version+1,draft_revision=draft_revision+1,mutation_id=?,updated_at=unixepoch()*1000
        WHERE organization_id=? AND id=? AND version=? AND version<9007199254740991 AND EXISTS (${knowledgeAccess})${sourceGuard} RETURNING version`)
      .bind(mutationId, actor.orgId, id, expectedVersion, ...knowledgeActorValues(actor), ...sourceValues);
  const results = await db.batch([head,
    db.prepare(`INSERT INTO knowledge_revision (organization_id,document_id,revision,title,source_json,content_hash,markdown,status,created_at,created_by,rollback_of)
      SELECT organization_id,id,draft_revision,?,?,?,?,'draft',unixepoch()*1000,?,? FROM knowledge_document WHERE organization_id=? AND id=? AND mutation_id=?`)
      .bind(draft.title, JSON.stringify(draft.source), draft.contentHash, draft.markdown, actor.actorUserId, rollbackOf, actor.orgId, id, mutationId),
    db.prepare(`INSERT INTO knowledge_chunk (organization_id,document_id,revision,id,ordinal,body,body_hash)
      SELECT doc.organization_id,doc.id,doc.draft_revision,json_extract(c.value,'$.id'),json_extract(c.value,'$.ordinal'),json_extract(c.value,'$.body'),json_extract(c.value,'$.bodyHash')
      FROM knowledge_document doc JOIN json_each(?) c WHERE doc.organization_id=? AND doc.id=? AND doc.mutation_id=?`)
      .bind(JSON.stringify(draft.chunks), actor.orgId, id, mutationId),
    ...(productSource ? [db.prepare(`INSERT INTO knowledge_product_source (organization_id,document_id,revision,store_id,product_id,snapshot_id)
      SELECT organization_id,id,draft_revision,store_id,product_ref,? FROM knowledge_document WHERE organization_id=? AND id=? AND mutation_id=?`)
      .bind(productSource.snapshotId, actor.orgId, id, mutationId)] : []),
  ]);
  return results[0].results.length > 0;
}
export function withdrawKnowledge(db: D1Database, actor: KnowledgeActor, id: string, expectedVersion: number) {
  return db.prepare(`UPDATE knowledge_document SET active_revision=NULL,version=version+1,updated_at=unixepoch()*1000
    WHERE organization_id=? AND id=? AND version=? AND version<9007199254740991 AND EXISTS (${knowledgeAccess}) RETURNING version`)
    .bind(actor.orgId, id, expectedVersion, ...knowledgeActorValues(actor)).first();
}
export async function resolveKnowledgeCitations(db: D1Database, actor: KnowledgeActor, request: KnowledgeCitationRequest) {
  const query = db.prepare(`SELECT chunk.document_id AS documentId,chunk.revision,chunk.id AS chunkId,chunk.body_hash AS bodyHash,chunk.body,rev.title,rev.content_hash AS contentHash
    FROM json_each(?) wanted JOIN knowledge_chunk chunk ON chunk.organization_id=? AND chunk.id=json_extract(wanted.value,'$.chunkId')
      AND chunk.document_id=json_extract(wanted.value,'$.documentId') AND chunk.revision=json_extract(wanted.value,'$.revision') AND chunk.body_hash=json_extract(wanted.value,'$.bodyHash')
    JOIN knowledge_document doc ON doc.organization_id=chunk.organization_id AND doc.id=chunk.document_id AND doc.active_revision=chunk.revision
    JOIN knowledge_revision rev ON rev.organization_id=chunk.organization_id AND rev.document_id=chunk.document_id AND rev.revision=chunk.revision
    WHERE (doc.store_id IS NULL OR doc.store_id=?) AND (doc.product_ref IS NULL OR doc.product_ref=?) AND doc.language=?
      AND EXISTS (SELECT 1 FROM store WHERE store.organization_id=? AND store.id=? AND ${storeAccess('store.organization_id', false)}) ORDER BY CAST(wanted.key AS INTEGER)`)
    .bind(JSON.stringify(request.citations), actor.orgId, request.storeId, request.productRef, request.language, actor.orgId, request.storeId, actor.actorUserId, actor.sessionId);
  type Citation = { documentId: string; revision: number; chunkId: string; bodyHash: string; body: string; title: string; contentHash: string };
  const first = await query.all<Citation>();
  if (first.results.length !== request.citations.length) return null;
  for (const row of first.results) if (await knowledgeHash(row.body) !== row.bodyHash) return null;
  // Hashing yields to other work. Recheck publication and access after it, rather than returning a stale snapshot.
  const confirmed = await query.all<Citation>();
  return confirmed.results.length === first.results.length ? confirmed.results : null;
}
