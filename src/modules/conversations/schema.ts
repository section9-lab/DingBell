import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { store } from '../stores/schema.ts';
import { storeSyncSource } from '../sync/schema.ts';
import { aiReplyIntent } from '../ai-runs/schema.ts';

export const conversation = sqliteTable('conversation', {
  id: text('id').primaryKey(), organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(),
  channelType: text('channel_type').notNull().default('private'), platformThreadId: text('platform_thread_id').notNull(),
  platformType: text('platform_type').notNull(), platformStatus: text('platform_status').notNull(),
  platformCreatedAt: integer('platform_created_at').notNull(), lastMessageId: text('last_message_id'),
  importedAt: integer('imported_at').notNull(), lastMessageAt: integer('last_message_at'),
  messageSequence: integer('message_sequence').notNull().default(0),
}, table => [
  foreignKey({ columns: [table.storeId, table.organizationId], foreignColumns: [store.id, store.organizationId] }).onDelete('cascade'),
  uniqueIndex('conversation_platform_thread_unique').on(table.storeId, table.channelType, table.platformThreadId),
  uniqueIndex('conversation_scope_unique').on(table.id, table.organizationId, table.storeId),
  index('conversation_store_time_idx').on(table.organizationId, table.storeId, table.lastMessageAt, table.id),
  index('conversation_org_time_idx').on(table.organizationId, table.lastMessageAt, table.id),
  index('conversation_org_thread_idx').on(table.organizationId, table.platformThreadId, table.lastMessageAt, table.id),
  check('conversation_channel_valid', sql`${table.channelType}='private'`),
]);

export const message = sqliteTable('message', {
  id: text('id').primaryKey(), organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(),
  conversationId: text('conversation_id').notNull(), platformMessageId: text('platform_message_id').notNull(),
  senderId: text('sender_id'), senderType: text('sender_type').notNull(), direction: text('direction').notNull(),
  content: text('content').notNull(), isImage: integer('is_image', { mode: 'boolean' }).notNull(),
  isRead: integer('is_read', { mode: 'boolean' }).notNull(), orderNumber: text('order_number'), sku: text('sku'),
  eventAt: integer('event_at').notNull(), receivedAt: integer('received_at').notNull(), ingestMode: text('ingest_mode').notNull(),
}, table => [
  foreignKey({ columns: [table.conversationId, table.organizationId, table.storeId], foreignColumns: [conversation.id, conversation.organizationId, conversation.storeId] }).onDelete('cascade'),
  uniqueIndex('message_platform_unique').on(table.storeId, table.conversationId, table.platformMessageId),
  uniqueIndex('message_scope_unique').on(table.id, table.organizationId, table.storeId, table.conversationId),
  index('message_conversation_time_idx').on(table.organizationId, table.conversationId, table.eventAt, table.id),
  index('message_org_order_idx').on(table.organizationId, table.orderNumber, table.conversationId),
  check('message_content_json', sql`json_valid(${table.content}) AND json_type(${table.content})='array'`),
  check('message_direction_valid', sql`${table.direction} IN ('inbound','outbound','unknown')`),
  check('message_mode_valid', sql`${table.ingestMode} IN ('backfill','incremental')`),
]);

export const messageAppend = sqliteTable('message_append', {
  conversationId: text('conversation_id').notNull(), organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(),
  messageId: text('message_id').notNull(), sequence: integer('sequence').notNull(),
}, table => [
  primaryKey({ columns: [table.conversationId, table.sequence] }),
  foreignKey({ columns: [table.messageId, table.organizationId, table.storeId, table.conversationId], foreignColumns: [message.id, message.organizationId, message.storeId, message.conversationId] }).onDelete('cascade'),
  uniqueIndex('message_append_message_unique').on(table.messageId),
  check('message_append_sequence_valid', sql`typeof(${table.sequence})='integer' AND ${table.sequence} BETWEEN 1 AND 9007199254740991`),
]);

export const ingestEvent = sqliteTable('ingest_event', {
  id: text('id').primaryKey(), schemaVersion: integer('schema_version').notNull().default(1),
  organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(), conversationId: text('conversation_id').notNull(),
  messageId: text('message_id').notNull(), state: text('state').notNull(), liveObservedAt: integer('live_observed_at'), traceId: text('trace_id').notNull(), createdAt: integer('created_at').notNull(),
  deliveryDueAt: integer('delivery_due_at').notNull().default(0), deliveryToken: text('delivery_token'), processedAt: integer('processed_at'), deliveryOutcome: text('delivery_outcome'),
}, table => [
  foreignKey({ columns: [table.messageId, table.organizationId, table.storeId, table.conversationId], foreignColumns: [message.id, message.organizationId, message.storeId, message.conversationId] }).onDelete('cascade'),
  uniqueIndex('ingest_event_message_unique').on(table.messageId),
  index('ingest_event_pending_idx').on(table.state, table.createdAt, table.id),
  index('ingest_event_delivery_idx').on(table.state, table.processedAt, table.deliveryDueAt, table.createdAt, table.id),
  check('ingest_event_state_valid', sql`${table.state} IN ('pending','historical','observed')`),
  check('ingest_event_version_valid', sql`${table.schemaVersion}=1`),
]);

export const syncCursor = sqliteTable('sync_cursor', {
  organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(),
  source: text('source').notNull().default('chat'), threadId: text('thread_id').notNull(), stream: text('stream').notNull(), conversationId: text('conversation_id'),
  cursor: text('cursor'), recentCursors: text('recent_cursors').notNull().default('[]'), revision: integer('revision').notNull().default(0),
  dueAt: integer('due_at').notNull(), completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
}, table => [
  primaryKey({ columns: [table.storeId, table.stream, table.threadId] }),
  foreignKey({ columns: [table.storeId, table.organizationId, table.source], foreignColumns: [storeSyncSource.storeId, storeSyncSource.organizationId, storeSyncSource.source] }).onDelete('cascade'),
  foreignKey({ columns: [table.conversationId, table.organizationId, table.storeId], foreignColumns: [conversation.id, conversation.organizationId, conversation.storeId] }).onDelete('cascade'),
  index('sync_cursor_due_idx').on(table.storeId, table.completed, table.dueAt, table.stream, table.threadId),
  check('sync_cursor_source_valid', sql`${table.source}='chat'`),
  check('sync_cursor_history_valid', sql`json_valid(${table.recentCursors}) AND json_type(${table.recentCursors})='array' AND json_array_length(${table.recentCursors})<=8`),
  check('sync_cursor_revision_valid', sql`${table.revision}>=0`),
  check('sync_cursor_stream_valid', sql`(${table.stream}='discovery' AND ${table.threadId}='' AND ${table.conversationId} IS NULL) OR (${table.stream} IN ('backfill','incremental') AND ${table.threadId}<>'' AND ${table.conversationId} IS NOT NULL)`),
]);

// This is a read projection and repair directory; control commands are accepted by the DO.
export const conversationControl = sqliteTable('conversation_control', {
  conversationId: text('conversation_id').primaryKey(), organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(),
  controllerId: text('controller_id').notNull(), schemaVersion: integer('schema_version').notNull().default(1),
  version: integer('version').notNull().default(0), controlEpoch: integer('control_epoch').notNull().default(0), sequence: integer('sequence').notNull().default(0),
  lifecycle: text('lifecycle').notNull().default('open'), reception: text('reception').notNull().default('paused'), workStatus: text('work_status'),
  assignedMemberId: text('assigned_member_id'), updatedAt: integer('updated_at').notNull().default(0), repairDueAt: integer('repair_due_at').notNull(),
}, table => [
  foreignKey({columns:[table.conversationId,table.organizationId,table.storeId],foreignColumns:[conversation.id,conversation.organizationId,conversation.storeId]}).onDelete('cascade'),
  uniqueIndex('conversation_control_id_unique').on(table.controllerId),
  uniqueIndex('conversation_control_scope_unique').on(table.controllerId,table.organizationId,table.storeId,table.conversationId),
  index('conversation_control_repair_idx').on(table.repairDueAt,table.controllerId),
  check('conversation_control_schema_valid',sql`${table.schemaVersion} IN (1,2)`),
  check('conversation_control_work_status_valid',sql`(${table.schemaVersion}=1 AND ${table.workStatus} IS NULL) OR (${table.schemaVersion}=2 AND ((${table.lifecycle}='resolved' AND ${table.workStatus} IS NULL) OR (${table.lifecycle}='open' AND ${table.workStatus} IS NOT NULL AND ${table.workStatus} IN ('needs_reply','waiting_customer','waiting_internal'))))`),
  check('conversation_control_counters_valid',sql`${table.version} BETWEEN 0 AND 9007199254740991 AND ${table.controlEpoch} BETWEEN 0 AND 9007199254740991 AND ${table.sequence} BETWEEN 0 AND 9007199254740991`),
  check('conversation_control_state_valid',sql`${table.lifecycle} IN ('open','resolved') AND ${table.reception} IN ('paused','human','ai') AND (${table.reception}<>'ai' OR (${table.schemaVersion}=2 AND ${table.lifecycle}='open' AND ${table.workStatus}='needs_reply' AND ${table.assignedMemberId} IS NULL))`),
  check('conversation_control_time_valid',sql`${table.updatedAt} BETWEEN 0 AND 8640000000000000 AND ${table.repairDueAt} BETWEEN 0 AND 8640000000000000`),
]);

export const aiDispatch = sqliteTable('ai_dispatch', {
  controllerId:text('controller_id').primaryKey(),organizationId:text('organization_id').notNull(),storeId:text('store_id').notNull(),conversationId:text('conversation_id').notNull(),
  eventId:text('event_id').notNull(),inputSequence:integer('input_sequence').notNull(),runId:text('run_id').notNull(),
  createdAt:integer('created_at').notNull(),dueAt:integer('due_at'),token:text('token'),
},table=>[
  foreignKey({columns:[table.controllerId,table.organizationId,table.storeId,table.conversationId],foreignColumns:[conversationControl.controllerId,conversationControl.organizationId,conversationControl.storeId,conversationControl.conversationId]}).onDelete('cascade'),
  foreignKey({columns:[table.eventId],foreignColumns:[ingestEvent.id]}).onDelete('cascade'),
  index('ai_dispatch_due_idx').on(table.dueAt,table.controllerId),uniqueIndex('ai_dispatch_run_unique').on(table.runId),
  check('ai_dispatch_sequence_valid',sql`${table.inputSequence} BETWEEN 1 AND 9007199254740991`),
  check('ai_dispatch_time_valid',sql`${table.createdAt} BETWEEN 0 AND 8640000000000000 AND (${table.dueAt} IS NULL OR ${table.dueAt} BETWEEN 0 AND 8640000000000000)`),
]);

export const conversationControlEvent = sqliteTable('conversation_control_event', {
  controllerId: text('controller_id').notNull(), organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(), conversationId: text('conversation_id').notNull(),
  sequence: integer('sequence').notNull(), commandId: text('command_id').notNull(), actorUserId: text('actor_user_id'), actorMemberId: text('actor_member_id'),
  action: text('action').notNull(), receipt: text('receipt').notNull(), projectedAt: integer('projected_at').notNull(),
}, table => [
  primaryKey({columns:[table.controllerId,table.sequence]}),
  foreignKey({columns:[table.controllerId,table.organizationId,table.storeId,table.conversationId],foreignColumns:[conversationControl.controllerId,conversationControl.organizationId,conversationControl.storeId,conversationControl.conversationId]}).onDelete('cascade'),
  uniqueIndex('conversation_control_command_unique').on(table.controllerId,table.commandId),
  check('conversation_control_event_sequence_valid',sql`${table.sequence} BETWEEN 1 AND 9007199254740991`),
  check('conversation_control_event_action_valid',sql`${table.action} IN ('claim','takeover','resolve','reopen','set_work_status','transfer','add_note','send_reply','cancel_reply','ai_start','ai_resume','ai_listen','request_handoff','customer_message','ai_intake_start','ai_classification','ai_dispatch_stop','ai_send_reply')`),
  check('conversation_control_event_actor_valid',sql`(${table.action} IN ('ai_start','request_handoff','customer_message','ai_intake_start','ai_classification','ai_dispatch_stop','ai_send_reply') AND ${table.actorUserId} IS NULL AND ${table.actorMemberId} IS NULL) OR (${table.action} NOT IN ('ai_start','request_handoff','customer_message','ai_intake_start','ai_classification','ai_dispatch_stop','ai_send_reply') AND ${table.actorUserId} IS NOT NULL AND ${table.actorMemberId} IS NOT NULL)`),
  check('conversation_control_event_receipt_valid',sql`json_valid(${table.receipt}) AND json_type(${table.receipt})='object'`),
]);

// Delivery state is projected from the conversation DO; these rows never authorize a retry.
export const sendIntent = sqliteTable('send_intent', {
  controllerId:text('controller_id').notNull(),organizationId:text('organization_id').notNull(),storeId:text('store_id').notNull(),conversationId:text('conversation_id').notNull(),
  id:text('id').notNull(),schemaVersion:integer('schema_version').notNull(),commandId:text('command_id').notNull(),
  actorUserId:text('actor_user_id'),actorMemberId:text('actor_member_id'),aiRunId:text('ai_run_id').references(():AnySQLiteColumn=>aiReplyIntent.runId,{onDelete:'restrict'}),body:text('body').notNull(),bodyHash:text('body_hash').notNull(),
  platformThreadId:text('platform_thread_id').notNull(),credentialVersion:integer('credential_version').notNull(),controlEpoch:integer('control_epoch').notNull(),
  state:text('state').notNull(),revision:integer('revision').notNull(),createdAt:integer('created_at').notNull(),updatedAt:integer('updated_at').notNull(),
  dueAt:integer('due_at'),lastError:text('last_error'),projectedAt:integer('projected_at').notNull(),
},table=>[
  primaryKey({columns:[table.controllerId,table.id]}),
  foreignKey({columns:[table.controllerId,table.organizationId,table.storeId,table.conversationId],foreignColumns:[conversationControl.controllerId,conversationControl.organizationId,conversationControl.storeId,conversationControl.conversationId]}).onDelete('cascade'),
  uniqueIndex('send_intent_scope_unique').on(table.controllerId,table.id,table.organizationId,table.storeId,table.conversationId),
  index('send_intent_conversation_time_idx').on(table.organizationId,table.conversationId,table.createdAt,table.id),
  check('send_intent_version_valid',sql`${table.schemaVersion} IN (1,2) AND ${table.id}=${table.commandId} AND ${table.revision} BETWEEN 1 AND 9007199254740991 AND ${table.credentialVersion} BETWEEN 1 AND 9007199254740991 AND ${table.controlEpoch} BETWEEN 0 AND 9007199254740991`),
  check('send_intent_actor_valid',sql`(${table.schemaVersion}=1 AND ${table.actorUserId} IS NOT NULL AND ${table.actorMemberId} IS NOT NULL AND ${table.aiRunId} IS NULL) OR (${table.schemaVersion}=2 AND ${table.actorUserId} IS NULL AND ${table.actorMemberId} IS NULL AND ${table.aiRunId} IS NOT NULL AND ${table.id}='ai-reply:'||${table.aiRunId})`),
  check('send_intent_state_valid',sql`${table.state} IN ('queued','sending','sent','failed','unknown','skipped','canceled') AND (${table.state}<>'canceled' OR (${table.dueAt} IS NULL AND ${table.lastError} IS NULL))`),
  check('send_intent_time_valid',sql`${table.createdAt} BETWEEN 0 AND 8640000000000000 AND ${table.updatedAt} BETWEEN ${table.createdAt} AND 8640000000000000 AND (${table.dueAt} IS NULL OR ${table.dueAt} BETWEEN 0 AND 8640000000000000) AND ${table.projectedAt} BETWEEN 0 AND 8640000000000000`),
]);
export const sendAttempt = sqliteTable('send_attempt', {
  controllerId:text('controller_id').notNull(),organizationId:text('organization_id').notNull(),storeId:text('store_id').notNull(),conversationId:text('conversation_id').notNull(),
  id:text('id').notNull(),intentId:text('intent_id').notNull(),revision:integer('revision').notNull(),state:text('state').notNull(),
  startedAt:integer('started_at').notNull(),deadlineAt:integer('deadline_at').notNull(),finishedAt:integer('finished_at'),
  httpStatus:integer('http_status'),providerResult:text('provider_result'),errorCode:text('error_code'),projectedAt:integer('projected_at').notNull(),
},table=>[
  primaryKey({columns:[table.controllerId,table.id]}),
  foreignKey({columns:[table.controllerId,table.intentId,table.organizationId,table.storeId,table.conversationId],foreignColumns:[sendIntent.controllerId,sendIntent.id,sendIntent.organizationId,sendIntent.storeId,sendIntent.conversationId]}).onDelete('cascade'),
  uniqueIndex('send_attempt_intent_unique').on(table.controllerId,table.intentId),
  check('send_attempt_identity_valid',sql`${table.id}=${table.intentId}||':1' AND ${table.revision} BETWEEN 1 AND 9007199254740991`),
  check('send_attempt_state_valid',sql`${table.state} IN ('sending','sent','failed','unknown') AND (${table.providerResult} IS NULL OR ${table.providerResult}='success')`),
  check('send_attempt_time_valid',sql`${table.startedAt} BETWEEN 0 AND 8640000000000000 AND ${table.deadlineAt} BETWEEN ${table.startedAt} AND 8640000000000000 AND (${table.finishedAt} IS NULL OR ${table.finishedAt} BETWEEN ${table.startedAt} AND 8640000000000000) AND (${table.httpStatus} IS NULL OR ${table.httpStatus} BETWEEN 100 AND 599) AND ${table.projectedAt} BETWEEN 0 AND 8640000000000000`),
]);
