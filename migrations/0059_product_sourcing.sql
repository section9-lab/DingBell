-- Merchant-maintained sourcing facts (supply channel and purchase price). Kept apart from the
-- read-only Ozon snapshots: editing them never rewrites a platform observation.
CREATE TABLE product_sourcing (
  organization_id text NOT NULL, store_id text NOT NULL, product_id text NOT NULL,
  supply_source text, purchase_price text, purchase_currency text,
  updated_at integer NOT NULL, updated_by text NOT NULL,
  PRIMARY KEY(store_id,product_id),
  FOREIGN KEY(store_id,organization_id,product_id) REFERENCES product(store_id,organization_id,id) ON DELETE CASCADE,
  CONSTRAINT product_sourcing_source_length CHECK(supply_source IS NULL OR (length(supply_source) BETWEEN 1 AND 200)),
  CONSTRAINT product_sourcing_price_format CHECK(purchase_price IS NULL OR (length(purchase_price)<=14 AND purchase_price GLOB '[0-9]*' AND purchase_currency IS NOT NULL)),
  CONSTRAINT product_sourcing_currency_format CHECK(purchase_currency IS NULL OR (length(purchase_currency)=3 AND purchase_currency=upper(purchase_currency) AND purchase_currency GLOB '[A-Z][A-Z][A-Z]')),
  CONSTRAINT product_sourcing_updated_valid CHECK(updated_at>=0 AND length(updated_by)>0)
);
--> statement-breakpoint
CREATE INDEX product_sourcing_scope_idx ON product_sourcing(organization_id,store_id,product_id);
