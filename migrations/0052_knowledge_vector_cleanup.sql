CREATE TABLE `knowledge_vector_cleanup` (
	`organization_id` text NOT NULL,
	`document_id` text NOT NULL,
	`revision` integer NOT NULL,
	`profile` text NOT NULL,
	`vector_ids_json` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer NOT NULL,
	`claim_token` text,
	`lease_until` integer,
	`wake_after` integer NOT NULL,
	`mutation_id` text,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `document_id`, `revision`, `profile`),
	FOREIGN KEY (`organization_id`,`document_id`,`revision`) REFERENCES `knowledge_revision`(`organization_id`,`document_id`,`revision`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "knowledge_vector_cleanup_valid" CHECK("knowledge_vector_cleanup"."revision">0 AND json_valid("knowledge_vector_cleanup"."vector_ids_json") AND json_array_length("knowledge_vector_cleanup"."vector_ids_json") BETWEEN 1 AND 32
    AND length(CAST("knowledge_vector_cleanup"."vector_ids_json" AS BLOB))<=4096 AND "knowledge_vector_cleanup"."state" IN ('queued','deleting','confirming','succeeded','failed')
    AND "knowledge_vector_cleanup"."attempts" BETWEEN 0 AND 20 AND (("knowledge_vector_cleanup"."claim_token" IS NULL AND "knowledge_vector_cleanup"."lease_until" IS NULL) OR (length("knowledge_vector_cleanup"."claim_token") BETWEEN 1 AND 64 AND "knowledge_vector_cleanup"."lease_until">0)))
);
--> statement-breakpoint
CREATE INDEX `knowledge_vector_cleanup_due_idx` ON `knowledge_vector_cleanup` (`state`,`wake_after`,`lease_until`);