import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const probeMail = sqliteTable('probe_mail', {
  email: text('email').notNull(),
  kind: text('kind').notNull(),
  payload: text('payload', { mode: 'json' }).$type<Record<string, string>>().notNull(),
  createdAt: integer('created_at').notNull(),
}, table => [primaryKey({ columns: [table.email, table.kind] })]);

export const probeDocument = sqliteTable('probe_document', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  content: text('content').notNull(),
});

export const probeBootstrap = sqliteTable('probe_bootstrap', {
  id: integer('id').primaryKey(),
  claimId: text('claim_id').notNull().unique(),
  expectedUserId: text('expected_user_id').notNull(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  organizationName: text('organization_name').notNull(),
  state: text('state', { enum: ['provisioning', 'initialized'] }).notNull(),
  executionId: text('execution_id'),
  leaseUntil: integer('lease_until').notNull().default(0),
  userId: text('user_id'),
  organizationId: text('organization_id'),
});
