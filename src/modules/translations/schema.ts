import { sql } from 'drizzle-orm';
import { check,foreignKey,index,integer,sqliteTable,text,uniqueIndex } from 'drizzle-orm/sqlite-core';
import { organization } from '../identity/schema.ts';
import { conversation } from '../conversations/schema.ts';

// Estimated company translation costs only; no supplier invoice or automatic refill.
export const translationBudgetBucket=sqliteTable('translation_budget_bucket',{
  id:text('id').primaryKey(),organizationId:text('organization_id').notNull().references(()=>organization.id,{onDelete:'restrict'}),
  startsAt:integer('starts_at').notNull(),endsAt:integer('ends_at').notNull(),enabled:integer('enabled',{mode:'boolean'}).notNull().default(false),
  revision:integer('revision').notNull().default(0),limitMicros:integer('limit_micros').notNull(),reservedMicros:integer('reserved_micros').notNull().default(0),
  spentMicros:integer('spent_micros').notNull().default(0),commitToken:text('commit_token'),
},table=>[
  uniqueIndex('translation_budget_scope_unique').on(table.id,table.organizationId),
  index('translation_budget_window_idx').on(table.organizationId,table.startsAt,table.endsAt),
  check('translation_budget_window_valid',sql`typeof(${table.startsAt})='integer' AND typeof(${table.endsAt})='integer' AND ${table.startsAt} BETWEEN 0 AND 8640000000000000 AND ${table.endsAt}>${table.startsAt} AND ${table.endsAt}<=8640000000000000`),
  check('translation_budget_amounts_valid',sql`typeof(${table.limitMicros})='integer' AND typeof(${table.reservedMicros})='integer' AND typeof(${table.spentMicros})='integer' AND ${table.limitMicros} BETWEEN 0 AND 9007199254740991 AND ${table.reservedMicros} BETWEEN 0 AND 9007199254740991 AND ${table.spentMicros} BETWEEN 0 AND 9007199254740991`),
  check('translation_budget_control_valid',sql`typeof(${table.enabled})='integer' AND typeof(${table.revision})='integer' AND ${table.enabled} IN (0,1) AND ${table.revision} BETWEEN 0 AND 9007199254740991`),
]);

// Financial admission + Flue association, not a second execution state machine.
export const replyPreviewRun=sqliteTable('reply_preview_run',{
  id:text('id').primaryKey(),organizationId:text('organization_id').notNull(),storeId:text('store_id').notNull(),conversationId:text('conversation_id').notNull(),
  requestId:text('request_id').notNull(),actorUserId:text('actor_user_id').notNull(),actorMemberId:text('actor_member_id').notNull(),
  source:text('source').notNull(),sourceHash:text('source_hash').notNull(),sourceRevision:integer('source_revision').notNull(),
  budgetId:text('budget_id').notNull(),config:text('config').notNull(),reservedMicros:integer('reserved_micros').notNull(),createdAt:integer('created_at').notNull(),
  receipt:text('receipt'),settlement:text('settlement').notNull().default('held'),usage:text('usage'),chargedMicros:integer('charged_micros'),settledAt:integer('settled_at'),releaseEvidence:text('release_evidence'),
  providerRequestClaimedAt:integer('provider_request_claimed_at'),
},table=>[
  foreignKey({columns:[table.conversationId,table.organizationId,table.storeId],foreignColumns:[conversation.id,conversation.organizationId,conversation.storeId]}).onDelete('restrict'),
  foreignKey({columns:[table.budgetId,table.organizationId],foreignColumns:[translationBudgetBucket.id,translationBudgetBucket.organizationId]}).onDelete('restrict'),
  uniqueIndex('reply_preview_request_unique').on(table.organizationId,table.requestId),
  index('reply_preview_financial_idx').on(table.settlement,table.createdAt,table.id),
  check('reply_preview_identity_valid',sql`length(${table.source}) BETWEEN 1 AND 1000 AND length(${table.sourceHash})=64 AND typeof(${table.sourceRevision})='integer' AND ${table.sourceRevision} BETWEEN 0 AND 9007199254740991`),
  check('reply_preview_json_valid',sql`json_valid(${table.config}) AND json_type(${table.config})='object' AND (${table.receipt} IS NULL OR (json_valid(${table.receipt}) AND json_type(${table.receipt})='object'))`),
  check('reply_preview_amount_valid',sql`typeof(${table.reservedMicros})='integer' AND ${table.reservedMicros} BETWEEN 0 AND 9007199254740991 AND (${table.chargedMicros} IS NULL OR (typeof(${table.chargedMicros})='integer' AND ${table.chargedMicros} BETWEEN 0 AND 9007199254740991))`),
  check('reply_preview_time_valid',sql`typeof(${table.createdAt})='integer' AND ${table.createdAt} BETWEEN 0 AND 8640000000000000 AND (${table.settledAt} IS NULL OR (typeof(${table.settledAt})='integer' AND ${table.settledAt} BETWEEN ${table.createdAt} AND 8640000000000000))`),
  check('reply_preview_provider_permit_valid',sql`${table.providerRequestClaimedAt} IS NULL OR (typeof(${table.providerRequestClaimedAt})='integer' AND ${table.providerRequestClaimedAt} BETWEEN ${table.createdAt} AND 8640000000000000 AND ${table.settlement}<>'released')`),
  check('reply_preview_settlement_valid',sql`(${table.settlement}='held' AND ${table.usage} IS NULL AND ${table.chargedMicros} IS NULL AND ${table.settledAt} IS NULL AND ${table.releaseEvidence} IS NULL)
    OR (${table.settlement}='settled' AND ${table.receipt} IS NOT NULL AND ${table.usage} IS NOT NULL AND json_valid(${table.usage}) AND json_type(${table.usage})='object' AND ${table.chargedMicros} IS NOT NULL AND ${table.settledAt} IS NOT NULL AND ${table.releaseEvidence} IS NULL)
    OR (${table.settlement}='released' AND ${table.usage} IS NULL AND ${table.chargedMicros} IS NOT NULL AND ${table.chargedMicros}=0 AND ${table.settledAt} IS NOT NULL AND ${table.releaseEvidence} IS NOT NULL AND json_valid(${table.releaseEvidence}) AND json_type(${table.releaseEvidence})='object')`),
]);

// First verified native output; human edits belong to the later send confirmation.
export const replyPreviewOutput=sqliteTable('reply_preview_output',{
  runId:text('run_id').primaryKey().references(()=>replyPreviewRun.id,{onDelete:'restrict'}),
  body:text('body').notNull(),bodyHash:text('body_hash').notNull(),receipt:text('receipt').notNull(),recordedAt:integer('recorded_at').notNull(),
},table=>[
  check('reply_preview_output_body_valid',sql`length(${table.body}) BETWEEN 1 AND 1000 AND length(${table.bodyHash})=64 AND ${table.bodyHash} NOT GLOB '*[^0-9a-f]*'`),
  check('reply_preview_output_receipt_valid',sql`json_valid(${table.receipt}) AND json_type(${table.receipt})='object'`),
  check('reply_preview_output_time_valid',sql`typeof(${table.recordedAt})='integer' AND ${table.recordedAt} BETWEEN 0 AND 8640000000000000`),
]);
