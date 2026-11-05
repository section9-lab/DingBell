CREATE TABLE `ai_knowledge_evidence` (
	`run_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`scope` text NOT NULL,
	`profile` text NOT NULL,
	`question_hash` text NOT NULL,
	`chunks` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `ai_execution`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ai_knowledge_evidence_valid" CHECK(json_valid("scope") AND json_type("scope")='object'
  AND json_valid("chunks") AND json_type("chunks")='array' AND json_array_length("chunks") BETWEEN 1 AND 10
  AND length("profile") BETWEEN 1 AND 64
  AND length("question_hash")=64 AND "question_hash" NOT GLOB '*[^0-9a-f]*'
  AND typeof("created_at")='integer' AND "created_at" BETWEEN 0 AND 8640000000000000
  AND typeof("updated_at")='integer' AND "updated_at" BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE INDEX `ai_knowledge_evidence_org_idx` ON `ai_knowledge_evidence` (`organization_id`,`updated_at`);
--> statement-breakpoint
CREATE TRIGGER ai_knowledge_evidence_append_only BEFORE UPDATE ON ai_knowledge_evidence
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.scope IS NOT OLD.scope
 OR NEW.profile IS NOT OLD.profile OR NEW.question_hash IS NOT OLD.question_hash OR NEW.created_at IS NOT OLD.created_at
 OR json_array_length(NEW.chunks) < json_array_length(OLD.chunks)
 OR EXISTS (SELECT 1 FROM json_each(OLD.chunks) kept WHERE NOT EXISTS (
   SELECT 1 FROM json_each(NEW.chunks) fresh WHERE json_extract(fresh.value,'$.chunkId')=json_extract(kept.value,'$.chunkId')
    AND json_extract(fresh.value,'$.bodyHash')=json_extract(kept.value,'$.bodyHash')))
BEGIN SELECT RAISE(ABORT,'AI_KNOWLEDGE_EVIDENCE_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER ai_knowledge_evidence_no_delete BEFORE DELETE ON ai_knowledge_evidence
BEGIN SELECT RAISE(ABORT,'AI_KNOWLEDGE_EVIDENCE_IMMUTABLE'); END;
--> statement-breakpoint
-- Text approval is a second publication path: the merchant reads the stored
-- chunks directly, so no index profile or retrieval test is involved.
DROP TRIGGER knowledge_publish_guard;
--> statement-breakpoint
CREATE TRIGGER knowledge_publish_guard BEFORE UPDATE OF active_revision ON knowledge_document
WHEN NEW.active_revision IS NOT NULL AND (NEW.version<>OLD.version+1 OR NEW.active_revision<>NEW.draft_revision OR NOT EXISTS (
  SELECT 1 FROM knowledge_revision rev WHERE rev.organization_id=NEW.organization_id AND rev.document_id=NEW.id AND rev.revision=NEW.active_revision
  AND ((rev.status='ready' AND rev.tested_at IS NOT NULL AND rev.index_profile IS NOT NULL AND rev.mutation_id IS NOT NULL
    AND rev.published_at>=rev.tested_at AND length(rev.published_mutation_id)>0 AND rev.published_profile=rev.index_profile)
   OR (rev.published_profile='text-grep-2400-v1' AND rev.published_at IS NOT NULL AND length(rev.published_mutation_id)>0))))
BEGIN SELECT RAISE(ABORT,'knowledge publication requires a verified revision'); END;
