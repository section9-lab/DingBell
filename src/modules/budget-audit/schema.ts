import {sql} from 'drizzle-orm';
import {check,index,integer,primaryKey,sqliteTable,text} from 'drizzle-orm/sqlite-core';
import {organization} from '../identity/schema.ts';

export const budgetReconciliationState=sqliteTable('budget_reconciliation_state',{
 organizationId:text('organization_id').notNull().references(()=>organization.id,{onDelete:'restrict'}),kind:text('kind',{enum:['ai','translation','reply-test']}).notNull(),budgetId:text('budget_id').notNull(),
 nextDueAt:integer('next_due_at').notNull().default(0),leaseToken:text('lease_token'),status:text('status',{enum:['balanced','mismatch']}),payload:text('payload'),observedAt:integer('observed_at'),
 mismatchSince:integer('mismatch_since'),consecutiveMismatches:integer('consecutive_mismatches').notNull().default(0),lastErrorAt:integer('last_error_at'),lastErrorCode:text('last_error_code',{enum:['AUDIT_UNAVAILABLE']}),consecutiveFailures:integer('consecutive_failures').notNull().default(0),updatedAt:integer('updated_at').notNull().default(0),
},table=>[
 primaryKey({columns:[table.organizationId,table.kind,table.budgetId]}),index('budget_reconciliation_due_idx').on(table.nextDueAt,table.organizationId,table.kind,table.budgetId),
 check('budget_reconciliation_kind_valid',sql`${table.kind} IN ('ai','translation','reply-test')`),
 check('budget_reconciliation_result_valid',sql`(${table.status} IS NULL AND ${table.payload} IS NULL AND ${table.observedAt} IS NULL AND ${table.mismatchSince} IS NULL AND ${table.consecutiveMismatches}=0) OR
  (${table.status}='balanced' AND json_valid(${table.payload}) AND json_type(${table.payload})='object' AND typeof(${table.observedAt})='integer' AND ${table.observedAt} BETWEEN 0 AND 8640000000000000 AND ${table.mismatchSince} IS NULL AND ${table.consecutiveMismatches}=0) OR
  (${table.status}='mismatch' AND json_valid(${table.payload}) AND json_type(${table.payload})='object' AND typeof(${table.observedAt})='integer' AND ${table.observedAt} BETWEEN 0 AND 8640000000000000 AND typeof(${table.mismatchSince})='integer' AND ${table.consecutiveMismatches}>0)`),
 check('budget_reconciliation_time_valid',sql`typeof(${table.nextDueAt})='integer' AND ${table.nextDueAt} BETWEEN 0 AND 8640000000000000
  AND (${table.mismatchSince} IS NULL OR (typeof(${table.mismatchSince})='integer' AND ${table.mismatchSince} BETWEEN 0 AND 8640000000000000))
  AND ((${table.lastErrorAt} IS NULL AND ${table.lastErrorCode} IS NULL) OR (typeof(${table.lastErrorAt})='integer' AND ${table.lastErrorAt} BETWEEN 0 AND 8640000000000000 AND ${table.lastErrorCode}='AUDIT_UNAVAILABLE'))
  AND typeof(${table.updatedAt})='integer' AND ${table.updatedAt} BETWEEN 0 AND 8640000000000000`),
 check('budget_reconciliation_count_valid',sql`typeof(${table.consecutiveMismatches})='integer' AND ${table.consecutiveMismatches} BETWEEN 0 AND 9007199254740991
  AND typeof(${table.consecutiveFailures})='integer' AND ${table.consecutiveFailures} BETWEEN 0 AND 9007199254740991`),
]);
