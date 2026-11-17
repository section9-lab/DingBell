-- Variant grouping and observed stock quantities come from the same /v3/product/info/list
-- response the details sync already calls. They stay outside product.facts so stock refreshes
-- do not rewrite immutable facts snapshots or invalidate published knowledge sources.
ALTER TABLE product ADD COLUMN model_id TEXT;
--> statement-breakpoint
ALTER TABLE product ADD COLUMN stock_has_stock INTEGER CONSTRAINT product_stock_has_stock_valid CHECK(stock_has_stock IS NULL OR stock_has_stock IN (0,1));
--> statement-breakpoint
ALTER TABLE product ADD COLUMN stock_observed_at INTEGER;
--> statement-breakpoint
CREATE INDEX product_model_idx ON product(store_id,model_id) WHERE model_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE product_stock (
  organization_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  source TEXT NOT NULL,
  sku TEXT NOT NULL,
  present INTEGER NOT NULL,
  reserved INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY(store_id,product_id,source,sku),
  FOREIGN KEY(store_id,organization_id,product_id) REFERENCES product(store_id,organization_id,id) ON DELETE CASCADE,
  CONSTRAINT product_stock_quantity_valid CHECK(present>=0 AND reserved>=0),
  CONSTRAINT product_stock_source_valid CHECK(length(source) BETWEEN 1 AND 64),
  CONSTRAINT product_stock_sku_valid CHECK(length(sku) BETWEEN 1 AND 40 AND sku GLOB '[0-9]*')
);
--> statement-breakpoint
CREATE INDEX product_stock_product_idx ON product_stock(organization_id,store_id,product_id);
--> statement-breakpoint
-- One-time backfill: existing rows predate these columns and detail sync only re-reads pending
-- products. Identical facts do not insert a new product_source_snapshot, so this cannot rewrite
-- published knowledge sources; it only re-observes model grouping and stock.
UPDATE product SET detail_state='pending',detail_attempt=0,detail_error=NULL,detail_due_at=0 WHERE detail_state<>'pending';
