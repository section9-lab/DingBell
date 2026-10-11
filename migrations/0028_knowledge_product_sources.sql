CREATE TABLE `knowledge_product_source` (
	`organization_id` text NOT NULL,
	`document_id` text NOT NULL,
	`revision` integer NOT NULL,
	`store_id` text NOT NULL,
	`product_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	PRIMARY KEY(`organization_id`, `document_id`, `revision`),
	FOREIGN KEY (`organization_id`,`document_id`,`revision`) REFERENCES `knowledge_revision`(`organization_id`,`document_id`,`revision`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`store_id`,`product_id`,`snapshot_id`) REFERENCES `product_source_snapshot`(`organization_id`,`store_id`,`product_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "knowledge_product_source_revision" CHECK("knowledge_product_source"."revision">0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_product_source_import_unique` ON `knowledge_product_source` (`organization_id`,`document_id`,`snapshot_id`);--> statement-breakpoint
CREATE INDEX `knowledge_product_source_snapshot_idx` ON `knowledge_product_source` (`snapshot_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_snapshot_scope_unique` ON `product_source_snapshot` (`organization_id`,`store_id`,`product_id`,`id`);
--> statement-breakpoint
CREATE TRIGGER knowledge_product_source_scope BEFORE INSERT ON knowledge_product_source
WHEN NOT EXISTS (SELECT 1 FROM knowledge_document WHERE organization_id=NEW.organization_id AND id=NEW.document_id
  AND kind='product' AND store_id=NEW.store_id AND product_ref=NEW.product_id)
BEGIN SELECT RAISE(ABORT,'knowledge product source scope mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER knowledge_product_source_immutable_update BEFORE UPDATE ON knowledge_product_source
BEGIN SELECT RAISE(ABORT,'knowledge product source is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER knowledge_product_source_immutable_replace BEFORE INSERT ON knowledge_product_source
WHEN EXISTS (SELECT 1 FROM knowledge_product_source WHERE organization_id=NEW.organization_id AND document_id=NEW.document_id
  AND (revision=NEW.revision OR snapshot_id=NEW.snapshot_id))
BEGIN SELECT RAISE(ABORT,'knowledge product source is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER knowledge_product_source_immutable_delete BEFORE DELETE ON knowledge_product_source
WHEN EXISTS (SELECT 1 FROM knowledge_document doc JOIN store ON store.id=doc.store_id AND store.organization_id=doc.organization_id
  WHERE doc.organization_id=OLD.organization_id AND doc.id=OLD.document_id)
BEGIN SELECT RAISE(ABORT,'knowledge product source is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_product_snapshot_immutable_update BEFORE UPDATE ON product_source_snapshot
WHEN EXISTS (SELECT 1 FROM knowledge_product_source WHERE snapshot_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'imported product snapshot is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER imported_product_snapshot_immutable_replace BEFORE INSERT ON product_source_snapshot
WHEN EXISTS (SELECT 1 FROM knowledge_product_source WHERE snapshot_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'imported product snapshot is immutable'); END;
