import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { organization } from '../identity/schema.ts';

export const replyPolicy=sqliteTable('reply_policy',{
  organizationId:text('organization_id').notNull().references(()=>organization.id,{onDelete:'cascade'}),
  id:text('id').notNull(),kind:text('kind').notNull(),version:integer('version').notNull(),
  draftRevision:integer('draft_revision').notNull(),testedRevision:integer('tested_revision'),testedTimeZone:text('tested_time_zone'),
  draftBaseRevision:integer('draft_base_revision'),draftRollbackOf:integer('draft_rollback_of'),draftConfig:text('draft_config').notNull(),
  publishedRevision:integer('published_revision'),enabled:integer('enabled',{mode:'boolean'}).notNull().default(false),
  publishedBy:text('published_by'),publishedAt:integer('published_at'),publishedRequestId:text('published_request_id'),
  publishedTimeZone:text('published_time_zone'),updatedAt:integer('updated_at').notNull(),
},table=>[
  primaryKey({columns:[table.organizationId,table.id]}),
  check('reply_policy_kind_valid',sql`${table.kind} IN ('automatic','notification') AND json_valid(${table.draftConfig}) AND json_extract(${table.draftConfig},'$.kind')=${table.kind}`),
  check('reply_policy_versions_valid',sql`typeof(${table.version})='integer' AND ${table.version} BETWEEN 1 AND 9007199254740991
    AND typeof(${table.draftRevision})='integer' AND ${table.draftRevision} BETWEEN 1 AND ${table.version}
    AND (${table.testedRevision} IS NULL OR ${table.testedRevision}=${table.draftRevision})
    AND (${table.publishedRevision} IS NULL OR ${table.publishedRevision} BETWEEN 1 AND ${table.version})`),
  check('reply_policy_enabled_valid',sql`${table.enabled} IN (0,1) AND (${table.enabled}=0 OR ${table.publishedRevision} IS NOT NULL)`),
]);
export const policyVersion=sqliteTable('policy_version',{
  organizationId:text('organization_id').notNull(),policyId:text('policy_id').notNull(),revision:integer('revision').notNull(),
  schemaVersion:integer('schema_version').notNull(),config:text('config').notNull(),timeZone:text('time_zone').notNull(),
  publishedBy:text('published_by').notNull(),publishedAt:integer('published_at').notNull(),requestId:text('request_id').notNull(),rollbackOf:integer('rollback_of'),
},table=>[
  primaryKey({columns:[table.organizationId,table.policyId,table.revision]}),
  foreignKey({columns:[table.organizationId,table.policyId],foreignColumns:[replyPolicy.organizationId,replyPolicy.id]}).onDelete('cascade'),
  check('policy_version_content_valid',sql`json_valid(${table.config}) AND ${table.schemaVersion}=1 AND ${table.revision}>0`),
]);
export const replyPolicyAuditEvent=sqliteTable('reply_policy_audit_event',{
  id:text('id').primaryKey(),requestId:text('request_id').notNull(),organizationId:text('organization_id').notNull(),
  policyId:text('policy_id').notNull(),actorUserId:text('actor_user_id').notNull(),action:text('action').notNull(),outcome:text('outcome').notNull(),
  expectedVersion:integer('expected_version').notNull(),createdAt:integer('created_at').notNull(),
},table=>[
  index('reply_policy_audit_request_idx').on(table.requestId),
  index('reply_policy_audit_organization_time_idx').on(table.organizationId,table.createdAt,table.id),
]);
