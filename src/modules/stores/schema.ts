import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { member, organization } from '../identity/schema.ts';

export const store = sqliteTable('store', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  platform: text('platform', { enum: ['ozon'] }).notNull().default('ozon'),
  platformStoreId: text('platform_store_id').notNull(),
  status: text('status', { enum: ['unverified', 'verified', 'partial', 'attention', 'paused', 'disconnected'] }).notNull().default('unverified'),
  outboundEnabled: integer('outbound_enabled', { mode: 'boolean' }).notNull().default(false),
  revision: integer('revision').notNull().default(1),
  credentialVersion: integer('credential_version').notNull().default(1),
  credentialKeyVersion: text('credential_key_version'),
  credentialNonce: text('credential_nonce'),
  credentialCiphertext: text('credential_ciphertext'),
  capabilities: text('capabilities'),
  checkedAt: integer('checked_at', { mode: 'timestamp_ms' }),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  checkToken: text('check_token'),
  checkUntil: integer('check_until', { mode: 'timestamp_ms' }),
  nextCheckAt: integer('next_check_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, table => [
  uniqueIndex('store_platform_account_unique').on(table.organizationId, table.platform, table.platformStoreId),
  uniqueIndex('store_id_organization_unique').on(table.id, table.organizationId),
  index('store_organization_created_idx').on(table.organizationId, table.createdAt, table.id),
  check('store_outbound_enabled_valid', sql`${table.outboundEnabled} IN (0,1)`),
  check('store_platform_valid', sql`${table.platform} = 'ozon'`),
  check('store_status_valid', sql`${table.status} IN ('unverified','verified','partial','attention','paused','disconnected')`),
  check('store_revision_positive', sql`${table.revision} > 0 AND ${table.credentialVersion} > 0`),
  check('store_credential_envelope_complete', sql`(${table.credentialKeyVersion} IS NULL AND ${table.credentialNonce} IS NULL AND ${table.credentialCiphertext} IS NULL)
    OR (${table.credentialKeyVersion} IS NOT NULL AND ${table.credentialNonce} IS NOT NULL AND ${table.credentialCiphertext} IS NOT NULL)`),
  check('store_capabilities_json', sql`${table.capabilities} IS NULL OR json_valid(${table.capabilities})`),
]);

export const storeGrant = sqliteTable('store_grant', {
  organizationId: text('organization_id').notNull(),
  storeId: text('store_id').notNull(),
  memberId: text('member_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, table => [
  primaryKey({ columns: [table.storeId, table.memberId] }),
  foreignKey({ columns: [table.storeId, table.organizationId], foreignColumns: [store.id, store.organizationId] }).onDelete('cascade'),
  foreignKey({ columns: [table.memberId, table.organizationId], foreignColumns: [member.id, member.organizationId] }).onDelete('cascade'),
  index('store_grant_member_idx').on(table.memberId, table.organizationId, table.storeId),
]);

export const storeAuditEvent = sqliteTable('store_audit_event', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull(),
  organizationId: text('organization_id').notNull(),
  storeId: text('store_id').notNull(),
  actorUserId: text('actor_user_id'),
  action: text('action').notNull(),
  outcome: text('outcome').notNull(),
  targetMemberId: text('target_member_id'),
  fromRevision: integer('from_revision'),
  toRevision: integer('to_revision'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, table => [
  index('store_audit_request_idx').on(table.requestId),
  index('store_audit_organization_time_idx').on(table.organizationId, table.createdAt, table.id),
]);
