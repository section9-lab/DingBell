-- Merchant-maintained product costing facts. Purchase price is a time-versioned fact, not a
-- static product attribute: every price change closes the current window and opens a new one,
-- so historical order profit stays reproducible. Derived values (selling price, commission,
-- freight, profit) are intentionally absent and are always recomputed from order facts.
CREATE TABLE product_costing (
  id text NOT NULL, organization_id text NOT NULL, store_id text NOT NULL, product_id text NOT NULL,
  purchase_price text, purchase_currency text,
  label_fee text, list_price text,
  promo_discount text, ad_budget_rate text, commission_rate text,
  weight_grams integer, supply_source text,
  valid_from integer NOT NULL, valid_to integer,
  updated_at integer NOT NULL, updated_by text NOT NULL,
  PRIMARY KEY(id),
  FOREIGN KEY(store_id,organization_id,product_id) REFERENCES product(store_id,organization_id,id) ON DELETE CASCADE,
  CONSTRAINT product_costing_price_format CHECK(purchase_price IS NULL OR (length(purchase_price)<=14 AND purchase_price GLOB '[0-9]*' AND purchase_currency IS NOT NULL)),
  CONSTRAINT product_costing_currency_format CHECK(purchase_currency IS NULL OR (length(purchase_currency)=3 AND purchase_currency=upper(purchase_currency) AND purchase_currency GLOB '[A-Z][A-Z][A-Z]')),
  CONSTRAINT product_costing_fee_format CHECK(label_fee IS NULL OR (length(label_fee)<=14 AND label_fee GLOB '[0-9]*')),
  CONSTRAINT product_costing_list_price_format CHECK(list_price IS NULL OR (length(list_price)<=14 AND list_price GLOB '[0-9]*')),
  CONSTRAINT product_costing_rate_format CHECK((promo_discount IS NULL OR (length(promo_discount)<=8 AND promo_discount GLOB '[0-9]*' AND CAST(promo_discount AS REAL) BETWEEN 0 AND 1)) AND (ad_budget_rate IS NULL OR (length(ad_budget_rate)<=8 AND ad_budget_rate GLOB '[0-9]*' AND CAST(ad_budget_rate AS REAL) BETWEEN 0 AND 1)) AND (commission_rate IS NULL OR (length(commission_rate)<=8 AND commission_rate GLOB '[0-9]*' AND CAST(commission_rate AS REAL) BETWEEN 0 AND 1))),
  CONSTRAINT product_costing_weight_valid CHECK(weight_grams IS NULL OR (weight_grams>0 AND weight_grams<=3000000)),
  CONSTRAINT product_costing_source_length CHECK(supply_source IS NULL OR (length(supply_source) BETWEEN 1 AND 200)),
  CONSTRAINT product_costing_window_valid CHECK(valid_from>=0 AND (valid_to IS NULL OR valid_to>valid_from)),
  CONSTRAINT product_costing_updated_valid CHECK(updated_at>=0 AND length(updated_by)>0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX product_costing_open_unique ON product_costing(store_id,product_id) WHERE valid_to IS NULL;
--> statement-breakpoint
CREATE INDEX product_costing_window_idx ON product_costing(store_id,product_id,valid_from,valid_to);
--> statement-breakpoint
-- Translation from the merchant spreadsheet row to the platform product identity. The sheet key
-- is the row number, not the product name: names repeat with different costs and change freely.
-- One sheet row may cover several platform variants (color/size), so the row maps to a set of
-- products and every mapped product carries the row's cost model.
CREATE TABLE product_name_map (
  organization_id text NOT NULL, store_id text NOT NULL,
  sheet_row integer NOT NULL,
  sheet_name text NOT NULL,
  offer_id text,
  product_id text NOT NULL,
  updated_at integer NOT NULL, updated_by text NOT NULL,
  PRIMARY KEY(store_id,sheet_row,product_id),
  FOREIGN KEY(store_id,organization_id,product_id) REFERENCES product(store_id,organization_id,id) ON DELETE CASCADE,
  CONSTRAINT product_name_map_row_valid CHECK(sheet_row>0),
  CONSTRAINT product_name_map_name_length CHECK(length(sheet_name) BETWEEN 1 AND 200),
  CONSTRAINT product_name_map_offer_length CHECK(offer_id IS NULL OR (length(offer_id) BETWEEN 1 AND 200)),
  CONSTRAINT product_name_map_updated_valid CHECK(updated_at>=0 AND length(updated_by)>0)
);
--> statement-breakpoint
CREATE INDEX product_name_map_product_idx ON product_name_map(organization_id,store_id,product_id);
--> statement-breakpoint
CREATE UNIQUE INDEX product_name_map_offer_unique ON product_name_map(store_id,offer_id) WHERE offer_id IS NOT NULL;
--> statement-breakpoint
-- Frozen purchase facts captured when a posting completes. Written once from the costing version
-- valid at order time and never rewritten, so per-order profit can always be reproduced. Posting
-- rows live in fbo_posting/fbp_posting and are referenced logically by store and posting number.
CREATE TABLE posting_cost_snapshot (
  id text PRIMARY KEY NOT NULL,
  organization_id text NOT NULL, store_id text NOT NULL, posting_number text NOT NULL,
  product_id text NOT NULL,
  costing_id text NOT NULL,
  quantity integer NOT NULL,
  purchase_price text NOT NULL, purchase_currency text NOT NULL,
  label_fee text, weight_grams integer, supply_source text,
  captured_at integer NOT NULL,
  FOREIGN KEY(store_id,organization_id,product_id) REFERENCES product(store_id,organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY(costing_id) REFERENCES product_costing(id),
  CONSTRAINT posting_cost_snapshot_quantity_valid CHECK(quantity>0 AND quantity<=100000),
  CONSTRAINT posting_cost_snapshot_price_format CHECK(length(purchase_price)<=14 AND purchase_price GLOB '[0-9]*'),
  CONSTRAINT posting_cost_snapshot_currency_format CHECK(length(purchase_currency)=3 AND purchase_currency=upper(purchase_currency) AND purchase_currency GLOB '[A-Z][A-Z][A-Z]'),
  CONSTRAINT posting_cost_snapshot_captured_valid CHECK(captured_at>=0)
);
--> statement-breakpoint
CREATE INDEX posting_cost_snapshot_posting_idx ON posting_cost_snapshot(organization_id,store_id,posting_number);
--> statement-breakpoint
CREATE INDEX posting_cost_snapshot_product_idx ON posting_cost_snapshot(organization_id,store_id,product_id,captured_at);
--> statement-breakpoint
CREATE TRIGGER posting_cost_snapshot_immutable BEFORE UPDATE ON posting_cost_snapshot
BEGIN SELECT RAISE(ABORT,'POSTING_COST_SNAPSHOT_IMMUTABLE'); END;
