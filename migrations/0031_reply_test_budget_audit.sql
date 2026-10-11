CREATE TABLE `reply_test_budget_audit` (
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
	FOREIGN KEY (`budget_id`,`organization_id`) REFERENCES `reply_test_budget`(`id`,`organization_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reply_test_budget_audit_payload_valid" CHECK(json_valid("reply_test_budget_audit"."payload") AND json_type("reply_test_budget_audit"."payload")='object' AND length(CAST("reply_test_budget_audit"."payload" AS BLOB)) BETWEEN 1 AND 4096),
	CONSTRAINT "reply_test_budget_audit_action_valid" CHECK("reply_test_budget_audit"."action" IN ('create','set_enabled') AND typeof("reply_test_budget_audit"."enabled")='integer' AND "reply_test_budget_audit"."enabled" IN (0,1)
    AND typeof("reply_test_budget_audit"."revision")='integer' AND "reply_test_budget_audit"."revision" BETWEEN 0 AND 9007199254740991 AND ("reply_test_budget_audit"."action"<>'create' OR ("reply_test_budget_audit"."revision"=0 AND "reply_test_budget_audit"."enabled"=0))),
	CONSTRAINT "reply_test_budget_audit_time_valid" CHECK(typeof("reply_test_budget_audit"."created_at")='integer' AND "reply_test_budget_audit"."created_at" BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE INDEX `reply_test_budget_audit_history_idx` ON `reply_test_budget_audit` (`organization_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TRIGGER reply_test_budget_audit_immutable BEFORE UPDATE ON reply_test_budget_audit
BEGIN SELECT RAISE(ABORT,'REPLY_TEST_BUDGET_AUDIT_IMMUTABLE'); END;
