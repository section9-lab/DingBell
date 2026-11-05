import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { store } from '../stores/schema.ts';

export const productSyncCursor = sqliteTable('product_sync_cursor', {
  storeId: text('store_id').primaryKey(), organizationId: text('organization_id').notNull(),
  epoch: integer('epoch').notNull(), generation: integer('generation').notNull().default(1),
  cursor: text('cursor').notNull().default(''), revision: integer('revision').notNull().default(0),
  recentCursors: text('recent_cursors').notNull().default('[]'), dueAt: integer('due_at').notNull(),
  lastKind: text('last_kind').notNull().default('details'), lastCompletedAt: integer('last_completed_at'),
}, table => [
  foreignKey({ columns: [table.storeId, table.organizationId], foreignColumns: [store.id, store.organizationId] }).onDelete('cascade'),
  check('product_cursor_counters_valid', sql`${table.epoch}>0 AND ${table.generation}>0 AND ${table.revision}>=0`),
  check('product_cursor_history_valid', sql`json_valid(${table.recentCursors}) AND json_type(${table.recentCursors})='array' AND json_array_length(${table.recentCursors})<=8`),
  check('product_cursor_kind_valid', sql`${table.lastKind} IN ('list','details')`),
]);

export const product = sqliteTable('product', {
  id: text('id').notNull(), organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(),
  listing: text('listing').notNull(), listObservedAt: integer('list_observed_at').notNull(), listSourceUpdatedAt: integer('list_source_updated_at'),
  facts: text('facts'), factsObservedAt: integer('facts_observed_at'), factsSourceUpdatedAt: integer('facts_source_updated_at'),
  detailEpoch: integer('detail_epoch').notNull(), detailGeneration: integer('detail_generation').notNull(),
  detailRevision: integer('detail_revision').notNull().default(0), detailState: text('detail_state').notNull().default('pending'),
  detailAttempt: integer('detail_attempt').notNull().default(0), detailDueAt: integer('detail_due_at').notNull(), detailError: text('detail_error'),
}, table => [
  primaryKey({ columns: [table.storeId, table.id] }),
  foreignKey({ columns: [table.storeId, table.organizationId], foreignColumns: [store.id, store.organizationId] }).onDelete('cascade'),
  uniqueIndex('product_scope_unique').on(table.storeId, table.organizationId, table.id),
  index('product_detail_due_idx').on(table.storeId, table.detailEpoch, table.detailState, table.detailDueAt, table.id),
  check('product_listing_json', sql`json_valid(${table.listing}) AND json_type(${table.listing})='object'`),
  check('product_facts_json', sql`${table.facts} IS NULL OR (json_valid(${table.facts}) AND json_type(${table.facts})='object')`),
  check('product_detail_state_valid', sql`${table.detailState} IN ('pending','complete','error')`),
  check('product_detail_counters_valid', sql`${table.detailEpoch}>0 AND ${table.detailGeneration}>0 AND ${table.detailRevision}>=0 AND ${table.detailAttempt} BETWEEN 0 AND 3`),
  // Ozon list/detail source timestamp semantics have not been established.
  check('product_source_time_unknown', sql`${table.listSourceUpdatedAt} IS NULL AND ${table.factsSourceUpdatedAt} IS NULL`),
]);

export const productSourceSnapshot = sqliteTable('product_source_snapshot', {
  id: text('id').primaryKey(), organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(),
  productId: text('product_id').notNull(), facts: text('facts').notNull(), observedAt: integer('observed_at').notNull(),
  sourceUpdatedAt: integer('source_updated_at'),
}, table => [
  foreignKey({ columns: [table.storeId, table.organizationId, table.productId], foreignColumns: [product.storeId, product.organizationId, product.id] }).onDelete('cascade'),
  index('product_snapshot_history_idx').on(table.organizationId, table.storeId, table.productId, table.observedAt, table.id),
  uniqueIndex('product_snapshot_scope_unique').on(table.organizationId, table.storeId, table.productId, table.id),
  check('product_snapshot_facts_json', sql`json_valid(${table.facts}) AND json_type(${table.facts})='object'`),
  check('product_snapshot_source_time_unknown', sql`${table.sourceUpdatedAt} IS NULL`),
]);

// Merchant-maintained sourcing facts (supply channel and purchase price). These are entered
// by the company, never read from Ozon, and never mixed into the synced product facts.
export const productSourcing = sqliteTable('product_sourcing', {
  organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(), productId: text('product_id').notNull(),
  supplySource: text('supply_source'), purchasePrice: text('purchase_price'), purchaseCurrency: text('purchase_currency'),
  updatedAt: integer('updated_at').notNull(), updatedBy: text('updated_by').notNull(),
}, table => [
  primaryKey({ columns: [table.storeId, table.productId] }),
  foreignKey({ columns: [table.storeId, table.organizationId, table.productId], foreignColumns: [product.storeId, product.organizationId, product.id] }).onDelete('cascade'),
  check('product_sourcing_source_length', sql`${table.supplySource} IS NULL OR (length(${table.supplySource}) BETWEEN 1 AND 200)`),
  check('product_sourcing_price_format', sql`${table.purchasePrice} IS NULL OR (length(${table.purchasePrice})<=14 AND ${table.purchasePrice} GLOB '[0-9]*' AND ${table.purchaseCurrency} IS NOT NULL)`),
  check('product_sourcing_currency_format', sql`${table.purchaseCurrency} IS NULL OR (length(${table.purchaseCurrency})=3 AND ${table.purchaseCurrency}=upper(${table.purchaseCurrency}) AND ${table.purchaseCurrency} GLOB '[A-Z][A-Z][A-Z]')`),
  check('product_sourcing_updated_valid', sql`${table.updatedAt}>=0 AND length(${table.updatedBy})>0`),
]);

// Merchant-maintained product costing facts, versioned by validity window. Purchase price is a
// time-scoped fact: a price change closes the open window (valid_to) and opens a new row, so a
// posting can always be priced with the version that was valid when the order happened. Derived
// money values (selling price, commission, freight, profit) are never stored here; they are
// recomputed from posting facts at read time.
export const productCosting = sqliteTable('product_costing', {
  id: text('id').notNull(), organizationId: text('organization_id').notNull(),
  storeId: text('store_id').notNull(), productId: text('product_id').notNull(),
  purchasePrice: text('purchase_price'), purchaseCurrency: text('purchase_currency'),
  labelFee: text('label_fee'), listPrice: text('list_price'),
  promoDiscount: text('promo_discount'), adBudgetRate: text('ad_budget_rate'), commissionRate: text('commission_rate'),
  weightGrams: integer('weight_grams'), supplySource: text('supply_source'),
  validFrom: integer('valid_from').notNull(), validTo: integer('valid_to'),
  updatedAt: integer('updated_at').notNull(), updatedBy: text('updated_by').notNull(),
}, table => [
  primaryKey({ columns: [table.id] }),
  foreignKey({ columns: [table.storeId, table.organizationId, table.productId], foreignColumns: [product.storeId, product.organizationId, product.id] }).onDelete('cascade'),
  uniqueIndex('product_costing_open_unique').on(table.storeId, table.productId).where(sql`${table.validTo} IS NULL`),
  index('product_costing_window_idx').on(table.storeId, table.productId, table.validFrom, table.validTo),
  check('product_costing_price_format', sql`${table.purchasePrice} IS NULL OR (length(${table.purchasePrice})<=14 AND ${table.purchasePrice} GLOB '[0-9]*' AND ${table.purchaseCurrency} IS NOT NULL)`),
  check('product_costing_currency_format', sql`${table.purchaseCurrency} IS NULL OR (length(${table.purchaseCurrency})=3 AND ${table.purchaseCurrency}=upper(${table.purchaseCurrency}) AND ${table.purchaseCurrency} GLOB '[A-Z][A-Z][A-Z]')`),
  check('product_costing_fee_format', sql`${table.labelFee} IS NULL OR (length(${table.labelFee})<=14 AND ${table.labelFee} GLOB '[0-9]*')`),
  check('product_costing_list_price_format', sql`${table.listPrice} IS NULL OR (length(${table.listPrice})<=14 AND ${table.listPrice} GLOB '[0-9]*')`),
  check('product_costing_rate_format', sql`(${table.promoDiscount} IS NULL OR (length(${table.promoDiscount})<=8 AND ${table.promoDiscount} GLOB '[0-9]*' AND CAST(${table.promoDiscount} AS REAL) BETWEEN 0 AND 1)) AND (${table.adBudgetRate} IS NULL OR (length(${table.adBudgetRate})<=8 AND ${table.adBudgetRate} GLOB '[0-9]*' AND CAST(${table.adBudgetRate} AS REAL) BETWEEN 0 AND 1)) AND (${table.commissionRate} IS NULL OR (length(${table.commissionRate})<=8 AND ${table.commissionRate} GLOB '[0-9]*' AND CAST(${table.commissionRate} AS REAL) BETWEEN 0 AND 1))`),
  check('product_costing_weight_valid', sql`${table.weightGrams} IS NULL OR (${table.weightGrams}>0 AND ${table.weightGrams}<=3000000)`),
  check('product_costing_source_length', sql`${table.supplySource} IS NULL OR (length(${table.supplySource}) BETWEEN 1 AND 200)`),
  check('product_costing_window_valid', sql`${table.validFrom}>=0 AND (${table.validTo} IS NULL OR ${table.validTo}>${table.validFrom})`),
  check('product_costing_updated_valid', sql`${table.updatedAt}>=0 AND length(${table.updatedBy})>0`),
]);

// Translation from a merchant spreadsheet row to the platform product identity. The sheet key is
// the row number, not the product name: names repeat with different costs and change freely. One
// row may cover several platform variants (color/size), so the row maps to a set of products.
export const productNameMap = sqliteTable('product_name_map', {
  organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(),
  sheetRow: integer('sheet_row').notNull(),
  sheetName: text('sheet_name').notNull(),
  offerId: text('offer_id'), productId: text('product_id').notNull(),
  updatedAt: integer('updated_at').notNull(), updatedBy: text('updated_by').notNull(),
}, table => [
  primaryKey({ columns: [table.storeId, table.sheetRow, table.productId] }),
  foreignKey({ columns: [table.storeId, table.organizationId, table.productId], foreignColumns: [product.storeId, product.organizationId, product.id] }).onDelete('cascade'),
  index('product_name_map_product_idx').on(table.organizationId, table.storeId, table.productId),
  uniqueIndex('product_name_map_offer_unique').on(table.storeId, table.offerId).where(sql`${table.offerId} IS NOT NULL`),
  check('product_name_map_row_valid', sql`${table.sheetRow}>0`),
  check('product_name_map_name_length', sql`length(${table.sheetName}) BETWEEN 1 AND 200`),
  check('product_name_map_offer_length', sql`${table.offerId} IS NULL OR (length(${table.offerId}) BETWEEN 1 AND 200)`),
  check('product_name_map_updated_valid', sql`${table.updatedAt}>=0 AND length(${table.updatedBy})>0`),
]);

// Frozen purchase facts captured when a posting completes. Written once from the costing version
// valid at order time and never rewritten (enforced by trigger in the migration), so per-order
// profit stays reproducible. Postings live in fbo_posting/fbp_posting and are referenced
// logically by store and posting number; only the product identity carries a foreign key.
export const postingCostSnapshot = sqliteTable('posting_cost_snapshot', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(),
  postingNumber: text('posting_number').notNull(),
  productId: text('product_id').notNull(),
  costingId: text('costing_id').notNull(),
  quantity: integer('quantity').notNull(),
  purchasePrice: text('purchase_price').notNull(), purchaseCurrency: text('purchase_currency').notNull(),
  labelFee: text('label_fee'), weightGrams: integer('weight_grams'), supplySource: text('supply_source'),
  capturedAt: integer('captured_at').notNull(),
}, table => [
  foreignKey({ columns: [table.storeId, table.organizationId, table.productId], foreignColumns: [product.storeId, product.organizationId, product.id] }).onDelete('cascade'),
  foreignKey({ columns: [table.costingId], foreignColumns: [productCosting.id] }),
  index('posting_cost_snapshot_posting_idx').on(table.organizationId, table.storeId, table.postingNumber),
  index('posting_cost_snapshot_product_idx').on(table.organizationId, table.storeId, table.productId, table.capturedAt),
  check('posting_cost_snapshot_quantity_valid', sql`${table.quantity}>0 AND ${table.quantity}<=100000`),
  check('posting_cost_snapshot_price_format', sql`length(${table.purchasePrice})<=14 AND ${table.purchasePrice} GLOB '[0-9]*'`),
  check('posting_cost_snapshot_currency_format', sql`length(${table.purchaseCurrency})=3 AND ${table.purchaseCurrency}=upper(${table.purchaseCurrency}) AND ${table.purchaseCurrency} GLOB '[A-Z][A-Z][A-Z]'`),
  check('posting_cost_snapshot_captured_valid', sql`${table.capturedAt}>=0`),
]);

// Indexed projection of the current imported snapshots, maintained by SQL triggers.
export const productSku = sqliteTable('product_sku', {
  organizationId: text('organization_id').notNull(), storeId: text('store_id').notNull(),
  sku: text('sku').notNull(), productId: text('product_id').notNull(), source: text('source').notNull(),
}, table => [
  primaryKey({columns:[table.organizationId,table.storeId,table.sku,table.productId,table.source]}),
  foreignKey({columns:[table.storeId,table.organizationId,table.productId],foreignColumns:[product.storeId,product.organizationId,product.id]}).onDelete('cascade'),
  index('product_sku_product_idx').on(table.storeId,table.productId),
  check('product_sku_source_valid',sql`${table.source} IN ('list','details')`),
]);
