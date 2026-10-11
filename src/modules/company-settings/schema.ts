import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { organization } from '../identity/schema.ts';

export const companySettings = sqliteTable('company_settings', {
  organizationId: text('organization_id').primaryKey().references(() => organization.id, { onDelete: 'cascade' }),
  timeZone: text('time_zone').notNull(),
  version: integer('version').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, table => [check('company_settings_version_valid', sql`typeof(${table.version})='integer' AND ${table.version} BETWEEN 1 AND 9007199254740991`)]);

export const companySettingsAuditEvent = sqliteTable('company_settings_audit_event', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull(),
  organizationId: text('organization_id').notNull(),
  actorUserId: text('actor_user_id').notNull(),
  outcome: text('outcome').notNull(),
  fromVersion: integer('from_version').notNull(),
  toVersion: integer('to_version'),
  beforeTimeZone: text('before_time_zone').notNull(),
  requestedTimeZone: text('requested_time_zone').notNull(),
  createdAt: integer('created_at').notNull(),
}, table => [
  index('company_settings_audit_request_idx').on(table.requestId),
  index('company_settings_audit_organization_time_idx').on(table.organizationId, table.createdAt, table.id),
]);
