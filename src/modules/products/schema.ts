import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { store } from '../stores/schema.ts';

export const productSyncCursor = sqliteTable('product_sync_cursor', {
  storeId: text('store_id').primaryKey(), organizationId: text('organization_id').notNull(),
  epoch: integer('epoch').notNull(), generation: integer('generation').notNull().default(1),
  cursor: text('cursor').notNull().default(''), revision: integer('revision').notNull().default(0),
  recentCursors: text('recent_cursors').notNull().default('[]'), dueAt: integer('due_at').notNull(),
  lastKind: text('last_kind').notNull().default('details'), lastCompletedAt: integer('last_completed_at'),
}, table => [
  foreignKey({ columns: [table.storeId, table.organizationId], foreignColumns: [store.id, store.organizationId] }).onDelete('cascade'),
  check('product_cursor_counters_valid', sql`${table.epoch}>0 AND ${table.generation}>0 AND ${table.revision}>=0`),
  check('product_cursor_history_valid', sql`json_valid(${table.recentCursors}) AND json_type(${table.recentCursors})='array' AND json_array_length(${table.recentCursors})<=8`),
  check('product_cursor_kind_valid', sql`${table.lastKind} IN ('list','details')`),
]);

export const product = sqliteTable('product', {
  id: text('id').notNull(), organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(),
  listing: text('listing').notNull(), listObservedAt: integer('list_observed_at').notNull(), listSourceUpdatedAt: integer('list_source_updated_at'),
  facts: text('facts'), factsObservedAt: integer('facts_observed_at'), factsSourceUpdatedAt: integer('facts_source_updated_at'),
  detailEpoch: integer('detail_epoch').notNull(), detailGeneration: integer('detail_generation').notNull(),
  detailRevision: integer('detail_revision').notNull().default(0), detailState: text('detail_state').notNull().default('pending'),
  detailAttempt: integer('detail_attempt').notNull().default(0), detailDueAt: integer('detail_due_at').notNull(), detailError: text('detail_error'),
}, table => [
  primaryKey({ columns: [table.storeId, table.id] }),
  foreignKey({ columns: [table.storeId, table.organizationId], foreignColumns: [store.id, store.organizationId] }).onDelete('cascade'),
  uniqueIndex('product_scope_unique').on(table.storeId, table.organizationId, table.id),
  index('product_detail_due_idx').on(table.storeId, table.detailEpoch, table.detailState, table.detailDueAt, table.id),
  check('product_listing_json', sql`json_valid(${table.listing}) AND json_type(${table.listing})='object'`),
  check('product_facts_json', sql`${table.facts} IS NULL OR (json_valid(${table.facts}) AND json_type(${table.facts})='object')`),
  check('product_detail_state_valid', sql`${table.detailState} IN ('pending','complete','error')`),
  check('product_detail_counters_valid', sql`${table.detailEpoch}>0 AND ${table.detailGeneration}>0 AND ${table.detailRevision}>=0 AND ${table.detailAttempt} BETWEEN 0 AND 3`),
  // Ozon list/detail source timestamp semantics have not been established.
  check('product_source_time_unknown', sql`${table.listSourceUpdatedAt} IS NULL AND ${table.factsSourceUpdatedAt} IS NULL`),
]);

export const productSourceSnapshot = sqliteTable('product_source_snapshot', {
  id: text('id').primaryKey(), organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(),
  productId: text('product_id').notNull(), facts: text('facts').notNull(), observedAt: integer('observed_at').notNull(),
  sourceUpdatedAt: integer('source_updated_at'),
}, table => [
  foreignKey({ columns: [table.storeId, table.organizationId, table.productId], foreignColumns: [product.storeId, product.organizationId, product.id] }).onDelete('cascade'),
  index('product_snapshot_history_idx').on(table.organizationId, table.storeId, table.productId, table.observedAt, table.id),
  uniqueIndex('product_snapshot_scope_unique').on(table.organizationId, table.storeId, table.productId, table.id),
  check('product_snapshot_facts_json', sql`json_valid(${table.facts}) AND json_type(${table.facts})='object'`),
  check('product_snapshot_source_time_unknown', sql`${table.sourceUpdatedAt} IS NULL`),
]);

// Indexed projection of the current imported snapshots, maintained by SQL triggers.
export const productSku = sqliteTable('product_sku', {
  organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(),
  sku: text('sku').notNull(), productId: text('product_id').notNull(), source: text('source').notNull(),
}, table => [
  primaryKey({columns:[table.organizationId,table.storeId,table.sku,table.productId,table.source]}),
  foreignKey({columns:[table.storeId,table.organizationId,table.productId],foreignColumns:[product.storeId,product.organizationId,product.id]}).onDelete('cascade'),
  index('product_sku_product_idx').on(table.storeId,table.productId),
  check('product_sku_source_valid',sql`${table.source} IN ('list','details')`),
]);
