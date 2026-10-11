import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const bootstrapInstallation = sqliteTable('bootstrap_installation', {
  id: integer('id').primaryKey(),
  claimId: text('claim_id').notNull().unique(),
  expectedUserId: text('expected_user_id').notNull().unique(),
  expectedOrganizationId: text('expected_organization_id').notNull().unique(),
  expectedMemberId: text('expected_member_id').notNull().unique(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  organizationName: text('organization_name').notNull(),
  state: text('state', { enum: ['provisioning', 'initialized'] }).notNull(),
  executionId: text('execution_id'),
  leaseUntil: integer('lease_until').notNull().default(0),
  verificationRequestedAt: integer('verification_requested_at'),
  userId: text('user_id'),
  organizationId: text('organization_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, table => [
  check('bootstrap_singleton', sql`${table.id} = 1`),
  check('bootstrap_state', sql`${table.state} IN ('provisioning', 'initialized')`),
]);

export type BootstrapJob = typeof bootstrapInstallation.$inferSelect;
