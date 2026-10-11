CREATE TABLE `ai_reply_intent` (
	`run_id` text PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`body` text NOT NULL,
	`body_hash` text NOT NULL,
	`citations` text NOT NULL,
	`knowledge_evidence` text NOT NULL,
	`platform_store_id` text NOT NULL,
	`platform_thread_id` text NOT NULL,
	`credential_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `ai_execution`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ai_reply_intent_identity" CHECK("ai_reply_intent"."id"='ai-reply:'||"ai_reply_intent"."run_id" AND length("ai_reply_intent"."payload_hash")=64 AND "ai_reply_intent"."payload_hash" NOT GLOB '*[^0-9a-f]*' AND length("ai_reply_intent"."body_hash")=64 AND "ai_reply_intent"."body_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "ai_reply_intent_body" CHECK(length("ai_reply_intent"."body") BETWEEN 1 AND 1000 AND length(CAST("ai_reply_intent"."body" AS BLOB))<=4000),
	CONSTRAINT "ai_reply_intent_citations" CHECK(json_valid("ai_reply_intent"."citations") AND json_type("ai_reply_intent"."citations")='array' AND json_array_length("ai_reply_intent"."citations") BETWEEN 1 AND 10),
	CONSTRAINT "ai_reply_intent_evidence" CHECK(json_valid("ai_reply_intent"."knowledge_evidence") AND json_type("ai_reply_intent"."knowledge_evidence")='object' AND json_extract("ai_reply_intent"."knowledge_evidence",'$.runId')="ai_reply_intent"."run_id"),
	CONSTRAINT "ai_reply_intent_channel" CHECK(length("ai_reply_intent"."platform_store_id") BETWEEN 1 AND 256 AND length("ai_reply_intent"."platform_thread_id") BETWEEN 1 AND 256 AND typeof("ai_reply_intent"."credential_version")='integer' AND "ai_reply_intent"."credential_version" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "ai_reply_intent_time" CHECK(typeof("ai_reply_intent"."created_at")='integer' AND "ai_reply_intent"."created_at" BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_reply_intent_id_unique` ON `ai_reply_intent` (`id`);
--> statement-breakpoint
CREATE TRIGGER ai_reply_intent_immutable BEFORE UPDATE ON ai_reply_intent
BEGIN SELECT RAISE(ABORT,'AI_REPLY_INTENT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER ai_reply_intent_no_delete BEFORE DELETE ON ai_reply_intent
BEGIN SELECT RAISE(ABORT,'AI_REPLY_INTENT_IMMUTABLE'); END;
