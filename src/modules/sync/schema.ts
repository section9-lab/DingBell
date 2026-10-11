import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { store } from '../stores/schema.ts';

export const storeCoordinator = sqliteTable('store_coordinator', {
  storeId: text('store_id').primaryKey(), organizationId: text('organization_id').notNull(),
  fence: integer('fence').notNull().default(0), leaseSource: text('lease_source'),
  leaseToken: text('lease_token'), leaseUntil: integer('lease_until'), commitToken: text('commit_token'), blockedUntil: integer('blocked_until'),
}, table => [
  foreignKey({columns:[table.storeId,table.organizationId],foreignColumns:[store.id,store.organizationId]}).onDelete('cascade'),
  uniqueIndex('store_coordinator_scope_unique').on(table.storeId,table.organizationId),
  check('store_coordinator_fence_valid',sql`${table.fence}>=0`),
  check('store_coordinator_lease_complete',sql`(${table.leaseSource} IS NULL AND ${table.leaseToken} IS NULL AND ${table.leaseUntil} IS NULL)
    OR (${table.leaseSource} IS NOT NULL AND ${table.leaseSource} IN ('chat','products','fbs_postings') AND ${table.leaseToken} IS NOT NULL AND ${table.leaseUntil} IS NOT NULL)`),
]);

export const storeSyncSource = sqliteTable('store_sync_source', {
  storeId: text('store_id').notNull(), organizationId: text('organization_id').notNull(), source: text('source').notNull(),
  enabled: integer('enabled',{mode:'boolean'}).notNull().default(false), epoch: integer('epoch').notNull().default(0),
  credentialVersion: integer('credential_version'), dueAt: integer('due_at').notNull(), lastSuccessAt: integer('last_success_at'),
  lastError: text('last_error'), failures: integer('failures').notNull().default(0), lastAttemptAt: integer('last_attempt_at'), updatedAt: integer('updated_at').notNull(),
}, table => [
  primaryKey({columns:[table.storeId,table.source]}),
  foreignKey({columns:[table.storeId,table.organizationId],foreignColumns:[storeCoordinator.storeId,storeCoordinator.organizationId]}).onDelete('cascade'),
  uniqueIndex('store_sync_source_scope_unique').on(table.storeId,table.organizationId,table.source),
  index('store_sync_source_due_idx').on(table.enabled,table.dueAt,table.storeId),
  check('store_sync_source_valid',sql`${table.source} IN ('chat','products','fbs_postings')`),
  check('store_sync_source_counters_valid',sql`${table.epoch}>=0 AND ${table.failures}>=0`),
]);
