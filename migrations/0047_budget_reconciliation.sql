CREATE TABLE `budget_reconciliation_state` (
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`budget_id` text NOT NULL,
	`next_due_at` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`status` text,
	`payload` text,
	`observed_at` integer,
	`mismatch_since` integer,
	`consecutive_mismatches` integer DEFAULT 0 NOT NULL,
	`last_error_at` integer,
	`last_error_code` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`organization_id`, `kind`, `budget_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "budget_reconciliation_kind_valid" CHECK("budget_reconciliation_state"."kind" IN ('ai','translation','reply-test')),
	CONSTRAINT "budget_reconciliation_result_valid" CHECK(("budget_reconciliation_state"."status" IS NULL AND "budget_reconciliation_state"."payload" IS NULL AND "budget_reconciliation_state"."observed_at" IS NULL AND "budget_reconciliation_state"."mismatch_since" IS NULL AND "budget_reconciliation_state"."consecutive_mismatches"=0) OR
  ("budget_reconciliation_state"."status"='balanced' AND json_valid("budget_reconciliation_state"."payload") AND json_type("budget_reconciliation_state"."payload")='object' AND typeof("budget_reconciliation_state"."observed_at")='integer' AND "budget_reconciliation_state"."observed_at" BETWEEN 0 AND 8640000000000000 AND "budget_reconciliation_state"."mismatch_since" IS NULL AND "budget_reconciliation_state"."consecutive_mismatches"=0) OR
  ("budget_reconciliation_state"."status"='mismatch' AND json_valid("budget_reconciliation_state"."payload") AND json_type("budget_reconciliation_state"."payload")='object' AND typeof("budget_reconciliation_state"."observed_at")='integer' AND "budget_reconciliation_state"."observed_at" BETWEEN 0 AND 8640000000000000 AND typeof("budget_reconciliation_state"."mismatch_since")='integer' AND "budget_reconciliation_state"."consecutive_mismatches">0)),
	CONSTRAINT "budget_reconciliation_time_valid" CHECK(typeof("budget_reconciliation_state"."next_due_at")='integer' AND "budget_reconciliation_state"."next_due_at" BETWEEN 0 AND 8640000000000000
  AND ("budget_reconciliation_state"."mismatch_since" IS NULL OR (typeof("budget_reconciliation_state"."mismatch_since")='integer' AND "budget_reconciliation_state"."mismatch_since" BETWEEN 0 AND 8640000000000000))
  AND (("budget_reconciliation_state"."last_error_at" IS NULL AND "budget_reconciliation_state"."last_error_code" IS NULL) OR (typeof("budget_reconciliation_state"."last_error_at")='integer' AND "budget_reconciliation_state"."last_error_at" BETWEEN 0 AND 8640000000000000 AND "budget_reconciliation_state"."last_error_code"='AUDIT_UNAVAILABLE'))
  AND typeof("budget_reconciliation_state"."updated_at")='integer' AND "budget_reconciliation_state"."updated_at" BETWEEN 0 AND 8640000000000000),
	CONSTRAINT "budget_reconciliation_count_valid" CHECK(typeof("budget_reconciliation_state"."consecutive_mismatches")='integer' AND "budget_reconciliation_state"."consecutive_mismatches" BETWEEN 0 AND 9007199254740991
  AND typeof("budget_reconciliation_state"."consecutive_failures")='integer' AND "budget_reconciliation_state"."consecutive_failures" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE INDEX `budget_reconciliation_due_idx` ON `budget_reconciliation_state` (`next_due_at`,`organization_id`,`kind`,`budget_id`);
--> statement-breakpoint
INSERT INTO `budget_reconciliation_state` (`organization_id`,`kind`,`budget_id`)
 SELECT `organization_id`,'ai',`id` FROM `ai_budget`
 UNION ALL SELECT `organization_id`,'translation',`id` FROM `translation_budget_bucket`
 UNION ALL SELECT `organization_id`,'reply-test',`id` FROM `reply_test_budget`;
--> statement-breakpoint
CREATE TRIGGER `budget_reconciliation_ai_insert` AFTER INSERT ON `ai_budget` BEGIN
 INSERT INTO `budget_reconciliation_state` (`organization_id`,`kind`,`budget_id`) VALUES (NEW.`organization_id`,'ai',NEW.`id`);
END;
--> statement-breakpoint
CREATE TRIGGER `budget_reconciliation_translation_insert` AFTER INSERT ON `translation_budget_bucket` BEGIN
 INSERT INTO `budget_reconciliation_state` (`organization_id`,`kind`,`budget_id`) VALUES (NEW.`organization_id`,'translation',NEW.`id`);
END;
--> statement-breakpoint
CREATE TRIGGER `budget_reconciliation_reply_test_insert` AFTER INSERT ON `reply_test_budget` BEGIN
 INSERT INTO `budget_reconciliation_state` (`organization_id`,`kind`,`budget_id`) VALUES (NEW.`organization_id`,'reply-test',NEW.`id`);
END;
--> statement-breakpoint
CREATE TRIGGER `budget_reconciliation_no_delete` BEFORE DELETE ON `budget_reconciliation_state` BEGIN SELECT RAISE(ABORT,'budget reconciliation state cannot be deleted'); END;