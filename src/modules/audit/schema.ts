import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const identityAuditEvent = sqliteTable('identity_audit_event', {
  id: text('id').primaryKey(),
  requestId: text('request_id').notNull(),
  action: text('action').notNull(),
  outcome: text('outcome').notNull(),
  actorUserId: text('actor_user_id'),
  organizationId: text('organization_id'),
  targetMemberId: text('target_member_id'),
  beforeRole: text('before_role'),
  afterRole: text('after_role'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, table => [
  index('identity_audit_request_idx').on(table.requestId),
  index('identity_audit_organization_time_idx').on(table.organizationId, table.createdAt),
]);
