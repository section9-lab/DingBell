import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
export const runtimeAgentBinding=sqliteTable('runtime_agent_binding',{
 instanceId:text('instance_id').primaryKey().notNull(),kind:text('kind',{enum:['translation','reply-test','support']}).notNull(),
 runId:text('run_id').notNull(),uid:text('uid').notNull().unique(),definition:text('definition').notNull(),fingerprint:text('fingerprint').notNull(),receipt:text('receipt'),createdAt:integer('created_at').notNull(),
},table=>[
 unique('runtime_agent_binding_kind_run_unique').on(table.kind,table.runId),
 check('runtime_agent_binding_kind',sql`${table.kind} IN ('translation','reply-test','support')`),
 check('runtime_agent_binding_definition',sql`json_valid(${table.definition})`),
 check('runtime_agent_binding_receipt',sql`${table.receipt} IS NULL OR json_valid(${table.receipt})`),
]);
export const runtimePlatformSetting=sqliteTable('runtime_platform_setting',{key:text('key').primaryKey().notNull(),value:text('value').notNull()});
