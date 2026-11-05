import {sql} from 'drizzle-orm';
import {check,foreignKey,index,integer,sqliteTable,text,uniqueIndex} from 'drizzle-orm/sqlite-core';
import {store} from '../stores/schema.ts';
import {conversation,message} from '../conversations/schema.ts';
export const storePushEndpoint=sqliteTable('store_push_endpoint',{
 storeId:text('store_id').primaryKey(),organizationId:text('organization_id').notNull(),endpointId:text('endpoint_id').notNull().unique(),
 revision:integer('revision').notNull(),generation:integer('generation').notNull(),mode:text('mode',{enum:['prepared','active','paused']}).notNull(),sellerId:text('seller_id'),observedSellerId:text('observed_seller_id'),
 secretHash:text('secret_hash').notNull(),keyVersion:text('key_version').notNull(),nonce:text('nonce').notNull(),ciphertext:text('ciphertext').notNull(),
 lastPingAt:integer('last_ping_at'),lastReceivedAt:integer('last_received_at'),lastSimulationAt:integer('last_simulation_at'),lastProcessedAt:integer('last_processed_at'),cutoverAt:integer('cutover_at'),createdAt:integer('created_at').notNull(),updatedAt:integer('updated_at').notNull(),
},t=>[
 foreignKey({columns:[t.storeId,t.organizationId],foreignColumns:[store.id,store.organizationId]}).onDelete('cascade'),
 check('push_endpoint_revision',sql`${t.revision}>0 AND ${t.generation}>0`),check('push_endpoint_mode',sql`${t.mode} IN ('prepared','active','paused')`),
]);
export const ozonPushEvent=sqliteTable('ozon_push_event',{
 id:text('id').primaryKey(),organizationId:text('organization_id').notNull(),storeId:text('store_id').notNull(),generation:integer('generation').notNull(),dedupeKey:text('dedupe_key').notNull(),notificationType:text('notification_type').notNull(),source:text('source').notNull(),hint:text('hint').notNull(),
 simulated:integer('simulated',{mode:'boolean'}).notNull().default(false),requiresReview:integer('requires_review',{mode:'boolean'}).notNull().default(false),
 state:text('state',{enum:['pending','processing','retry','completed','ignored','failed']}).notNull(),attempts:integer('attempts').notNull().default(0),nextAttemptAt:integer('next_attempt_at').notNull(),leaseToken:text('lease_token'),leaseUntil:integer('lease_until'),progress:text('progress').notNull().default('{}'),receivedAt:integer('received_at').notNull(),finishedAt:integer('finished_at'),lastError:text('last_error'),
},t=>[
 foreignKey({columns:[t.storeId,t.organizationId],foreignColumns:[store.id,store.organizationId]}).onDelete('cascade'),
 uniqueIndex('push_event_dedupe').on(t.storeId,t.generation,t.dedupeKey),index('ozon_push_event_due').on(t.state,t.nextAttemptAt,t.leaseUntil,t.storeId),index('ozon_push_event_scope').on(t.organizationId,t.storeId,t.receivedAt,t.id),
 check('push_event_hint_json',sql`json_valid(${t.hint}) AND json_type(${t.hint})='object'`),check('push_event_progress_json',sql`json_valid(${t.progress})`),check('push_event_attempts',sql`${t.attempts}>=0`),
 check('push_event_state',sql`${t.state} IN ('pending','processing','retry','completed','ignored','failed')`),check('push_event_simulated',sql`${t.simulated} IN (0,1)`),check('push_event_review',sql`${t.requiresReview} IN (0,1)`),
]);
export const ozonPushChatHead=sqliteTable('ozon_push_chat_head',{
 conversationId:text('conversation_id').primaryKey(),organizationId:text('organization_id').notNull(),storeId:text('store_id').notNull(),messageId:text('message_id'),pushEventId:text('push_event_id'),observedAt:integer('observed_at').notNull(),
},t=>[
 foreignKey({columns:[t.conversationId,t.organizationId,t.storeId],foreignColumns:[conversation.id,conversation.organizationId,conversation.storeId]}).onDelete('cascade'),
 foreignKey({columns:[t.messageId,t.organizationId,t.storeId,t.conversationId],foreignColumns:[message.id,message.organizationId,message.storeId,message.conversationId]}).onDelete('cascade'),
 foreignKey({columns:[t.pushEventId],foreignColumns:[ozonPushEvent.id]}).onDelete('cascade'),
]);
export const ozonPushLiveMessage=sqliteTable('ozon_push_live_message',{
 messageId:text('message_id').primaryKey(),organizationId:text('organization_id').notNull(),storeId:text('store_id').notNull(),conversationId:text('conversation_id').notNull(),pushEventId:text('push_event_id').notNull(),observedAt:integer('observed_at').notNull(),
},t=>[
 foreignKey({columns:[t.messageId,t.organizationId,t.storeId,t.conversationId],foreignColumns:[message.id,message.organizationId,message.storeId,message.conversationId]}).onDelete('cascade'),foreignKey({columns:[t.pushEventId],foreignColumns:[ozonPushEvent.id]}).onDelete('cascade'),
]);
export const storeChangeRevision=sqliteTable('store_change_revision',{
 storeId:text('store_id').primaryKey(),organizationId:text('organization_id').notNull(),revision:integer('revision').notNull().default(1),messageStatusRevision:integer('message_status_revision').notNull().default(0),
},t=>[foreignKey({columns:[t.storeId,t.organizationId],foreignColumns:[store.id,store.organizationId]}).onDelete('cascade'),check('store_change_revision_range',sql`${t.revision} BETWEEN 1 AND 9007199254740991 AND ${t.messageStatusRevision} BETWEEN 0 AND 9007199254740991`)]);
