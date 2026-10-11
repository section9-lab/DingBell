CREATE TABLE `reply_preview_run` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`request_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_member_id` text NOT NULL,
	`source` text NOT NULL,
	`source_hash` text NOT NULL,
	`source_revision` integer NOT NULL,
	`budget_id` text NOT NULL,
	`config` text NOT NULL,
	`reserved_micros` integer NOT NULL,
	`created_at` integer NOT NULL,
	`receipt` text,
	`settlement` text DEFAULT 'held' NOT NULL,
	`usage` text,
	`charged_micros` integer,
	`settled_at` integer,
	`release_evidence` text,
	FOREIGN KEY (`conversation_id`,`organization_id`,`store_id`) REFERENCES `conversation`(`id`,`organization_id`,`store_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`budget_id`,`organization_id`) REFERENCES `translation_budget_bucket`(`id`,`organization_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reply_preview_identity_valid" CHECK(length("reply_preview_run"."source") BETWEEN 1 AND 1000 AND length("reply_preview_run"."source_hash")=64 AND typeof("reply_preview_run"."source_revision")='integer' AND "reply_preview_run"."source_revision" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "reply_preview_json_valid" CHECK(json_valid("reply_preview_run"."config") AND json_type("reply_preview_run"."config")='object' AND ("reply_preview_run"."receipt" IS NULL OR (json_valid("reply_preview_run"."receipt") AND json_type("reply_preview_run"."receipt")='object'))),
	CONSTRAINT "reply_preview_amount_valid" CHECK(typeof("reply_preview_run"."reserved_micros")='integer' AND "reply_preview_run"."reserved_micros" BETWEEN 0 AND 9007199254740991 AND ("reply_preview_run"."charged_micros" IS NULL OR (typeof("reply_preview_run"."charged_micros")='integer' AND "reply_preview_run"."charged_micros" BETWEEN 0 AND 9007199254740991))),
	CONSTRAINT "reply_preview_time_valid" CHECK(typeof("reply_preview_run"."created_at")='integer' AND "reply_preview_run"."created_at" BETWEEN 0 AND 8640000000000000 AND ("reply_preview_run"."settled_at" IS NULL OR (typeof("reply_preview_run"."settled_at")='integer' AND "reply_preview_run"."settled_at" BETWEEN "reply_preview_run"."created_at" AND 8640000000000000))),
	CONSTRAINT "reply_preview_settlement_valid" CHECK(("reply_preview_run"."settlement"='held' AND "reply_preview_run"."usage" IS NULL AND "reply_preview_run"."charged_micros" IS NULL AND "reply_preview_run"."settled_at" IS NULL AND "reply_preview_run"."release_evidence" IS NULL)
    OR ("reply_preview_run"."settlement"='settled' AND "reply_preview_run"."receipt" IS NOT NULL AND "reply_preview_run"."usage" IS NOT NULL AND json_valid("reply_preview_run"."usage") AND json_type("reply_preview_run"."usage")='object' AND "reply_preview_run"."charged_micros" IS NOT NULL AND "reply_preview_run"."settled_at" IS NOT NULL AND "reply_preview_run"."release_evidence" IS NULL)
    OR ("reply_preview_run"."settlement"='released' AND "reply_preview_run"."usage" IS NULL AND "reply_preview_run"."charged_micros" IS NOT NULL AND "reply_preview_run"."charged_micros"=0 AND "reply_preview_run"."settled_at" IS NOT NULL AND "reply_preview_run"."release_evidence" IS NOT NULL AND json_valid("reply_preview_run"."release_evidence") AND json_type("reply_preview_run"."release_evidence")='object'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reply_preview_request_unique` ON `reply_preview_run` (`organization_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `reply_preview_financial_idx` ON `reply_preview_run` (`settlement`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `translation_budget_bucket` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`limit_micros` integer NOT NULL,
	`reserved_micros` integer DEFAULT 0 NOT NULL,
	`spent_micros` integer DEFAULT 0 NOT NULL,
	`commit_token` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "translation_budget_window_valid" CHECK(typeof("translation_budget_bucket"."starts_at")='integer' AND typeof("translation_budget_bucket"."ends_at")='integer' AND "translation_budget_bucket"."starts_at" BETWEEN 0 AND 8640000000000000 AND "translation_budget_bucket"."ends_at">"translation_budget_bucket"."starts_at" AND "translation_budget_bucket"."ends_at"<=8640000000000000),
	CONSTRAINT "translation_budget_amounts_valid" CHECK(typeof("translation_budget_bucket"."limit_micros")='integer' AND typeof("translation_budget_bucket"."reserved_micros")='integer' AND typeof("translation_budget_bucket"."spent_micros")='integer' AND "translation_budget_bucket"."limit_micros" BETWEEN 0 AND 9007199254740991 AND "translation_budget_bucket"."reserved_micros" BETWEEN 0 AND 9007199254740991 AND "translation_budget_bucket"."spent_micros" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "translation_budget_control_valid" CHECK(typeof("translation_budget_bucket"."enabled")='integer' AND typeof("translation_budget_bucket"."revision")='integer' AND "translation_budget_bucket"."enabled" IN (0,1) AND "translation_budget_bucket"."revision" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `translation_budget_scope_unique` ON `translation_budget_bucket` (`id`,`organization_id`);--> statement-breakpoint
CREATE INDEX `translation_budget_window_idx` ON `translation_budget_bucket` (`organization_id`,`starts_at`,`ends_at`);
--> statement-breakpoint
CREATE TRIGGER translation_budget_overlap BEFORE INSERT ON translation_budget_bucket
WHEN EXISTS (SELECT 1 FROM translation_budget_bucket WHERE organization_id=NEW.organization_id AND starts_at<NEW.ends_at AND ends_at>NEW.starts_at)
BEGIN SELECT RAISE(ABORT,'TRANSLATION_BUDGET_OVERLAP'); END;
--> statement-breakpoint
CREATE TRIGGER translation_budget_immutable BEFORE UPDATE ON translation_budget_bucket
WHEN NEW.id IS NOT OLD.id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.starts_at IS NOT OLD.starts_at OR NEW.ends_at IS NOT OLD.ends_at OR NEW.limit_micros IS NOT OLD.limit_micros
BEGIN SELECT RAISE(ABORT,'TRANSLATION_BUDGET_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER reply_preview_run_immutable BEFORE UPDATE ON reply_preview_run
WHEN NEW.id IS NOT OLD.id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.store_id IS NOT OLD.store_id OR NEW.conversation_id IS NOT OLD.conversation_id
  OR NEW.request_id IS NOT OLD.request_id OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.actor_member_id IS NOT OLD.actor_member_id
  OR NEW.source IS NOT OLD.source OR NEW.source_hash IS NOT OLD.source_hash OR NEW.source_revision IS NOT OLD.source_revision
  OR NEW.budget_id IS NOT OLD.budget_id OR NEW.config IS NOT OLD.config OR NEW.reserved_micros IS NOT OLD.reserved_micros OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'TRANSLATION_RUN_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER reply_preview_receipt_immutable BEFORE UPDATE ON reply_preview_run
WHEN OLD.receipt IS NOT NULL AND NEW.receipt IS NOT OLD.receipt
BEGIN SELECT RAISE(ABORT,'TRANSLATION_RECEIPT_CONFLICT'); END;
--> statement-breakpoint
CREATE TRIGGER reply_preview_settlement_immutable BEFORE UPDATE ON reply_preview_run
WHEN OLD.settlement<>'held' AND (NEW.settlement IS NOT OLD.settlement OR NEW.usage IS NOT OLD.usage OR NEW.charged_micros IS NOT OLD.charged_micros
  OR NEW.settled_at IS NOT OLD.settled_at OR NEW.release_evidence IS NOT OLD.release_evidence OR NEW.receipt IS NOT OLD.receipt)
BEGIN SELECT RAISE(ABORT,'TRANSLATION_SETTLEMENT_CONFLICT'); END;
