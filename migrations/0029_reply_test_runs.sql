CREATE TABLE `reply_test_budget` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`limit_micros` integer NOT NULL,
	`reserved_micros` integer DEFAULT 0 NOT NULL,
	`spent_micros` integer DEFAULT 0 NOT NULL,
	`max_runs` integer NOT NULL,
	`admitted_runs` integer DEFAULT 0 NOT NULL,
	`commit_token` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reply_test_budget_window_valid" CHECK(typeof("reply_test_budget"."starts_at")='integer' AND typeof("reply_test_budget"."ends_at")='integer' AND "reply_test_budget"."starts_at" BETWEEN 0 AND 8640000000000000 AND "reply_test_budget"."ends_at">"reply_test_budget"."starts_at" AND "reply_test_budget"."ends_at"<=8640000000000000),
	CONSTRAINT "reply_test_budget_amounts_valid" CHECK(typeof("reply_test_budget"."limit_micros")='integer' AND typeof("reply_test_budget"."reserved_micros")='integer' AND typeof("reply_test_budget"."spent_micros")='integer'
    AND "reply_test_budget"."limit_micros" BETWEEN 0 AND 9007199254740991 AND "reply_test_budget"."reserved_micros" BETWEEN 0 AND 9007199254740991 AND "reply_test_budget"."spent_micros" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "reply_test_budget_counts_valid" CHECK(typeof("reply_test_budget"."max_runs")='integer' AND typeof("reply_test_budget"."admitted_runs")='integer' AND "reply_test_budget"."max_runs" BETWEEN 1 AND 1000000 AND "reply_test_budget"."admitted_runs" BETWEEN 0 AND "reply_test_budget"."max_runs"),
	CONSTRAINT "reply_test_budget_control_valid" CHECK(typeof("reply_test_budget"."enabled")='integer' AND "reply_test_budget"."enabled" IN (0,1) AND typeof("reply_test_budget"."revision")='integer' AND "reply_test_budget"."revision" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reply_test_budget_scope_unique` ON `reply_test_budget` (`id`,`organization_id`);--> statement-breakpoint
CREATE INDEX `reply_test_budget_window_idx` ON `reply_test_budget` (`organization_id`,`starts_at`,`ends_at`);--> statement-breakpoint
CREATE TABLE `reply_test_run` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`request_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_member_id` text NOT NULL,
	`budget_id` text NOT NULL,
	`payload` text NOT NULL,
	`payload_hash` text NOT NULL,
	`config` text NOT NULL,
	`reserved_micros` integer NOT NULL,
	`created_at` integer NOT NULL,
	`receipt` text,
	`provider_request_claimed_at` integer,
	`settlement` text DEFAULT 'held' NOT NULL,
	`usage` text,
	`charged_micros` integer,
	`settled_at` integer,
	`release_evidence` text,
	FOREIGN KEY (`conversation_id`,`organization_id`,`store_id`) REFERENCES `conversation`(`id`,`organization_id`,`store_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`budget_id`,`organization_id`) REFERENCES `reply_test_budget`(`id`,`organization_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reply_test_payload_valid" CHECK(json_valid("reply_test_run"."payload") AND json_type("reply_test_run"."payload")='object' AND length(CAST("reply_test_run"."payload" AS BLOB)) BETWEEN 1 AND 98304
    AND length("reply_test_run"."payload_hash")=64 AND "reply_test_run"."payload_hash" NOT GLOB '*[^0-9a-f]*' AND json_valid("reply_test_run"."config") AND json_type("reply_test_run"."config")='object'),
	CONSTRAINT "reply_test_receipt_valid" CHECK("reply_test_run"."receipt" IS NULL OR (json_valid("reply_test_run"."receipt") AND json_type("reply_test_run"."receipt")='object')),
	CONSTRAINT "reply_test_amount_valid" CHECK(typeof("reply_test_run"."reserved_micros")='integer' AND "reply_test_run"."reserved_micros" BETWEEN 0 AND 9007199254740991
    AND ("reply_test_run"."charged_micros" IS NULL OR (typeof("reply_test_run"."charged_micros")='integer' AND "reply_test_run"."charged_micros" BETWEEN 0 AND 9007199254740991))),
	CONSTRAINT "reply_test_time_valid" CHECK(typeof("reply_test_run"."created_at")='integer' AND "reply_test_run"."created_at" BETWEEN 0 AND 8640000000000000
    AND ("reply_test_run"."settled_at" IS NULL OR (typeof("reply_test_run"."settled_at")='integer' AND "reply_test_run"."settled_at" BETWEEN "reply_test_run"."created_at" AND 8640000000000000))),
	CONSTRAINT "reply_test_permit_valid" CHECK("reply_test_run"."provider_request_claimed_at" IS NULL OR (typeof("reply_test_run"."provider_request_claimed_at")='integer' AND "reply_test_run"."provider_request_claimed_at" BETWEEN "reply_test_run"."created_at" AND 8640000000000000 AND "reply_test_run"."settlement"<>'released')),
	CONSTRAINT "reply_test_settlement_valid" CHECK(("reply_test_run"."settlement"='held' AND "reply_test_run"."usage" IS NULL AND "reply_test_run"."charged_micros" IS NULL AND "reply_test_run"."settled_at" IS NULL AND "reply_test_run"."release_evidence" IS NULL)
    OR ("reply_test_run"."settlement"='settled' AND "reply_test_run"."receipt" IS NOT NULL AND "reply_test_run"."provider_request_claimed_at" IS NOT NULL AND "reply_test_run"."usage" IS NOT NULL AND json_valid("reply_test_run"."usage") AND json_type("reply_test_run"."usage")='object' AND "reply_test_run"."charged_micros" IS NOT NULL AND "reply_test_run"."settled_at" IS NOT NULL AND "reply_test_run"."release_evidence" IS NULL)
    OR ("reply_test_run"."settlement"='released' AND "reply_test_run"."provider_request_claimed_at" IS NULL AND "reply_test_run"."usage" IS NULL AND "reply_test_run"."charged_micros" IS NOT NULL AND "reply_test_run"."charged_micros"=0 AND "reply_test_run"."settled_at" IS NOT NULL AND "reply_test_run"."release_evidence" IS NOT NULL AND json_valid("reply_test_run"."release_evidence") AND json_type("reply_test_run"."release_evidence")='object'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reply_test_request_unique` ON `reply_test_run` (`organization_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `reply_test_financial_idx` ON `reply_test_run` (`settlement`,`created_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER reply_test_budget_overlap BEFORE INSERT ON reply_test_budget
WHEN EXISTS (SELECT 1 FROM reply_test_budget WHERE organization_id=NEW.organization_id AND starts_at<NEW.ends_at AND ends_at>NEW.starts_at)
BEGIN SELECT RAISE(ABORT,'REPLY_TEST_BUDGET_OVERLAP'); END;
--> statement-breakpoint
CREATE TRIGGER reply_test_budget_immutable BEFORE UPDATE ON reply_test_budget
WHEN NEW.id IS NOT OLD.id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.starts_at IS NOT OLD.starts_at OR NEW.ends_at IS NOT OLD.ends_at
  OR NEW.limit_micros IS NOT OLD.limit_micros OR NEW.max_runs IS NOT OLD.max_runs OR NEW.admitted_runs<OLD.admitted_runs
BEGIN SELECT RAISE(ABORT,'REPLY_TEST_BUDGET_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER reply_test_run_immutable BEFORE UPDATE ON reply_test_run
WHEN NEW.id IS NOT OLD.id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.store_id IS NOT OLD.store_id OR NEW.conversation_id IS NOT OLD.conversation_id
  OR NEW.request_id IS NOT OLD.request_id OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.actor_member_id IS NOT OLD.actor_member_id
  OR NEW.budget_id IS NOT OLD.budget_id OR NEW.payload IS NOT OLD.payload OR NEW.payload_hash IS NOT OLD.payload_hash
  OR NEW.config IS NOT OLD.config OR NEW.reserved_micros IS NOT OLD.reserved_micros OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'REPLY_TEST_RUN_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER reply_test_receipt_immutable BEFORE UPDATE OF receipt ON reply_test_run
WHEN OLD.receipt IS NOT NULL AND NEW.receipt IS NOT OLD.receipt
BEGIN SELECT RAISE(ABORT,'REPLY_TEST_RECEIPT_CONFLICT'); END;
--> statement-breakpoint
CREATE TRIGGER reply_test_permit_immutable BEFORE UPDATE OF provider_request_claimed_at ON reply_test_run
WHEN OLD.provider_request_claimed_at IS NOT NULL AND NEW.provider_request_claimed_at IS NOT OLD.provider_request_claimed_at
BEGIN SELECT RAISE(ABORT,'REPLY_TEST_PERMIT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER reply_test_settlement_immutable BEFORE UPDATE ON reply_test_run
WHEN OLD.settlement<>'held' AND (NEW.settlement IS NOT OLD.settlement OR NEW.usage IS NOT OLD.usage OR NEW.charged_micros IS NOT OLD.charged_micros
  OR NEW.settled_at IS NOT OLD.settled_at OR NEW.release_evidence IS NOT OLD.release_evidence OR NEW.receipt IS NOT OLD.receipt)
BEGIN SELECT RAISE(ABORT,'REPLY_TEST_SETTLEMENT_CONFLICT'); END;
