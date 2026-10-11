CREATE TABLE `product_sku` (
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`sku` text NOT NULL,
	`product_id` text NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`organization_id`, `store_id`, `sku`, `product_id`, `source`),
	FOREIGN KEY (`store_id`,`organization_id`,`product_id`) REFERENCES `product`(`store_id`,`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_sku_source_valid" CHECK("product_sku"."source" IN ('list','details'))
);
--> statement-breakpoint
CREATE INDEX `product_sku_product_idx` ON `product_sku` (`store_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `fbs_posting_number_idx` ON `fbs_posting` (`organization_id`,`store_id`,`order_number`,`order_id`,`posting_number`);
--> statement-breakpoint
-- Backfill and maintain exact SKU aliases from normalized list/detail snapshots.
INSERT INTO product_sku (organization_id,store_id,sku,product_id,source)
SELECT DISTINCT organization_id,store_id,sku,id,source FROM (
  SELECT organization_id,store_id,id,json_extract(listing,'$.sku') AS sku,'list' AS source FROM product
  UNION ALL SELECT organization_id,store_id,id,json_extract(facts,'$.sku'),'details' FROM product
  UNION ALL SELECT product.organization_id,product.store_id,product.id,json_extract(alias.value,'$.sku'),'details'
    FROM product, json_each(product.facts,'$.sources') AS alias
) WHERE typeof(sku)='text' AND length(sku) BETWEEN 1 AND 40
  AND sku NOT GLOB '*[^0-9]*' AND (sku='0' OR substr(sku,1,1)!='0');
--> statement-breakpoint
CREATE TRIGGER product_sku_insert AFTER INSERT ON product BEGIN
INSERT INTO product_sku (organization_id,store_id,sku,product_id,source)
SELECT DISTINCT organization_id,store_id,sku,id,source FROM (
  SELECT organization_id,store_id,id,json_extract(listing,'$.sku') AS sku,'list' AS source FROM product WHERE store_id=NEW.store_id AND id=NEW.id
  UNION ALL SELECT organization_id,store_id,id,json_extract(facts,'$.sku'),'details' FROM product WHERE store_id=NEW.store_id AND id=NEW.id
  UNION ALL SELECT product.organization_id,product.store_id,product.id,json_extract(alias.value,'$.sku'),'details'
    FROM product, json_each(product.facts,'$.sources') AS alias WHERE product.store_id=NEW.store_id AND product.id=NEW.id
) WHERE typeof(sku)='text' AND length(sku) BETWEEN 1 AND 40
  AND sku NOT GLOB '*[^0-9]*' AND (sku='0' OR substr(sku,1,1)!='0');
END;
--> statement-breakpoint
CREATE TRIGGER product_sku_update AFTER UPDATE OF listing,facts ON product BEGIN
DELETE FROM product_sku WHERE store_id=OLD.store_id AND product_id=OLD.id;
INSERT INTO product_sku (organization_id,store_id,sku,product_id,source)
SELECT DISTINCT organization_id,store_id,sku,id,source FROM (
  SELECT organization_id,store_id,id,json_extract(listing,'$.sku') AS sku,'list' AS source FROM product WHERE store_id=NEW.store_id AND id=NEW.id
  UNION ALL SELECT organization_id,store_id,id,json_extract(facts,'$.sku'),'details' FROM product WHERE store_id=NEW.store_id AND id=NEW.id
  UNION ALL SELECT product.organization_id,product.store_id,product.id,json_extract(alias.value,'$.sku'),'details'
    FROM product, json_each(product.facts,'$.sources') AS alias WHERE product.store_id=NEW.store_id AND product.id=NEW.id
) WHERE typeof(sku)='text' AND length(sku) BETWEEN 1 AND 40
  AND sku NOT GLOB '*[^0-9]*' AND (sku='0' OR substr(sku,1,1)!='0');
END;
