CREATE TABLE `ai_knowledge_query` (
	`run_id` text PRIMARY KEY NOT NULL,
	`config` text NOT NULL,
	`scope` text NOT NULL,
	`question_hash` text NOT NULL,
	`reserved_micros` integer NOT NULL,
	`created_at` integer NOT NULL,
	`vectors` text,
	`evidence` text,
	FOREIGN KEY (`run_id`) REFERENCES `ai_execution`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ai_knowledge_query_json" CHECK(json_valid("ai_knowledge_query"."config") AND json_type("ai_knowledge_query"."config")='object' AND json_valid("ai_knowledge_query"."scope") AND json_type("ai_knowledge_query"."scope")='object'
  AND ("ai_knowledge_query"."vectors" IS NULL OR (json_valid("ai_knowledge_query"."vectors") AND json_type("ai_knowledge_query"."vectors")='array'))
  AND ("ai_knowledge_query"."evidence" IS NULL OR ("ai_knowledge_query"."vectors" IS NOT NULL AND json_valid("ai_knowledge_query"."evidence") AND json_type("ai_knowledge_query"."evidence")='object'))),
	CONSTRAINT "ai_knowledge_query_amount" CHECK(typeof("ai_knowledge_query"."reserved_micros")='integer' AND "ai_knowledge_query"."reserved_micros" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "ai_knowledge_query_identity" CHECK(length("ai_knowledge_query"."question_hash")=64 AND "ai_knowledge_query"."question_hash" NOT GLOB '*[^0-9a-f]*' AND typeof("ai_knowledge_query"."created_at")='integer' AND "ai_knowledge_query"."created_at" BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE TRIGGER ai_knowledge_query_immutable BEFORE UPDATE ON ai_knowledge_query
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.config IS NOT OLD.config OR NEW.scope IS NOT OLD.scope
 OR NEW.question_hash IS NOT OLD.question_hash OR NEW.reserved_micros IS NOT OLD.reserved_micros OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.vectors IS NOT NULL AND NEW.vectors IS NOT OLD.vectors) OR (OLD.evidence IS NOT NULL AND NEW.evidence IS NOT OLD.evidence)
BEGIN SELECT RAISE(ABORT,'AI_KNOWLEDGE_QUERY_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER ai_knowledge_query_no_delete BEFORE DELETE ON ai_knowledge_query
BEGIN SELECT RAISE(ABORT,'AI_KNOWLEDGE_QUERY_IMMUTABLE'); END;
