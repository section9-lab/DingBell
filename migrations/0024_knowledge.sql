CREATE TABLE `knowledge_audit_event` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`document_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`expected_version` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `knowledge_audit_organization_time_idx` ON `knowledge_audit_event` (`organization_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `knowledge_chunk` (
	`organization_id` text NOT NULL,
	`document_id` text NOT NULL,
	`revision` integer NOT NULL,
	`id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`body` text NOT NULL,
	`body_hash` text NOT NULL,
	PRIMARY KEY(`organization_id`, `id`),
	FOREIGN KEY (`organization_id`,`document_id`,`revision`) REFERENCES `knowledge_revision`(`organization_id`,`document_id`,`revision`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "knowledge_chunk_valid" CHECK("knowledge_chunk"."ordinal">=0 AND length("knowledge_chunk"."id")=64 AND length("knowledge_chunk"."body_hash")=64 AND length(CAST("knowledge_chunk"."body" AS BLOB)) BETWEEN 1 AND 2400)
);
--> statement-breakpoint
CREATE INDEX `knowledge_chunk_revision_idx` ON `knowledge_chunk` (`organization_id`,`document_id`,`revision`,`ordinal`);--> statement-breakpoint
CREATE TABLE `knowledge_document` (
	`organization_id` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`store_id` text,
	`product_ref` text,
	`language` text NOT NULL,
	`version` integer NOT NULL,
	`draft_revision` integer NOT NULL,
	`active_revision` integer,
	`mutation_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`store_id`,`organization_id`) REFERENCES `store`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "knowledge_document_scope" CHECK("knowledge_document"."kind" IN ('product','policy','guide','faq') AND "knowledge_document"."language" IN ('ru','zh-CN','en')
    AND ("knowledge_document"."product_ref" IS NULL OR "knowledge_document"."store_id" IS NOT NULL) AND ("knowledge_document"."kind"<>'product' OR "knowledge_document"."product_ref" IS NOT NULL)),
	CONSTRAINT "knowledge_document_version" CHECK("knowledge_document"."version" BETWEEN 1 AND 9007199254740991 AND "knowledge_document"."draft_revision" BETWEEN 1 AND "knowledge_document"."version"
    AND ("knowledge_document"."active_revision" IS NULL OR "knowledge_document"."active_revision" BETWEEN 1 AND "knowledge_document"."draft_revision"))
);
--> statement-breakpoint
CREATE TABLE `knowledge_revision` (
	`organization_id` text NOT NULL,
	`document_id` text NOT NULL,
	`revision` integer NOT NULL,
	`title` text NOT NULL,
	`source_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`status` text NOT NULL,
	`index_profile` text,
	`mutation_id` text,
	`tested_at` integer,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`rollback_of` integer,
	PRIMARY KEY(`organization_id`, `document_id`, `revision`),
	FOREIGN KEY (`organization_id`,`document_id`) REFERENCES `knowledge_document`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "knowledge_revision_valid" CHECK("knowledge_revision"."revision">0 AND json_valid("knowledge_revision"."source_json") AND length("knowledge_revision"."content_hash")=64
    AND "knowledge_revision"."status" IN ('draft','indexing','ready','failed') AND ("knowledge_revision"."tested_at" IS NULL OR "knowledge_revision"."status"='ready'))
);
--> statement-breakpoint
CREATE TRIGGER knowledge_document_scope_immutable BEFORE UPDATE OF organization_id,id,kind,store_id,product_ref,language ON knowledge_document
WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind
  OR NEW.store_id IS NOT OLD.store_id OR NEW.product_ref IS NOT OLD.product_ref OR NEW.language IS NOT OLD.language
BEGIN SELECT RAISE(ABORT,'knowledge scope is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER knowledge_publish_guard BEFORE UPDATE OF active_revision ON knowledge_document
WHEN NEW.active_revision IS NOT NULL AND (NEW.version<>OLD.version+1 OR NEW.active_revision<>NEW.draft_revision OR NOT EXISTS (
  SELECT 1 FROM knowledge_revision rev WHERE rev.organization_id=NEW.organization_id AND rev.document_id=NEW.id AND rev.revision=NEW.active_revision
  AND rev.status='ready' AND rev.tested_at IS NOT NULL AND rev.index_profile IS NOT NULL AND rev.mutation_id IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'knowledge publication requires a verified revision'); END;
--> statement-breakpoint
CREATE TRIGGER knowledge_revision_immutable BEFORE UPDATE OF organization_id,document_id,revision,title,source_json,content_hash,created_at,created_by,rollback_of ON knowledge_revision
BEGIN SELECT RAISE(ABORT,'knowledge content is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER knowledge_revision_no_replace BEFORE INSERT ON knowledge_revision WHEN EXISTS (
  SELECT 1 FROM knowledge_revision WHERE organization_id=NEW.organization_id AND document_id=NEW.document_id AND revision=NEW.revision)
BEGIN SELECT RAISE(ABORT,'knowledge content is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER knowledge_revision_no_delete BEFORE DELETE ON knowledge_revision WHEN EXISTS (
  SELECT 1 FROM knowledge_document WHERE organization_id=OLD.organization_id AND id=OLD.document_id)
BEGIN SELECT RAISE(ABORT,'knowledge history is retained'); END;
--> statement-breakpoint
CREATE TRIGGER knowledge_chunk_immutable BEFORE UPDATE ON knowledge_chunk
BEGIN SELECT RAISE(ABORT,'knowledge chunks are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER knowledge_chunk_no_replace BEFORE INSERT ON knowledge_chunk WHEN EXISTS (
  SELECT 1 FROM knowledge_chunk WHERE organization_id=NEW.organization_id AND id=NEW.id)
BEGIN SELECT RAISE(ABORT,'knowledge chunks are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER knowledge_chunk_no_delete BEFORE DELETE ON knowledge_chunk WHEN EXISTS (
  SELECT 1 FROM knowledge_revision WHERE organization_id=OLD.organization_id AND document_id=OLD.document_id AND revision=OLD.revision)
BEGIN SELECT RAISE(ABORT,'knowledge chunks are retained'); END;
