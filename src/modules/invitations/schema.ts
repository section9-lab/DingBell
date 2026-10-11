import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// No cascading foreign keys: a removed member must not erase the completed grant.
export const invitationFlow = sqliteTable('invitation_flow', {
  invitationId: text('invitation_id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  memberId: text('member_id').notNull().unique(),
  registrationUserId: text('registration_user_id'),
  acceptingUserId: text('accepting_user_id'),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});
