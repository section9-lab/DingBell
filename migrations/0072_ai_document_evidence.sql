CREATE TABLE `ai_document_evidence` (
	`run_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`scope` text NOT NULL,
	`profile` text NOT NULL,
	`question_hash` text NOT NULL,
	`documents` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `ai_execution`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ai_document_evidence_valid" CHECK(json_valid("scope") AND json_type("scope")='object'
  AND json_valid("documents") AND json_type("documents")='array' AND json_array_length("documents") BETWEEN 1 AND 10
  AND length("profile") BETWEEN 1 AND 64
  AND length("question_hash")=64 AND "question_hash" NOT GLOB '*[^0-9a-f]*'
  AND typeof("created_at")='integer' AND "created_at" BETWEEN 0 AND 8640000000000000
  AND typeof("updated_at")='integer' AND "updated_at" BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE INDEX `ai_document_evidence_org_idx` ON `ai_document_evidence` (`organization_id`,`updated_at`);
--> statement-breakpoint
-- Evidence may only grow: a later tool call cannot hide a document this run was already shown.
CREATE TRIGGER ai_document_evidence_append_only BEFORE UPDATE ON ai_document_evidence
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.scope IS NOT OLD.scope
 OR NEW.profile IS NOT OLD.profile OR NEW.question_hash IS NOT OLD.question_hash OR NEW.created_at IS NOT OLD.created_at
 OR json_array_length(NEW.documents) < json_array_length(OLD.documents)
 OR EXISTS (SELECT 1 FROM json_each(OLD.documents) kept WHERE NOT EXISTS (
   SELECT 1 FROM json_each(NEW.documents) fresh WHERE json_extract(fresh.value,'$.documentId')=json_extract(kept.value,'$.documentId')
    AND json_extract(fresh.value,'$.revision')=json_extract(kept.value,'$.revision')
    AND json_extract(fresh.value,'$.contentHash')=json_extract(kept.value,'$.contentHash')))
BEGIN SELECT RAISE(ABORT,'AI_DOCUMENT_EVIDENCE_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER ai_document_evidence_no_delete BEFORE DELETE ON ai_document_evidence
BEGIN SELECT RAISE(ABORT,'AI_DOCUMENT_EVIDENCE_IMMUTABLE'); END;
