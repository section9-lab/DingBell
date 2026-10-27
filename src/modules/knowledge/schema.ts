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
  status: text('status').notNull(), indexProfile: text('index_profile'), mutationId: text('mutation_id'),
  testedAt: integer('tested_at'), publishedProfile: text('published_profile'), publishedMutationId: text('published_mutation_id'), publishedAt: integer('published_at'),
  createdAt: integer('created_at').notNull(), createdBy: text('created_by').notNull(), rollbackOf: integer('rollback_of'),
}, table => [
  primaryKey({ columns: [table.organizationId, table.documentId, table.revision] }),
  foreignKey({ columns: [table.organizationId, table.documentId], foreignColumns: [knowledgeDocument.organizationId, knowledgeDocument.id] }).onDelete('cascade'),
  check('knowledge_revision_valid', sql`${table.revision}>0 AND json_valid(${table.sourceJson}) AND length(${table.contentHash})=64
    AND ${table.status} IN ('draft','indexing','ready','failed') AND (${table.testedAt} IS NULL OR ${table.status}='ready')`),
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

export const knowledgeIndexUsage = sqliteTable('knowledge_index_usage', {
  day: text('day').primaryKey(), reservedBytes: integer('reserved_bytes').notNull(), jobs: integer('jobs').notNull(),
}, table => [check('knowledge_index_usage_valid', sql`${table.reservedBytes}>=0 AND ${table.jobs}>=0`)]);
export const knowledgeReviewJob = sqliteTable('knowledge_review_job', {
  organizationId: text('organization_id').notNull(), id: text('id').notNull(), documentId: text('document_id').notNull(), kind: text('kind').notNull(),
  revision: integer('revision').notNull(), documentVersion: integer('document_version').notNull(), contentHash: text('content_hash').notNull(), profile: text('profile').notNull(),
  actorUserId: text('actor_user_id').notNull(), actorMemberId: text('actor_member_id').notNull(), testJobId: text('test_job_id'),
  casesJson: text('cases_json'), resultsJson: text('results_json'), inputBytes: integer('input_bytes').notNull(), quotaDay: text('quota_day').notNull(),
  state: text('state').notNull(), attemptedAt: integer('attempted_at'), vectorsJson: text('vectors_json'), mutationId: text('mutation_id'), errorCode: text('error_code'),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(), completedAt: integer('completed_at'),
  wakeAfter: integer('wake_after').notNull(), deadlineAt: integer('deadline_at').notNull(),
}, table => [
  primaryKey({ columns: [table.organizationId, table.id] }),
  foreignKey({ columns: [table.organizationId, table.documentId, table.revision], foreignColumns: [knowledgeRevision.organizationId, knowledgeRevision.documentId, knowledgeRevision.revision] }).onDelete('cascade'),
  index('knowledge_review_due_idx').on(table.state, table.wakeAfter, table.id),
  index('knowledge_review_document_idx').on(table.organizationId, table.documentId, table.id),
  index('knowledge_review_day_idx').on(table.organizationId, table.quotaDay),
  check('knowledge_review_valid', sql`${table.revision}>0 AND ${table.documentVersion}>1 AND length(${table.contentHash})=64
    AND ${table.kind} IN ('test','publish') AND ${table.state} IN ('queued','running','waiting','succeeded','failed','unknown','cancelled')
    AND ((${table.kind}='test' AND ${table.inputBytes} BETWEEN 1 AND 12000 AND json_valid(${table.casesJson}) AND ${table.testJobId} IS NULL)
      OR (${table.kind}='publish' AND ${table.inputBytes}=0 AND ${table.casesJson} IS NULL AND ${table.testJobId} IS NOT NULL))
    AND (${table.vectorsJson} IS NULL OR (json_valid(${table.vectorsJson}) AND length(CAST(${table.vectorsJson} AS BLOB))<=1048576))
    AND (${table.resultsJson} IS NULL OR (json_valid(${table.resultsJson}) AND length(CAST(${table.resultsJson} AS BLOB))<=32768))`),
]);
export const knowledgeVectorCleanup = sqliteTable('knowledge_vector_cleanup', {
  organizationId: text('organization_id').notNull(), documentId: text('document_id').notNull(), revision: integer('revision').notNull(),
  profile: text('profile').notNull(), vectorIdsJson: text('vector_ids_json').notNull(), state: text('state').notNull(), attempts: integer('attempts').notNull(),
  claimToken: text('claim_token'), leaseUntil: integer('lease_until'), wakeAfter: integer('wake_after').notNull(), mutationId: text('mutation_id'),
  errorCode: text('error_code'), createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
}, table => [
  primaryKey({ columns: [table.organizationId, table.documentId, table.revision, table.profile] }),
  foreignKey({ columns: [table.organizationId, table.documentId, table.revision], foreignColumns: [knowledgeRevision.organizationId, knowledgeRevision.documentId, knowledgeRevision.revision] }).onDelete('cascade'),
  index('knowledge_vector_cleanup_due_idx').on(table.state, table.wakeAfter, table.leaseUntil),
  check('knowledge_vector_cleanup_valid', sql`${table.revision}>0 AND json_valid(${table.vectorIdsJson}) AND json_array_length(${table.vectorIdsJson}) BETWEEN 1 AND 32
    AND length(CAST(${table.vectorIdsJson} AS BLOB))<=4096 AND ${table.state} IN ('queued','deleting','confirming','succeeded','failed')
    AND ${table.attempts} BETWEEN 0 AND 20 AND ((${table.claimToken} IS NULL AND ${table.leaseUntil} IS NULL) OR (length(${table.claimToken}) BETWEEN 1 AND 64 AND ${table.leaseUntil}>0))`),
]);

export const knowledgeIndexJob = sqliteTable('knowledge_index_job', {
  organizationId: text('organization_id').notNull(), id: text('id').notNull(), documentId: text('document_id').notNull(),
  revision: integer('revision').notNull(), documentVersion: integer('document_version').notNull(), contentHash: text('content_hash').notNull(), profile: text('profile').notNull(),
  actorUserId: text('actor_user_id').notNull(), actorMemberId: text('actor_member_id').notNull(), inputBytes: integer('input_bytes').notNull(), quotaDay: text('quota_day').notNull(),
  state: text('state').notNull(), attemptedAt: integer('attempted_at'), vectorsJson: text('vectors_json'), mutationId: text('mutation_id'), errorCode: text('error_code'),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(), wakeAfter: integer('wake_after').notNull(), deadlineAt: integer('deadline_at').notNull(),
}, table => [
  primaryKey({ columns: [table.organizationId, table.id] }),
  foreignKey({ columns: [table.organizationId, table.documentId, table.revision], foreignColumns: [knowledgeRevision.organizationId, knowledgeRevision.documentId, knowledgeRevision.revision] }).onDelete('cascade'),
  index('knowledge_index_job_due_idx').on(table.state, table.wakeAfter, table.id),
  index('knowledge_index_job_day_idx').on(table.organizationId, table.quotaDay),
  check('knowledge_index_job_valid', sql`${table.revision}>0 AND ${table.documentVersion}>1 AND length(${table.contentHash})=64
    AND ${table.inputBytes} BETWEEN 1 AND 38400 AND ${table.state} IN ('queued','embedding','indexing','succeeded','failed','unknown','cancelled')
    AND (${table.vectorsJson} IS NULL OR (json_valid(${table.vectorsJson}) AND length(CAST(${table.vectorsJson} AS BLOB))<=1048576))`),
]);
