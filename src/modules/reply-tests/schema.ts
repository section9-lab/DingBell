import { sql } from 'drizzle-orm';
import { check,foreignKey,index,integer,sqliteTable,text,uniqueIndex } from 'drizzle-orm/sqlite-core';
import { organization } from '../identity/schema.ts';
import { conversation } from '../conversations/schema.ts';

export const replyTestBudget=sqliteTable('reply_test_budget',{
  id:text('id').primaryKey(),organizationId:text('organization_id').notNull().references(()=>organization.id,{onDelete:'restrict'}),
  startsAt:integer('starts_at').notNull(),endsAt:integer('ends_at').notNull(),enabled:integer('enabled',{mode:'boolean'}).notNull().default(false),
  revision:integer('revision').notNull().default(0),limitMicros:integer('limit_micros').notNull(),
  reservedMicros:integer('reserved_micros').notNull().default(0),spentMicros:integer('spent_micros').notNull().default(0),
  maxRuns:integer('max_runs').notNull(),admittedRuns:integer('admitted_runs').notNull().default(0),commitToken:text('commit_token'),
},table=>[
  uniqueIndex('reply_test_budget_scope_unique').on(table.id,table.organizationId),
  index('reply_test_budget_window_idx').on(table.organizationId,table.startsAt,table.endsAt),
  check('reply_test_budget_window_valid',sql`typeof(${table.startsAt})='integer' AND typeof(${table.endsAt})='integer' AND ${table.startsAt} BETWEEN 0 AND 8640000000000000 AND ${table.endsAt}>${table.startsAt} AND ${table.endsAt}<=8640000000000000`),
  check('reply_test_budget_amounts_valid',sql`typeof(${table.limitMicros})='integer' AND typeof(${table.reservedMicros})='integer' AND typeof(${table.spentMicros})='integer'
    AND ${table.limitMicros} BETWEEN 0 AND 9007199254740991 AND ${table.reservedMicros} BETWEEN 0 AND 9007199254740991 AND ${table.spentMicros} BETWEEN 0 AND 9007199254740991`),
  check('reply_test_budget_counts_valid',sql`typeof(${table.maxRuns})='integer' AND typeof(${table.admittedRuns})='integer' AND ${table.maxRuns} BETWEEN 1 AND 1000000 AND ${table.admittedRuns} BETWEEN 0 AND ${table.maxRuns}`),
  check('reply_test_budget_control_valid',sql`typeof(${table.enabled})='integer' AND ${table.enabled} IN (0,1) AND typeof(${table.revision})='integer' AND ${table.revision} BETWEEN 0 AND 9007199254740991`),
]);

// Financial admission and immutable native-runtime binding, not an execution scheduler.
export const replyTestRun=sqliteTable('reply_test_run',{
  id:text('id').primaryKey(),organizationId:text('organization_id').notNull(),storeId:text('store_id').notNull(),conversationId:text('conversation_id').notNull(),
  requestId:text('request_id').notNull(),actorUserId:text('actor_user_id').notNull(),actorMemberId:text('actor_member_id').notNull(),
  budgetId:text('budget_id').notNull(),payload:text('payload').notNull(),payloadHash:text('payload_hash').notNull(),config:text('config').notNull(),
  reservedMicros:integer('reserved_micros').notNull(),createdAt:integer('created_at').notNull(),receipt:text('receipt'),
  providerRequestClaimedAt:integer('provider_request_claimed_at'),settlement:text('settlement').notNull().default('held'),usage:text('usage'),
  chargedMicros:integer('charged_micros'),settledAt:integer('settled_at'),releaseEvidence:text('release_evidence'),
},table=>[
  foreignKey({columns:[table.conversationId,table.organizationId,table.storeId],foreignColumns:[conversation.id,conversation.organizationId,conversation.storeId]}).onDelete('restrict'),
  foreignKey({columns:[table.budgetId,table.organizationId],foreignColumns:[replyTestBudget.id,replyTestBudget.organizationId]}).onDelete('restrict'),
  uniqueIndex('reply_test_request_unique').on(table.organizationId,table.requestId),
  index('reply_test_financial_idx').on(table.settlement,table.createdAt,table.id),
  check('reply_test_payload_valid',sql`json_valid(${table.payload}) AND json_type(${table.payload})='object' AND length(CAST(${table.payload} AS BLOB)) BETWEEN 1 AND 98304
    AND length(${table.payloadHash})=64 AND ${table.payloadHash} NOT GLOB '*[^0-9a-f]*' AND json_valid(${table.config}) AND json_type(${table.config})='object'`),
  check('reply_test_receipt_valid',sql`${table.receipt} IS NULL OR (json_valid(${table.receipt}) AND json_type(${table.receipt})='object')`),
  check('reply_test_amount_valid',sql`typeof(${table.reservedMicros})='integer' AND ${table.reservedMicros} BETWEEN 0 AND 9007199254740991
    AND (${table.chargedMicros} IS NULL OR (typeof(${table.chargedMicros})='integer' AND ${table.chargedMicros} BETWEEN 0 AND 9007199254740991))`),
  check('reply_test_time_valid',sql`typeof(${table.createdAt})='integer' AND ${table.createdAt} BETWEEN 0 AND 8640000000000000
    AND (${table.settledAt} IS NULL OR (typeof(${table.settledAt})='integer' AND ${table.settledAt} BETWEEN ${table.createdAt} AND 8640000000000000))`),
  check('reply_test_permit_valid',sql`${table.providerRequestClaimedAt} IS NULL OR (typeof(${table.providerRequestClaimedAt})='integer' AND ${table.providerRequestClaimedAt} BETWEEN ${table.createdAt} AND 8640000000000000 AND ${table.settlement}<>'released')`),
  check('reply_test_settlement_valid',sql`(${table.settlement}='held' AND ${table.usage} IS NULL AND ${table.chargedMicros} IS NULL AND ${table.settledAt} IS NULL AND ${table.releaseEvidence} IS NULL)
    OR (${table.settlement}='settled' AND ${table.receipt} IS NOT NULL AND ${table.providerRequestClaimedAt} IS NOT NULL AND ${table.usage} IS NOT NULL AND json_valid(${table.usage}) AND json_type(${table.usage})='object' AND ${table.chargedMicros} IS NOT NULL AND ${table.settledAt} IS NOT NULL AND ${table.releaseEvidence} IS NULL)
    OR (${table.settlement}='released' AND ${table.providerRequestClaimedAt} IS NULL AND ${table.usage} IS NULL AND ${table.chargedMicros} IS NOT NULL AND ${table.chargedMicros}=0 AND ${table.settledAt} IS NOT NULL AND ${table.releaseEvidence} IS NOT NULL AND json_valid(${table.releaseEvidence}) AND json_type(${table.releaseEvidence})='object')`),
]);

// Deployment-wide query allowance. Reserved ceilings are not actual provider invoices.
export const replyTestQueryUsage=sqliteTable('reply_test_query_usage',{
  day:text('day').primaryKey(),reservedMicros:integer('reserved_micros').notNull(),queries:integer('queries').notNull(),
},table=>[
  check('reply_test_query_day_valid',sql`length(${table.day})=10 AND date(${table.day}) IS NOT NULL AND date(${table.day})=${table.day}`),
  check('reply_test_query_usage_valid',sql`typeof(${table.reservedMicros})='integer' AND ${table.reservedMicros} BETWEEN 0 AND 9007199254740991 AND typeof(${table.queries})='integer' AND ${table.queries} BETWEEN 1 AND 1000000`),
]);
export const replyTestQuery=sqliteTable('reply_test_query',{
  id:text('id').primaryKey(),organizationId:text('organization_id').notNull(),storeId:text('store_id').notNull(),conversationId:text('conversation_id').notNull(),
  requestId:text('request_id').notNull(),actorUserId:text('actor_user_id').notNull(),actorMemberId:text('actor_member_id').notNull(),budgetId:text('budget_id').notNull(),
  payload:text('payload').notNull(),payloadHash:text('payload_hash').notNull(),reservedMicros:integer('reserved_micros').notNull(),
  quotaDay:text('quota_day').notNull(),admissionToken:text('admission_token').notNull(),createdAt:integer('created_at').notNull(),attemptedAt:integer('attempted_at'),
  vectors:text('vectors'),evidence:text('evidence'),errorCode:text('error_code'),
},table=>[
  foreignKey({columns:[table.conversationId,table.organizationId,table.storeId],foreignColumns:[conversation.id,conversation.organizationId,conversation.storeId]}).onDelete('restrict'),
  foreignKey({columns:[table.budgetId,table.organizationId],foreignColumns:[replyTestBudget.id,replyTestBudget.organizationId]}).onDelete('restrict'),
  uniqueIndex('reply_test_query_request_unique').on(table.organizationId,table.requestId),
  index('reply_test_query_history_idx').on(table.organizationId,table.actorMemberId,table.createdAt,table.id),
  check('reply_test_query_payload_valid',sql`json_valid(${table.payload}) AND json_type(${table.payload})='object' AND length(CAST(${table.payload} AS BLOB)) BETWEEN 1 AND 98304
    AND length(${table.payloadHash})=64 AND ${table.payloadHash} NOT GLOB '*[^0-9a-f]*'`),
  check('reply_test_query_amount_valid',sql`typeof(${table.reservedMicros})='integer' AND ${table.reservedMicros} BETWEEN 0 AND 9007199254740991`),
  check('reply_test_query_time_valid',sql`typeof(${table.createdAt})='integer' AND ${table.createdAt} BETWEEN 0 AND 8640000000000000
    AND date(${table.quotaDay}) IS NOT NULL AND date(${table.quotaDay})=${table.quotaDay}
    AND (${table.attemptedAt} IS NULL OR (typeof(${table.attemptedAt})='integer' AND ${table.attemptedAt} BETWEEN ${table.createdAt} AND 8640000000000000))`),
  check('reply_test_query_vectors_valid',sql`${table.vectors} IS NULL OR (${table.attemptedAt} IS NOT NULL AND json_valid(${table.vectors}) AND json_type(${table.vectors})='array'
    AND json_array_length(${table.vectors})=1024 AND length(CAST(${table.vectors} AS BLOB))<=49152)`),
  check('reply_test_query_evidence_valid',sql`${table.evidence} IS NULL OR (${table.vectors} IS NOT NULL AND json_valid(${table.evidence}) AND json_type(${table.evidence})='object' AND length(CAST(${table.evidence} AS BLOB))<=98304)`),
  check('reply_test_query_error_valid',sql`${table.errorCode} IS NULL OR (${table.attemptedAt} IS NOT NULL AND ${table.vectors} IS NULL AND ${table.errorCode}='EMBEDDING_UNCONFIRMED')`),
]);

export const replyTestBudgetAudit=sqliteTable('reply_test_budget_audit',{
  id:text('id').primaryKey(),organizationId:text('organization_id').notNull(),budgetId:text('budget_id').notNull(),
  actorUserId:text('actor_user_id').notNull(),actorMemberId:text('actor_member_id').notNull(),actorName:text('actor_name').notNull(),
  action:text('action',{enum:['create','set_enabled']}).notNull(),payload:text('payload').notNull(),
  revision:integer('revision').notNull(),enabled:integer('enabled',{mode:'boolean'}).notNull(),createdAt:integer('created_at').notNull(),
},table=>[
  foreignKey({columns:[table.budgetId,table.organizationId],foreignColumns:[replyTestBudget.id,replyTestBudget.organizationId]}).onDelete('restrict'),
  index('reply_test_budget_audit_history_idx').on(table.organizationId,table.createdAt,table.id),
  check('reply_test_budget_audit_payload_valid',sql`json_valid(${table.payload}) AND json_type(${table.payload})='object' AND length(CAST(${table.payload} AS BLOB)) BETWEEN 1 AND 4096`),
  check('reply_test_budget_audit_action_valid',sql`${table.action} IN ('create','set_enabled') AND typeof(${table.enabled})='integer' AND ${table.enabled} IN (0,1)
    AND typeof(${table.revision})='integer' AND ${table.revision} BETWEEN 0 AND 9007199254740991 AND (${table.action}<>'create' OR (${table.revision}=0 AND ${table.enabled}=0))`),
  check('reply_test_budget_audit_time_valid',sql`typeof(${table.createdAt})='integer' AND ${table.createdAt} BETWEEN 0 AND 8640000000000000`),
]);
