import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { store } from '../stores/schema.ts';
import {storeSyncSource} from '../sync/schema.ts';

function postingSchema(prefix:'fbs'|'fbo'|'fbp') {
const fbsSyncWindow = sqliteTable(`${prefix}_sync_window`, {
  storeId: text('store_id').primaryKey(), organizationId: text('organization_id').notNull(),
  epoch: integer('epoch').notNull(), generation: integer('generation').notNull().default(1), revision: integer('revision').notNull().default(0),
  historyStart: integer('history_start').notNull(), since: integer('since').notNull(), to: integer('to').notNull(),
  cursor: text('cursor'), recentCursors: text('recent_cursors').notNull().default('[]'),
  state: text('state').notNull().default('active'), dueAt: integer('due_at').notNull(),
  lastKind: text('last_kind').notNull().default('details'), lastCompletedTo: integer('last_completed_to'),
}, table => [
  foreignKey({columns:[table.storeId,table.organizationId],foreignColumns:[store.id,store.organizationId]}).onDelete('cascade'),
  check(`${prefix}_window_counters_valid`,sql`${table.epoch}>0 AND ${table.generation}>0 AND ${table.revision}>=0`),
  check(`${prefix}_window_bounds_valid`,sql`${table.to}>${table.since} AND ${table.to}-${table.since}<=2678400000 AND ${table.historyStart}<=${table.since}`),
  check(`${prefix}_window_state_valid`,sql`${table.state} IN ('active','waiting') AND ${table.lastKind} IN ('list','details')`),
  check(`${prefix}_window_history_valid`,sql`json_valid(${table.recentCursors}) AND json_type(${table.recentCursors})='array' AND json_array_length(${table.recentCursors})<=8`),
]);

const fbsPosting = sqliteTable(`${prefix}_posting`, {
  postingNumber: text('posting_number').notNull(), organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(),
  orderId: text('order_id').notNull(), orderNumber: text('order_number').notNull(),
  listFacts: text('list_facts'), listObservedAt: integer('list_observed_at'), detailFacts: text('detail_facts'), detailObservedAt: integer('detail_observed_at'),
  detailEpoch: integer('detail_epoch').notNull(), detailGeneration: integer('detail_generation').notNull(), detailRevision: integer('detail_revision').notNull().default(0),
  detailState: text('detail_state').notNull().default('pending'), detailAttempt: integer('detail_attempt').notNull().default(0),
  detailDueAt: integer('detail_due_at').notNull(), detailError: text('detail_error'),
}, table => [
  primaryKey({columns:[table.storeId,table.postingNumber]}),
  foreignKey({columns:[table.storeId,table.organizationId],foreignColumns:[store.id,store.organizationId]}).onDelete('cascade'),
  uniqueIndex(`${prefix}_posting_scope_unique`).on(table.storeId,table.organizationId,table.postingNumber),
  index(`${prefix}_posting_detail_due_idx`).on(table.storeId,table.detailEpoch,table.detailState,table.detailDueAt,table.postingNumber),
  index(`${prefix}_posting_order_idx`).on(table.organizationId,table.storeId,table.orderId),
  index(`${prefix}_posting_number_idx`).on(table.organizationId,table.storeId,table.orderNumber,table.orderId,table.postingNumber),
  check(`${prefix}_posting_list_json`,sql`${table.listFacts} IS NULL OR (json_valid(${table.listFacts}) AND json_type(${table.listFacts})='object')`),
  check(`${prefix}_posting_detail_json`,sql`${table.detailFacts} IS NULL OR (json_valid(${table.detailFacts}) AND json_type(${table.detailFacts})='object')`),
  check(`${prefix}_posting_detail_state_valid`,sql`${table.detailState} IN ('pending','complete','error')`),
  check(`${prefix}_posting_detail_counters_valid`,sql`${table.detailEpoch}>0 AND ${table.detailGeneration}>0 AND ${table.detailRevision}>=0 AND ${table.detailAttempt} BETWEEN 0 AND 3`),
]);

const fbsPostingObservation = sqliteTable(`${prefix}_posting_observation`, {
  id: text('id').primaryKey(), organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(),
  postingNumber: text('posting_number').notNull(), source: text('source').notNull(), facts: text('facts').notNull(),
  observedAt: integer('observed_at').notNull(), sourceUpdatedAt: integer('source_updated_at'),
}, table => [
  foreignKey({columns:[table.storeId,table.organizationId,table.postingNumber],foreignColumns:[fbsPosting.storeId,fbsPosting.organizationId,fbsPosting.postingNumber]}).onDelete('cascade'),
  index(`${prefix}_observation_history_idx`).on(table.organizationId,table.storeId,table.postingNumber,table.source,table.observedAt,table.id),
  check(`${prefix}_observation_source_valid`,sql`${table.source} IN ('list','details')`),
  check(`${prefix}_observation_facts_json`,sql`json_valid(${table.facts}) AND json_type(${table.facts})='object'`),
  check(`${prefix}_observation_source_time_unknown`,sql`${table.sourceUpdatedAt} IS NULL`),
]);
return {window:fbsSyncWindow,posting:fbsPosting,observation:fbsPostingObservation};
}
export const {window:fbsSyncWindow,posting:fbsPosting,observation:fbsPostingObservation}=postingSchema('fbs');
export const {window:fboSyncWindow,posting:fboPosting,observation:fboPostingObservation}=postingSchema('fbo');
export const {window:fbpSyncWindow,posting:fbpPosting,observation:fbpPostingObservation}=postingSchema('fbp');
export const postingHistorySync=sqliteTable('posting_history_sync',{
 storeId:text('store_id').notNull(),organizationId:text('organization_id').notNull(),source:text('source').notNull(),epoch:integer('epoch').notNull(),
 commandRevision:integer('command_revision').notNull().default(1),generation:integer('generation').notNull().default(1),revision:integer('revision').notNull().default(0),
 requestedFrom:integer('requested_from').notNull(),requestedTo:integer('requested_to').notNull(),coveredFrom:integer('covered_from').notNull(),
 since:integer('since').notNull(),to:integer('to').notNull(),cursor:text('cursor'),recentCursors:text('recent_cursors').notNull().default('[]'),
 state:text('state').notNull().default('active'),dueAt:integer('due_at').notNull(),pagesRead:integer('pages_read').notNull().default(0),lastLane:text('last_lane').notNull().default('details'),
},table=>[
 primaryKey({columns:[table.storeId,table.source]}),
 foreignKey({columns:[table.storeId,table.organizationId,table.source],foreignColumns:[storeSyncSource.storeId,storeSyncSource.organizationId,storeSyncSource.source]}).onDelete('cascade'),
 check('posting_history_source',sql`${table.source} IN ('fbs_postings','fbo_postings','fbp_postings')`),
 check('posting_history_counters',sql`${table.epoch}>0 AND ${table.commandRevision}>0 AND ${table.generation}>0 AND ${table.revision}>=0 AND ${table.pagesRead}>=0`),
 check('posting_history_range',sql`${table.requestedFrom}>=946684800000 AND ${table.requestedFrom}<${table.requestedTo} AND ${table.coveredFrom} BETWEEN ${table.requestedFrom} AND ${table.requestedTo}`),
 check('posting_history_window',sql`${table.since}>=${table.requestedFrom} AND ${table.to}>${table.since} AND ${table.to}-${table.since}<=2678400000 AND ${table.to}<=${table.requestedTo}`),
 check('posting_history_state',sql`${table.state} IN ('active','complete','cancelled') AND ${table.lastLane} IN ('live','history','details')`),
 check('posting_history_cursors',sql`json_valid(${table.recentCursors}) AND json_type(${table.recentCursors})='array' AND json_array_length(${table.recentCursors})<=8`),
]);
