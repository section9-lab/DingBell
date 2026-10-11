CREATE TABLE `ai_budget` (
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
	CONSTRAINT "ai_budget_window_valid" CHECK(typeof("ai_budget"."starts_at")='integer' AND typeof("ai_budget"."ends_at")='integer' AND "ai_budget"."starts_at" BETWEEN 0 AND 8640000000000000 AND "ai_budget"."ends_at">"ai_budget"."starts_at" AND "ai_budget"."ends_at"<=8640000000000000),
	CONSTRAINT "ai_budget_amounts_valid" CHECK(typeof("ai_budget"."limit_micros")='integer' AND typeof("ai_budget"."reserved_micros")='integer' AND typeof("ai_budget"."spent_micros")='integer'
    AND "ai_budget"."limit_micros" BETWEEN 0 AND 9007199254740991 AND "ai_budget"."reserved_micros" BETWEEN 0 AND 9007199254740991 AND "ai_budget"."spent_micros" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "ai_budget_counts_valid" CHECK(typeof("ai_budget"."max_runs")='integer' AND typeof("ai_budget"."admitted_runs")='integer' AND "ai_budget"."max_runs" BETWEEN 1 AND 1000000 AND "ai_budget"."admitted_runs" BETWEEN 0 AND "ai_budget"."max_runs"),
	CONSTRAINT "ai_budget_control_valid" CHECK(typeof("ai_budget"."enabled")='integer' AND "ai_budget"."enabled" IN (0,1) AND typeof("ai_budget"."revision")='integer' AND "ai_budget"."revision" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_budget_scope_unique` ON `ai_budget` (`id`,`organization_id`);--> statement-breakpoint
CREATE INDEX `ai_budget_window_idx` ON `ai_budget` (`organization_id`,`starts_at`,`ends_at`);--> statement-breakpoint
CREATE TABLE `ai_budget_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`budget_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_member_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`action` text NOT NULL,
	`payload` text NOT NULL,
	`revision` integer NOT NULL,
	`enabled` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`budget_id`,`organization_id`) REFERENCES `ai_budget`(`id`,`organization_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ai_budget_audit_payload_valid" CHECK(json_valid("ai_budget_audit"."payload") AND json_type("ai_budget_audit"."payload")='object' AND length(CAST("ai_budget_audit"."payload" AS BLOB)) BETWEEN 1 AND 4096),
	CONSTRAINT "ai_budget_audit_action_valid" CHECK("ai_budget_audit"."action" IN ('create','set_enabled') AND typeof("ai_budget_audit"."enabled")='integer' AND "ai_budget_audit"."enabled" IN (0,1)
    AND typeof("ai_budget_audit"."revision")='integer' AND "ai_budget_audit"."revision" BETWEEN 0 AND 9007199254740991 AND ("ai_budget_audit"."action"<>'create' OR ("ai_budget_audit"."revision"=0 AND "ai_budget_audit"."enabled"=0))),
	CONSTRAINT "ai_budget_audit_time_valid" CHECK(typeof("ai_budget_audit"."created_at")='integer' AND "ai_budget_audit"."created_at" BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE INDEX `ai_budget_audit_history_idx` ON `ai_budget_audit` (`organization_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `ai_execution` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`controller_id` text NOT NULL,
	`budget_id` text NOT NULL,
	`payload` text NOT NULL,
	`payload_hash` text NOT NULL,
	`config` text NOT NULL,
	`per_generation_micros` integer NOT NULL,
	`reserved_micros` integer NOT NULL,
	`max_generations` integer NOT NULL,
	`generations` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`receipt` text,
	`closure` text,
	`commit_token` text,
	FOREIGN KEY (`conversation_id`,`organization_id`,`store_id`) REFERENCES `conversation`(`id`,`organization_id`,`store_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`budget_id`,`organization_id`) REFERENCES `ai_budget`(`id`,`organization_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ai_execution_payload_valid" CHECK(json_valid("ai_execution"."payload") AND json_type("ai_execution"."payload")='object' AND length(CAST("ai_execution"."payload" AS BLOB)) BETWEEN 1 AND 98304
  AND length("ai_execution"."payload_hash")=64 AND "ai_execution"."payload_hash" NOT GLOB '*[^0-9a-f]*' AND json_valid("ai_execution"."config") AND json_type("ai_execution"."config")='object'),
	CONSTRAINT "ai_execution_amounts_valid" CHECK(typeof("ai_execution"."per_generation_micros")='integer' AND "ai_execution"."per_generation_micros" BETWEEN 0 AND 9007199254740991
  AND typeof("ai_execution"."reserved_micros")='integer' AND "ai_execution"."reserved_micros" BETWEEN 0 AND 9007199254740991 AND "ai_execution"."reserved_micros"="ai_execution"."per_generation_micros"*"ai_execution"."max_generations"),
	CONSTRAINT "ai_execution_generations_valid" CHECK(typeof("ai_execution"."max_generations")='integer' AND "ai_execution"."max_generations" BETWEEN 1 AND 8 AND typeof("ai_execution"."generations")='integer' AND "ai_execution"."generations" BETWEEN 0 AND "ai_execution"."max_generations"),
	CONSTRAINT "ai_execution_records_valid" CHECK(("ai_execution"."receipt" IS NULL OR (json_valid("ai_execution"."receipt") AND json_type("ai_execution"."receipt")='object')) AND ("ai_execution"."closure" IS NULL OR (json_valid("ai_execution"."closure") AND json_type("ai_execution"."closure")='object'))),
	CONSTRAINT "ai_execution_time_valid" CHECK(typeof("ai_execution"."created_at")='integer' AND "ai_execution"."created_at" BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE INDEX `ai_execution_history_idx` ON `ai_execution` (`organization_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `ai_generation` (
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`claimed_at` integer NOT NULL,
	`usage` text,
	`charged_micros` integer,
	`settled_at` integer,
	PRIMARY KEY(`run_id`, `sequence`),
	FOREIGN KEY (`run_id`) REFERENCES `ai_execution`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ai_generation_sequence_valid" CHECK(typeof("ai_generation"."sequence")='integer' AND "ai_generation"."sequence" BETWEEN 1 AND 8),
	CONSTRAINT "ai_generation_time_valid" CHECK(typeof("ai_generation"."claimed_at")='integer' AND "ai_generation"."claimed_at" BETWEEN 0 AND 8640000000000000 AND ("ai_generation"."settled_at" IS NULL OR (typeof("ai_generation"."settled_at")='integer' AND "ai_generation"."settled_at" BETWEEN "ai_generation"."claimed_at" AND 8640000000000000))),
	CONSTRAINT "ai_generation_settlement_valid" CHECK(("ai_generation"."usage" IS NULL AND "ai_generation"."charged_micros" IS NULL AND "ai_generation"."settled_at" IS NULL) OR
  ("ai_generation"."usage" IS NOT NULL AND json_valid("ai_generation"."usage") AND json_type("ai_generation"."usage")='object' AND "ai_generation"."charged_micros" IS NOT NULL AND typeof("ai_generation"."charged_micros")='integer' AND "ai_generation"."charged_micros" BETWEEN 0 AND 9007199254740991 AND "ai_generation"."settled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TRIGGER ai_budget_overlap BEFORE INSERT ON ai_budget
WHEN EXISTS (SELECT 1 FROM ai_budget WHERE organization_id=NEW.organization_id AND starts_at<NEW.ends_at AND ends_at>NEW.starts_at)
BEGIN SELECT RAISE(ABORT,'AI_BUDGET_OVERLAP'); END;
--> statement-breakpoint
CREATE TRIGGER ai_budget_immutable BEFORE UPDATE ON ai_budget
WHEN NEW.id IS NOT OLD.id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.starts_at IS NOT OLD.starts_at OR NEW.ends_at IS NOT OLD.ends_at
  OR NEW.limit_micros IS NOT OLD.limit_micros OR NEW.max_runs IS NOT OLD.max_runs OR NEW.admitted_runs<OLD.admitted_runs
BEGIN SELECT RAISE(ABORT,'AI_BUDGET_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER ai_budget_audit_immutable BEFORE UPDATE ON ai_budget_audit
BEGIN SELECT RAISE(ABORT,'AI_BUDGET_AUDIT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER ai_execution_insert_guard BEFORE INSERT ON ai_execution
WHEN json_extract(NEW.payload,'$.schemaVersion') IS NOT 1 OR json_extract(NEW.payload,'$.run.schemaVersion') IS NOT 1
 OR json_extract(NEW.payload,'$.run.request.runId') IS NOT NEW.id OR json_extract(NEW.payload,'$.run.scope.organizationId') IS NOT NEW.organization_id
 OR json_extract(NEW.payload,'$.run.scope.storeId') IS NOT NEW.store_id OR json_extract(NEW.payload,'$.run.scope.conversationId') IS NOT NEW.conversation_id
 OR json_extract(NEW.payload,'$.run.scope.controllerId') IS NOT NEW.controller_id OR json_extract(NEW.config,'$.maxGenerations') IS NOT NEW.max_generations
 OR json_extract(NEW.payload,'$.target.agent') IS NOT 'Support' OR json_extract(NEW.payload,'$.target.instanceId') IS NOT ('ai-support:'||NEW.id) OR json_extract(NEW.payload,'$.target.dispatchKey') IS NOT NEW.id
 OR NEW.generations<>0 OR NEW.receipt IS NOT NULL OR NEW.closure IS NOT NULL
BEGIN SELECT RAISE(ABORT,'AI_EXECUTION_SCOPE_MISMATCH'); END;
--> statement-breakpoint
CREATE TRIGGER ai_execution_immutable BEFORE UPDATE ON ai_execution
WHEN NEW.id IS NOT OLD.id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.store_id IS NOT OLD.store_id OR NEW.conversation_id IS NOT OLD.conversation_id
 OR NEW.controller_id IS NOT OLD.controller_id OR NEW.budget_id IS NOT OLD.budget_id OR NEW.payload IS NOT OLD.payload OR NEW.payload_hash IS NOT OLD.payload_hash OR NEW.config IS NOT OLD.config
 OR NEW.per_generation_micros IS NOT OLD.per_generation_micros OR NEW.reserved_micros IS NOT OLD.reserved_micros OR NEW.max_generations IS NOT OLD.max_generations OR NEW.created_at IS NOT OLD.created_at
 OR NEW.generations<OLD.generations OR NEW.generations>OLD.generations+1 OR (OLD.closure IS NOT NULL AND NEW.generations IS NOT OLD.generations)
 OR (OLD.receipt IS NOT NULL AND NEW.receipt IS NOT OLD.receipt) OR (OLD.closure IS NOT NULL AND NEW.closure IS NOT OLD.closure)
BEGIN SELECT RAISE(ABORT,'AI_EXECUTION_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER ai_generation_insert_guard BEFORE INSERT ON ai_generation
WHEN NOT EXISTS (SELECT 1 FROM ai_execution r WHERE r.id=NEW.run_id AND r.generations=NEW.sequence AND r.closure IS NULL AND NEW.claimed_at>=r.created_at)
BEGIN SELECT RAISE(ABORT,'AI_GENERATION_UNAUTHORIZED'); END;
--> statement-breakpoint
CREATE TRIGGER ai_generation_immutable BEFORE UPDATE ON ai_generation
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.sequence IS NOT OLD.sequence OR NEW.claimed_at IS NOT OLD.claimed_at
 OR (OLD.usage IS NOT NULL AND (NEW.usage IS NOT OLD.usage OR NEW.charged_micros IS NOT OLD.charged_micros OR NEW.settled_at IS NOT OLD.settled_at))
BEGIN SELECT RAISE(ABORT,'AI_GENERATION_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER ai_budget_delete_guard BEFORE DELETE ON ai_budget
BEGIN SELECT RAISE(ABORT,'AI_FINANCIAL_RECORD_REQUIRED'); END;
--> statement-breakpoint
CREATE TRIGGER ai_budget_audit_delete_guard BEFORE DELETE ON ai_budget_audit
BEGIN SELECT RAISE(ABORT,'AI_FINANCIAL_RECORD_REQUIRED'); END;
--> statement-breakpoint
CREATE TRIGGER ai_execution_delete_guard BEFORE DELETE ON ai_execution
BEGIN SELECT RAISE(ABORT,'AI_FINANCIAL_RECORD_REQUIRED'); END;
--> statement-breakpoint
CREATE TRIGGER ai_generation_delete_guard BEFORE DELETE ON ai_generation
BEGIN SELECT RAISE(ABORT,'AI_FINANCIAL_RECORD_REQUIRED'); END;
