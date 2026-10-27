import { sql } from 'drizzle-orm';
import { check,foreignKey,index,integer,primaryKey,sqliteTable,text,uniqueIndex } from 'drizzle-orm/sqlite-core';
import { organization } from '../identity/schema.ts';
import { conversation } from '../conversations/schema.ts';

export const aiBudget=sqliteTable('ai_budget',{
  id:text('id').primaryKey(),organizationId:text('organization_id').notNull().references(()=>organization.id,{onDelete:'restrict'}),
  startsAt:integer('starts_at').notNull(),endsAt:integer('ends_at').notNull(),enabled:integer('enabled',{mode:'boolean'}).notNull().default(false),
  revision:integer('revision').notNull().default(0),limitMicros:integer('limit_micros').notNull(),
  reservedMicros:integer('reserved_micros').notNull().default(0),spentMicros:integer('spent_micros').notNull().default(0),
  maxRuns:integer('max_runs').notNull(),admittedRuns:integer('admitted_runs').notNull().default(0),commitToken:text('commit_token'),
},table=>[
  uniqueIndex('ai_budget_scope_unique').on(table.id,table.organizationId),
  index('ai_budget_window_idx').on(table.organizationId,table.startsAt,table.endsAt),
  check('ai_budget_window_valid',sql`typeof(${table.startsAt})='integer' AND typeof(${table.endsAt})='integer' AND ${table.startsAt} BETWEEN 0 AND 8640000000000000 AND ${table.endsAt}>${table.startsAt} AND ${table.endsAt}<=8640000000000000`),
  check('ai_budget_amounts_valid',sql`typeof(${table.limitMicros})='integer' AND typeof(${table.reservedMicros})='integer' AND typeof(${table.spentMicros})='integer'
    AND ${table.limitMicros} BETWEEN 0 AND 9007199254740991 AND ${table.reservedMicros} BETWEEN 0 AND 9007199254740991 AND ${table.spentMicros} BETWEEN 0 AND 9007199254740991`),
  check('ai_budget_counts_valid',sql`typeof(${table.maxRuns})='integer' AND typeof(${table.admittedRuns})='integer' AND ${table.maxRuns} BETWEEN 1 AND 1000000 AND ${table.admittedRuns} BETWEEN 0 AND ${table.maxRuns}`),
  check('ai_budget_control_valid',sql`typeof(${table.enabled})='integer' AND ${table.enabled} IN (0,1) AND typeof(${table.revision})='integer' AND ${table.revision} BETWEEN 0 AND 9007199254740991`),
]);

export const aiBudgetAudit=sqliteTable('ai_budget_audit',{
  id:text('id').primaryKey(),organizationId:text('organization_id').notNull(),budgetId:text('budget_id').notNull(),
  actorUserId:text('actor_user_id').notNull(),actorMemberId:text('actor_member_id').notNull(),actorName:text('actor_name').notNull(),
  action:text('action',{enum:['create','set_enabled']}).notNull(),payload:text('payload').notNull(),
  revision:integer('revision').notNull(),enabled:integer('enabled',{mode:'boolean'}).notNull(),createdAt:integer('created_at').notNull(),
},table=>[
  foreignKey({columns:[table.budgetId,table.organizationId],foreignColumns:[aiBudget.id,aiBudget.organizationId]}).onDelete('restrict'),
  index('ai_budget_audit_history_idx').on(table.organizationId,table.createdAt,table.id),
  check('ai_budget_audit_payload_valid',sql`json_valid(${table.payload}) AND json_type(${table.payload})='object' AND length(CAST(${table.payload} AS BLOB)) BETWEEN 1 AND 4096`),
  check('ai_budget_audit_action_valid',sql`${table.action} IN ('create','set_enabled') AND typeof(${table.enabled})='integer' AND ${table.enabled} IN (0,1)
    AND typeof(${table.revision})='integer' AND ${table.revision} BETWEEN 0 AND 9007199254740991 AND (${table.action}<>'create' OR (${table.revision}=0 AND ${table.enabled}=0))`),
  check('ai_budget_audit_time_valid',sql`typeof(${table.createdAt})='integer' AND ${table.createdAt} BETWEEN 0 AND 8640000000000000`),
]);

export const aiExecution=sqliteTable('ai_execution',{
 id:text('id').primaryKey(),organizationId:text('organization_id').notNull(),storeId:text('store_id').notNull(),conversationId:text('conversation_id').notNull(),controllerId:text('controller_id').notNull(),
 budgetId:text('budget_id').notNull(),payload:text('payload').notNull(),payloadHash:text('payload_hash').notNull(),config:text('config').notNull(),
 perGenerationMicros:integer('per_generation_micros').notNull(),reservedMicros:integer('reserved_micros').notNull(),maxGenerations:integer('max_generations').notNull(),
 generations:integer('generations').notNull().default(0),createdAt:integer('created_at').notNull(),receipt:text('receipt'),closure:text('closure'),commitToken:text('commit_token'),
 repairDueAt:integer('repair_due_at').default(0),repairToken:text('repair_token'),
},table=>[
 foreignKey({columns:[table.conversationId,table.organizationId,table.storeId],foreignColumns:[conversation.id,conversation.organizationId,conversation.storeId]}).onDelete('restrict'),
 foreignKey({columns:[table.budgetId,table.organizationId],foreignColumns:[aiBudget.id,aiBudget.organizationId]}).onDelete('restrict'),
 index('ai_execution_history_idx').on(table.organizationId,table.createdAt,table.id),
 index('ai_execution_repair_idx').on(table.repairDueAt,table.id),
 check('ai_execution_payload_valid',sql`json_valid(${table.payload}) AND json_type(${table.payload})='object' AND length(CAST(${table.payload} AS BLOB)) BETWEEN 1 AND 98304
  AND length(${table.payloadHash})=64 AND ${table.payloadHash} NOT GLOB '*[^0-9a-f]*' AND json_valid(${table.config}) AND json_type(${table.config})='object'`),
 check('ai_execution_amounts_valid',sql`typeof(${table.perGenerationMicros})='integer' AND ${table.perGenerationMicros} BETWEEN 0 AND 9007199254740991
  AND typeof(${table.reservedMicros})='integer' AND ${table.reservedMicros} BETWEEN 0 AND 9007199254740991 AND ${table.reservedMicros}=${table.perGenerationMicros}*${table.maxGenerations}`),
 check('ai_execution_generations_valid',sql`typeof(${table.maxGenerations})='integer' AND ${table.maxGenerations} BETWEEN 1 AND 8 AND typeof(${table.generations})='integer' AND ${table.generations} BETWEEN 0 AND ${table.maxGenerations}`),
 check('ai_execution_records_valid',sql`(${table.receipt} IS NULL OR (json_valid(${table.receipt}) AND json_type(${table.receipt})='object')) AND (${table.closure} IS NULL OR (json_valid(${table.closure}) AND json_type(${table.closure})='object'))`),
 check('ai_execution_time_valid',sql`typeof(${table.createdAt})='integer' AND ${table.createdAt} BETWEEN 0 AND 8640000000000000`),
]);
export const aiKnowledgeQuery=sqliteTable('ai_knowledge_query',{
 runId:text('run_id').primaryKey().references(()=>aiExecution.id,{onDelete:'restrict'}),
 config:text('config').notNull(),scope:text('scope').notNull(),questionHash:text('question_hash').notNull(),reservedMicros:integer('reserved_micros').notNull(),
 createdAt:integer('created_at').notNull(),vectors:text('vectors'),evidence:text('evidence'),gatewayLogId:text('gateway_log_id'),
 gatewayUsage:text('gateway_usage'),chargedMicros:integer('charged_micros'),settledAt:integer('settled_at'),
},table=>[
 check('ai_knowledge_query_json',sql`json_valid(${table.config}) AND json_type(${table.config})='object' AND json_valid(${table.scope}) AND json_type(${table.scope})='object'
  AND (${table.vectors} IS NULL OR (json_valid(${table.vectors}) AND json_type(${table.vectors})='array'))
  AND (${table.evidence} IS NULL OR (${table.vectors} IS NOT NULL AND json_valid(${table.evidence}) AND json_type(${table.evidence})='object'))`),
 check('ai_knowledge_query_amount',sql`typeof(${table.reservedMicros})='integer' AND ${table.reservedMicros} BETWEEN 0 AND 9007199254740991`),
 check('ai_knowledge_query_identity',sql`length(${table.questionHash})=64 AND ${table.questionHash} NOT GLOB '*[^0-9a-f]*' AND typeof(${table.createdAt})='integer' AND ${table.createdAt} BETWEEN 0 AND 8640000000000000`),
 check('ai_knowledge_query_gateway_log_valid',sql`${table.gatewayLogId} IS NULL OR length(${table.gatewayLogId}) BETWEEN 1 AND 256`),
 check('ai_knowledge_query_settlement_valid',sql`(${table.gatewayUsage} IS NULL AND ${table.chargedMicros} IS NULL AND ${table.settledAt} IS NULL) OR
  (${table.gatewayLogId} IS NOT NULL AND json_valid(${table.gatewayUsage}) AND json_type(${table.gatewayUsage})='object'
    AND typeof(${table.chargedMicros})='integer' AND ${table.chargedMicros} BETWEEN 0 AND ${table.reservedMicros}
    AND typeof(${table.settledAt})='integer' AND ${table.settledAt} BETWEEN ${table.createdAt} AND 8640000000000000)`),
]);
export const aiAnswer=sqliteTable('ai_answer',{
 runId:text('run_id').primaryKey().references(()=>aiExecution.id,{onDelete:'restrict'}),body:text('body').notNull(),citations:text('citations').notNull(),
 knowledgeEvidence:text('knowledge_evidence').notNull(),createdAt:integer('created_at').notNull(),
},table=>[
 check('ai_answer_body',sql`length(${table.body}) BETWEEN 1 AND 1000 AND length(CAST(${table.body} AS BLOB))<=4000`),
 check('ai_answer_citations',sql`json_valid(${table.citations}) AND json_type(${table.citations})='array' AND json_array_length(${table.citations}) BETWEEN 1 AND 10`),
 check('ai_answer_evidence',sql`json_valid(${table.knowledgeEvidence}) AND json_type(${table.knowledgeEvidence})='object' AND json_extract(${table.knowledgeEvidence},'$.runId')=${table.runId}`),
 check('ai_answer_time',sql`typeof(${table.createdAt})='integer' AND ${table.createdAt} BETWEEN 0 AND 8640000000000000`),
]);
export const aiReplyIntent=sqliteTable('ai_reply_intent',{
 runId:text('run_id').primaryKey().references(()=>aiExecution.id,{onDelete:'restrict'}),id:text('id').notNull(),payloadHash:text('payload_hash').notNull(),
 body:text('body').notNull(),bodyHash:text('body_hash').notNull(),citations:text('citations').notNull(),knowledgeEvidence:text('knowledge_evidence').notNull(),
 platformStoreId:text('platform_store_id').notNull(),platformThreadId:text('platform_thread_id').notNull(),credentialVersion:integer('credential_version').notNull(),createdAt:integer('created_at').notNull(),
},table=>[
 uniqueIndex('ai_reply_intent_id_unique').on(table.id),
 check('ai_reply_intent_identity',sql`${table.id}='ai-reply:'||${table.runId} AND length(${table.payloadHash})=64 AND ${table.payloadHash} NOT GLOB '*[^0-9a-f]*' AND length(${table.bodyHash})=64 AND ${table.bodyHash} NOT GLOB '*[^0-9a-f]*'`),
 check('ai_reply_intent_body',sql`length(${table.body}) BETWEEN 1 AND 1000 AND length(CAST(${table.body} AS BLOB))<=4000`),
 check('ai_reply_intent_citations',sql`json_valid(${table.citations}) AND json_type(${table.citations})='array' AND json_array_length(${table.citations}) BETWEEN 1 AND 10`),
 check('ai_reply_intent_evidence',sql`json_valid(${table.knowledgeEvidence}) AND json_type(${table.knowledgeEvidence})='object' AND json_extract(${table.knowledgeEvidence},'$.runId')=${table.runId}`),
 check('ai_reply_intent_channel',sql`length(${table.platformStoreId}) BETWEEN 1 AND 256 AND length(${table.platformThreadId}) BETWEEN 1 AND 256 AND typeof(${table.credentialVersion})='integer' AND ${table.credentialVersion} BETWEEN 1 AND 9007199254740991`),
 check('ai_reply_intent_time',sql`typeof(${table.createdAt})='integer' AND ${table.createdAt} BETWEEN 0 AND 8640000000000000`),
]);
export const aiGeneration=sqliteTable('ai_generation',{
 runId:text('run_id').notNull().references(()=>aiExecution.id,{onDelete:'restrict'}),sequence:integer('sequence').notNull(),claimedAt:integer('claimed_at').notNull(),
 usage:text('usage'),chargedMicros:integer('charged_micros'),settledAt:integer('settled_at'),
},table=>[
 primaryKey({columns:[table.runId,table.sequence]}),
 check('ai_generation_sequence_valid',sql`typeof(${table.sequence})='integer' AND ${table.sequence} BETWEEN 1 AND 8`),
 check('ai_generation_time_valid',sql`typeof(${table.claimedAt})='integer' AND ${table.claimedAt} BETWEEN 0 AND 8640000000000000 AND (${table.settledAt} IS NULL OR (typeof(${table.settledAt})='integer' AND ${table.settledAt} BETWEEN ${table.claimedAt} AND 8640000000000000))`),
 check('ai_generation_settlement_valid',sql`(${table.usage} IS NULL AND ${table.chargedMicros} IS NULL AND ${table.settledAt} IS NULL) OR
  (${table.usage} IS NOT NULL AND json_valid(${table.usage}) AND json_type(${table.usage})='object' AND ${table.chargedMicros} IS NOT NULL AND typeof(${table.chargedMicros})='integer' AND ${table.chargedMicros} BETWEEN 0 AND 9007199254740991 AND ${table.settledAt} IS NOT NULL)`),
]);
