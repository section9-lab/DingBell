ALTER TABLE `ai_knowledge_query` ADD `gateway_log_id` text
  CONSTRAINT "ai_knowledge_query_gateway_log_valid" CHECK(`gateway_log_id` IS NULL OR length(`gateway_log_id`) BETWEEN 1 AND 256);
--> statement-breakpoint
ALTER TABLE `ai_knowledge_query` ADD `gateway_usage` text;
--> statement-breakpoint
ALTER TABLE `ai_knowledge_query` ADD `charged_micros` integer;
--> statement-breakpoint
ALTER TABLE `ai_knowledge_query` ADD `settled_at` integer
  CONSTRAINT "ai_knowledge_query_settlement_valid" CHECK((`gateway_usage` IS NULL AND `charged_micros` IS NULL AND `settled_at` IS NULL) OR
    (`gateway_log_id` IS NOT NULL AND json_valid(`gateway_usage`) AND json_type(`gateway_usage`)='object'
      AND typeof(`charged_micros`)='integer' AND `charged_micros` BETWEEN 0 AND `reserved_micros`
      AND typeof(`settled_at`)='integer' AND `settled_at` BETWEEN `created_at` AND 8640000000000000));
--> statement-breakpoint
DROP TRIGGER `ai_knowledge_query_immutable`;
--> statement-breakpoint
CREATE TRIGGER ai_knowledge_query_immutable BEFORE UPDATE ON ai_knowledge_query
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.config IS NOT OLD.config OR NEW.scope IS NOT OLD.scope
 OR NEW.question_hash IS NOT OLD.question_hash OR NEW.reserved_micros IS NOT OLD.reserved_micros OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.vectors IS NOT NULL AND NEW.vectors IS NOT OLD.vectors) OR (OLD.evidence IS NOT NULL AND NEW.evidence IS NOT OLD.evidence)
 OR (OLD.gateway_log_id IS NOT NULL AND NEW.gateway_log_id IS NOT OLD.gateway_log_id)
 OR (OLD.gateway_usage IS NOT NULL AND NEW.gateway_usage IS NOT OLD.gateway_usage)
 OR (OLD.charged_micros IS NOT NULL AND NEW.charged_micros IS NOT OLD.charged_micros)
 OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS NOT OLD.settled_at)
BEGIN SELECT RAISE(ABORT,'AI_KNOWLEDGE_QUERY_IMMUTABLE'); END;
