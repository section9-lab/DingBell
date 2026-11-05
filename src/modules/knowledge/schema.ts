import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { organization } from '../identity/schema.ts';
import { store } from '../stores/schema.ts';
import { productSourceSnapshot } from '../products/schema.ts';

export const knowledgeDocument = sqliteTable('knowledge_document', {
  organizationId: text('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  id: text('id').notNull(), kind: text('kind').notNull(), storeId: text('store_id'), productRef: text('product_ref'), language: text('language').notNull(),
  version: integer('version').notNull(), draftRevision: integer('draft_revision').notNull(), activeRevision: integer('active_revision'),
  mutationId: text('mutation_id').notNull(), updatedAt: integer('updated_at').notNull(),
}, table => [
  primaryKey({ columns: [table.organizationId, table.id] }),
  foreignKey({ columns: [table.storeId, table.organizationId], foreignColumns: [store.id, store.organizationId] }).onDelete('cascade'),
  check('knowledge_document_scope', sql`${table.kind} IN ('product','policy','guide','faq') AND ${table.language} IN ('ru','zh-CN','en')
    AND (${table.productRef} IS NULL OR ${table.storeId} IS NOT NULL) AND (${table.kind}<>'product' OR ${table.productRef} IS NOT NULL)`),
  check('knowledge_document_version', sql`${table.version} BETWEEN 1 AND 9007199254740991 AND ${table.draftRevision} BETWEEN 1 AND ${table.version}
    AND (${table.activeRevision} IS NULL OR ${table.activeRevision} BETWEEN 1 AND ${table.draftRevision})`),
]);
export const knowledgeRevision = sqliteTable('knowledge_revision', {
  organizationId: text('organization_id').notNull(), documentId: text('document_id').notNull(), revision: integer('revision').notNull(),
  title: text('title').notNull(), sourceJson: text('source_json').notNull(), contentHash: text('content_hash').notNull(),
  markdown: text('markdown'),
  status: text('status').notNull(), indexProfile: text('index_profile'), mutationId: text('mutation_id'),
  testedAt: integer('tested_at'), publishedProfile: text('published_profile'), publishedMutationId: text('published_mutation_id'), publishedAt: integer('published_at'),
  createdAt: integer('created_at').notNull(), createdBy: text('created_by').notNull(), rollbackOf: integer('rollback_of'),
}, table => [
  primaryKey({ columns: [table.organizationId, table.documentId, table.revision] }),
  foreignKey({ columns: [table.organizationId, table.documentId], foreignColumns: [knowledgeDocument.organizationId, knowledgeDocument.id] }).onDelete('cascade'),
  check('knowledge_revision_valid', sql`${table.revision}>0 AND json_valid(${table.sourceJson}) AND length(${table.contentHash})=64
    AND ${table.status} IN ('draft','ready','failed') AND (${table.testedAt} IS NULL OR ${table.status}='ready')`),
]);
export const knowledgeChunk = sqliteTable('knowledge_chunk', {
  organizationId: text('organization_id').notNull(), documentId: text('document_id').notNull(), revision: integer('revision').notNull(),
  id: text('id').notNull(), ordinal: integer('ordinal').notNull(), body: text('body').notNull(), bodyHash: text('body_hash').notNull(),
}, table => [
  primaryKey({ columns: [table.organizationId, table.id] }),
  foreignKey({ columns: [table.organizationId, table.documentId, table.revision], foreignColumns: [knowledgeRevision.organizationId, knowledgeRevision.documentId, knowledgeRevision.revision] }).onDelete('cascade'),
  index('knowledge_chunk_revision_idx').on(table.organizationId, table.documentId, table.revision, table.ordinal),
  check('knowledge_chunk_valid', sql`${table.ordinal}>=0 AND length(${table.id})=64 AND length(${table.bodyHash})=64 AND length(CAST(${table.body} AS BLOB)) BETWEEN 1 AND 2400`),
]);
export const knowledgeProductSource = sqliteTable('knowledge_product_source', {
  organizationId: text('organization_id').notNull(), documentId: text('document_id').notNull(), revision: integer('revision').notNull(),
  storeId: text('store_id').notNull(), productId: text('product_id').notNull(), snapshotId: text('snapshot_id').notNull(),
}, table => [
  primaryKey({ columns: [table.organizationId, table.documentId, table.revision] }),
  foreignKey({ columns: [table.organizationId, table.documentId, table.revision], foreignColumns: [knowledgeRevision.organizationId, knowledgeRevision.documentId, knowledgeRevision.revision] }).onDelete('cascade'),
  foreignKey({ columns: [table.organizationId, table.storeId, table.productId, table.snapshotId], foreignColumns: [productSourceSnapshot.organizationId, productSourceSnapshot.storeId, productSourceSnapshot.productId, productSourceSnapshot.id] }).onDelete('cascade'),
  uniqueIndex('knowledge_product_source_import_unique').on(table.organizationId, table.documentId, table.snapshotId),
  index('knowledge_product_source_snapshot_idx').on(table.snapshotId),
  check('knowledge_product_source_revision', sql`${table.revision}>0`),
]);
export const knowledgeAuditEvent = sqliteTable('knowledge_audit_event', {
  id: text('id').primaryKey(), requestId: text('request_id').notNull(), organizationId: text('organization_id').notNull(),
  documentId: text('document_id').notNull(), actorUserId: text('actor_user_id').notNull(), action: text('action').notNull(), outcome: text('outcome').notNull(),
  expectedVersion: integer('expected_version').notNull(), createdAt: integer('created_at').notNull(),
}, table => [index('knowledge_audit_organization_time_idx').on(table.organizationId, table.createdAt, table.id)]);
