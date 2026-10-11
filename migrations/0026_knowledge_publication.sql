ALTER TABLE `knowledge_revision` ADD `published_profile` text;--> statement-breakpoint
ALTER TABLE `knowledge_revision` ADD `published_mutation_id` text;--> statement-breakpoint
ALTER TABLE `knowledge_revision` ADD `published_at` integer;
--> statement-breakpoint
DROP TRIGGER knowledge_publish_guard;
--> statement-breakpoint
CREATE TRIGGER knowledge_publish_guard BEFORE UPDATE OF active_revision ON knowledge_document
WHEN NEW.active_revision IS NOT NULL AND (NEW.version<>OLD.version+1 OR NEW.active_revision<>NEW.draft_revision OR NOT EXISTS (
  SELECT 1 FROM knowledge_revision rev WHERE rev.organization_id=NEW.organization_id AND rev.document_id=NEW.id AND rev.revision=NEW.active_revision
  AND rev.status='ready' AND rev.tested_at IS NOT NULL AND rev.index_profile IS NOT NULL AND rev.mutation_id IS NOT NULL
  AND rev.published_at>=rev.tested_at AND length(rev.published_mutation_id)>0 AND rev.published_profile=rev.index_profile))
BEGIN SELECT RAISE(ABORT,'knowledge publication requires a verified revision'); END;
