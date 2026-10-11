CREATE TABLE `ai_answer` (
	`run_id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`citations` text NOT NULL,
	`knowledge_evidence` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `ai_execution`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ai_answer_body" CHECK(length("ai_answer"."body") BETWEEN 1 AND 1000 AND length(CAST("ai_answer"."body" AS BLOB))<=4000),
	CONSTRAINT "ai_answer_citations" CHECK(json_valid("ai_answer"."citations") AND json_type("ai_answer"."citations")='array' AND json_array_length("ai_answer"."citations") BETWEEN 1 AND 10),
	CONSTRAINT "ai_answer_evidence" CHECK(json_valid("ai_answer"."knowledge_evidence") AND json_type("ai_answer"."knowledge_evidence")='object' AND json_extract("ai_answer"."knowledge_evidence",'$.runId')="ai_answer"."run_id"),
	CONSTRAINT "ai_answer_time" CHECK(typeof("ai_answer"."created_at")='integer' AND "ai_answer"."created_at" BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE TRIGGER ai_answer_immutable BEFORE UPDATE ON ai_answer
BEGIN SELECT RAISE(ABORT,'AI_ANSWER_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER ai_answer_no_delete BEFORE DELETE ON ai_answer
BEGIN SELECT RAISE(ABORT,'AI_ANSWER_IMMUTABLE'); END;
