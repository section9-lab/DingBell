import {sql} from 'drizzle-orm';
import {check,foreignKey,index,integer,primaryKey,sqliteTable,text,uniqueIndex} from 'drizzle-orm/sqlite-core';
import {store} from '../stores/schema.ts';

export const accountingRule=sqliteTable('accounting_rule',{
  id:text('id').primaryKey(),organizationId:text('organization_id').notNull(),storeId:text('store_id').notNull(),
  effectiveAt:integer('effective_at').notNull(),validFrom:text('valid_from').notNull(),inputs:text('inputs').notNull(),
  createdAt:integer('created_at').notNull(),createdBy:text('created_by').notNull(),
},table=>[
  foreignKey({columns:[table.storeId,table.organizationId],foreignColumns:[store.id,store.organizationId]}).onDelete('cascade'),
  uniqueIndex('accounting_rule_effective').on(table.storeId,table.effectiveAt),index('accounting_rule_scope').on(table.organizationId,table.storeId,table.effectiveAt),
  check('accounting_rule_json',sql`json_valid(${table.inputs}) AND json_type(${table.inputs})='object'`),
]);
export const accountingPostingBasis=sqliteTable('accounting_posting_basis',{
  organizationId:text('organization_id').notNull(),storeId:text('store_id').notNull(),fulfillment:text('fulfillment').notNull(),postingNumber:text('posting_number').notNull(),
  saleIdentity:text('sale_identity').notNull(),inputs:text('inputs').notNull(),capturedAt:integer('captured_at').notNull(),capturedBy:text('captured_by').notNull(),
},table=>[
  primaryKey({columns:[table.storeId,table.fulfillment,table.postingNumber]}),
  foreignKey({columns:[table.storeId,table.organizationId],foreignColumns:[store.id,store.organizationId]}).onDelete('cascade'),
  check('accounting_basis_lane',sql`${table.fulfillment} IN ('fbs','fbo','fbp')`),check('accounting_basis_json',sql`json_valid(${table.inputs}) AND json_type(${table.inputs})='object'`),
]);
export const accountingExpense=sqliteTable('accounting_expense',{
  id:text('id').primaryKey(),organizationId:text('organization_id').notNull(),storeId:text('store_id').notNull(),expenseDate:text('expense_date').notNull(),category:text('category').notNull(),
  amountCents:integer('amount_cents').notNull(),note:text('note').notNull(),createdAt:integer('created_at').notNull(),createdBy:text('created_by').notNull(),voidedAt:integer('voided_at'),voidedBy:text('voided_by'),
},table=>[
  foreignKey({columns:[table.storeId,table.organizationId],foreignColumns:[store.id,store.organizationId]}).onDelete('cascade'),
  index('accounting_expense_period').on(table.organizationId,table.storeId,table.expenseDate),
  check('accounting_expense_category',sql`${table.category} IN ('advertising','other')`),check('accounting_expense_amount',sql`${table.amountCents}>0`),
  check('accounting_expense_note',sql`length(${table.note}) BETWEEN 1 AND 200`),check('accounting_expense_void',sql`(${table.voidedAt} IS NULL)=(${table.voidedBy} IS NULL)`),
]);
