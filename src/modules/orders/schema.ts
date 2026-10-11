import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { store } from '../stores/schema.ts';

export const fbsSyncWindow = sqliteTable('fbs_sync_window', {
  storeId: text('store_id').primaryKey(), organizationId: text('organization_id').notNull(),
  epoch: integer('epoch').notNull(), generation: integer('generation').notNull().default(1), revision: integer('revision').notNull().default(0),
  historyStart: integer('history_start').notNull(), since: integer('since').notNull(), to: integer('to').notNull(),
  cursor: text('cursor'), recentCursors: text('recent_cursors').notNull().default('[]'),
  state: text('state').notNull().default('active'), dueAt: integer('due_at').notNull(),
  lastKind: text('last_kind').notNull().default('details'), lastCompletedTo: integer('last_completed_to'),
}, table => [
  foreignKey({columns:[table.storeId,table.organizationId],foreignColumns:[store.id,store.organizationId]}).onDelete('cascade'),
  check('fbs_window_counters_valid',sql`${table.epoch}>0 AND ${table.generation}>0 AND ${table.revision}>=0`),
  check('fbs_window_bounds_valid',sql`${table.to}>${table.since} AND ${table.to}-${table.since}<=2678400000 AND ${table.historyStart}<=${table.since}`),
  check('fbs_window_state_valid',sql`${table.state} IN ('active','waiting') AND ${table.lastKind} IN ('list','details')`),
  check('fbs_window_history_valid',sql`json_valid(${table.recentCursors}) AND json_type(${table.recentCursors})='array' AND json_array_length(${table.recentCursors})<=8`),
]);

export const fbsPosting = sqliteTable('fbs_posting', {
  postingNumber: text('posting_number').notNull(), organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(),
  orderId: text('order_id').notNull(), orderNumber: text('order_number').notNull(),
  listFacts: text('list_facts'), listObservedAt: integer('list_observed_at'), detailFacts: text('detail_facts'), detailObservedAt: integer('detail_observed_at'),
  detailEpoch: integer('detail_epoch').notNull(), detailGeneration: integer('detail_generation').notNull(), detailRevision: integer('detail_revision').notNull().default(0),
  detailState: text('detail_state').notNull().default('pending'), detailAttempt: integer('detail_attempt').notNull().default(0),
  detailDueAt: integer('detail_due_at').notNull(), detailError: text('detail_error'),
}, table => [
  primaryKey({columns:[table.storeId,table.postingNumber]}),
  foreignKey({columns:[table.storeId,table.organizationId],foreignColumns:[store.id,store.organizationId]}).onDelete('cascade'),
  uniqueIndex('fbs_posting_scope_unique').on(table.storeId,table.organizationId,table.postingNumber),
  index('fbs_posting_detail_due_idx').on(table.storeId,table.detailEpoch,table.detailState,table.detailDueAt,table.postingNumber),
  index('fbs_posting_order_idx').on(table.organizationId,table.storeId,table.orderId),
  index('fbs_posting_number_idx').on(table.organizationId,table.storeId,table.orderNumber,table.orderId,table.postingNumber),
  check('fbs_posting_list_json',sql`${table.listFacts} IS NULL OR (json_valid(${table.listFacts}) AND json_type(${table.listFacts})='object')`),
  check('fbs_posting_detail_json',sql`${table.detailFacts} IS NULL OR (json_valid(${table.detailFacts}) AND json_type(${table.detailFacts})='object')`),
  check('fbs_posting_detail_state_valid',sql`${table.detailState} IN ('pending','complete','error')`),
  check('fbs_posting_detail_counters_valid',sql`${table.detailEpoch}>0 AND ${table.detailGeneration}>0 AND ${table.detailRevision}>=0 AND ${table.detailAttempt} BETWEEN 0 AND 3`),
]);

export const fbsPostingObservation = sqliteTable('fbs_posting_observation', {
  id: text('id').primaryKey(), organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(),
  postingNumber: text('posting_number').notNull(), source: text('source').notNull(), facts: text('facts').notNull(),
  observedAt: integer('observed_at').notNull(), sourceUpdatedAt: integer('source_updated_at'),
}, table => [
  foreignKey({columns:[table.storeId,table.organizationId,table.postingNumber],foreignColumns:[fbsPosting.storeId,fbsPosting.organizationId,fbsPosting.postingNumber]}).onDelete('cascade'),
  index('fbs_observation_history_idx').on(table.organizationId,table.storeId,table.postingNumber,table.source,table.observedAt,table.id),
  check('fbs_observation_source_valid',sql`${table.source} IN ('list','details')`),
  check('fbs_observation_facts_json',sql`json_valid(${table.facts}) AND json_type(${table.facts})='object'`),
  check('fbs_observation_source_time_unknown',sql`${table.sourceUpdatedAt} IS NULL`),
]);
