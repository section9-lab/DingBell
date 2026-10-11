CREATE TABLE `reply_test_query` (
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
	`reserved_micros` integer NOT NULL,
	`quota_day` text NOT NULL,
	`admission_token` text NOT NULL,
	`created_at` integer NOT NULL,
	`attempted_at` integer,
	`vectors` text,
	`evidence` text,
	`error_code` text,
	FOREIGN KEY (`conversation_id`,`organization_id`,`store_id`) REFERENCES `conversation`(`id`,`organization_id`,`store_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`budget_id`,`organization_id`) REFERENCES `reply_test_budget`(`id`,`organization_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reply_test_query_payload_valid" CHECK(json_valid("reply_test_query"."payload") AND json_type("reply_test_query"."payload")='object' AND length(CAST("reply_test_query"."payload" AS BLOB)) BETWEEN 1 AND 98304
    AND length("reply_test_query"."payload_hash")=64 AND "reply_test_query"."payload_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "reply_test_query_amount_valid" CHECK(typeof("reply_test_query"."reserved_micros")='integer' AND "reply_test_query"."reserved_micros" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "reply_test_query_time_valid" CHECK(typeof("reply_test_query"."created_at")='integer' AND "reply_test_query"."created_at" BETWEEN 0 AND 8640000000000000
    AND date("reply_test_query"."quota_day") IS NOT NULL AND date("reply_test_query"."quota_day")="reply_test_query"."quota_day"
    AND ("reply_test_query"."attempted_at" IS NULL OR (typeof("reply_test_query"."attempted_at")='integer' AND "reply_test_query"."attempted_at" BETWEEN "reply_test_query"."created_at" AND 8640000000000000))),
	CONSTRAINT "reply_test_query_vectors_valid" CHECK("reply_test_query"."vectors" IS NULL OR ("reply_test_query"."attempted_at" IS NOT NULL AND json_valid("reply_test_query"."vectors") AND json_type("reply_test_query"."vectors")='array'
    AND json_array_length("reply_test_query"."vectors")=1024 AND length(CAST("reply_test_query"."vectors" AS BLOB))<=49152)),
	CONSTRAINT "reply_test_query_evidence_valid" CHECK("reply_test_query"."evidence" IS NULL OR ("reply_test_query"."vectors" IS NOT NULL AND json_valid("reply_test_query"."evidence") AND json_type("reply_test_query"."evidence")='object' AND length(CAST("reply_test_query"."evidence" AS BLOB))<=98304)),
	CONSTRAINT "reply_test_query_error_valid" CHECK("reply_test_query"."error_code" IS NULL OR ("reply_test_query"."attempted_at" IS NOT NULL AND "reply_test_query"."vectors" IS NULL AND "reply_test_query"."error_code"='EMBEDDING_UNCONFIRMED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reply_test_query_request_unique` ON `reply_test_query` (`organization_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `reply_test_query_history_idx` ON `reply_test_query` (`organization_id`,`actor_member_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `reply_test_query_usage` (
	`day` text PRIMARY KEY NOT NULL,
	`reserved_micros` integer NOT NULL,
	`queries` integer NOT NULL,
	CONSTRAINT "reply_test_query_day_valid" CHECK(length("reply_test_query_usage"."day")=10 AND date("reply_test_query_usage"."day") IS NOT NULL AND date("reply_test_query_usage"."day")="reply_test_query_usage"."day"),
	CONSTRAINT "reply_test_query_usage_valid" CHECK(typeof("reply_test_query_usage"."reserved_micros")='integer' AND "reply_test_query_usage"."reserved_micros" BETWEEN 0 AND 9007199254740991 AND typeof("reply_test_query_usage"."queries")='integer' AND "reply_test_query_usage"."queries" BETWEEN 1 AND 1000000)
);
--> statement-breakpoint
CREATE TRIGGER reply_test_query_identity_immutable BEFORE UPDATE ON reply_test_query
WHEN NEW.id IS NOT OLD.id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.store_id IS NOT OLD.store_id OR NEW.conversation_id IS NOT OLD.conversation_id
 OR NEW.request_id IS NOT OLD.request_id OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.actor_member_id IS NOT OLD.actor_member_id OR NEW.budget_id IS NOT OLD.budget_id
 OR NEW.payload IS NOT OLD.payload OR NEW.payload_hash IS NOT OLD.payload_hash OR NEW.reserved_micros IS NOT OLD.reserved_micros OR NEW.quota_day IS NOT OLD.quota_day
 OR NEW.admission_token IS NOT OLD.admission_token OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'REPLY_TEST_QUERY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER reply_test_query_result_immutable BEFORE UPDATE ON reply_test_query
WHEN (OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS NOT OLD.attempted_at) OR (OLD.vectors IS NOT NULL AND NEW.vectors IS NOT OLD.vectors)
 OR (OLD.evidence IS NOT NULL AND NEW.evidence IS NOT OLD.evidence) OR (OLD.error_code IS NOT NULL AND NEW.error_code IS NOT OLD.error_code)
BEGIN SELECT RAISE(ABORT,'REPLY_TEST_QUERY_RESULT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER reply_test_query_vectors_checked BEFORE UPDATE OF vectors ON reply_test_query
WHEN NEW.vectors IS NOT NULL AND (EXISTS (SELECT 1 FROM json_each(NEW.vectors) WHERE type NOT IN ('real','integer'))
 OR NOT EXISTS (SELECT 1 FROM json_each(NEW.vectors) WHERE value<>0))
BEGIN SELECT RAISE(ABORT,'REPLY_TEST_QUERY_VECTORS_INVALID'); END;
--> statement-breakpoint
CREATE TRIGGER reply_test_query_usage_monotonic BEFORE UPDATE ON reply_test_query_usage
WHEN NEW.day IS NOT OLD.day OR NEW.reserved_micros<OLD.reserved_micros OR NEW.queries<OLD.queries
BEGIN SELECT RAISE(ABORT,'REPLY_TEST_QUERY_USAGE_IMMUTABLE'); END;
