CREATE TABLE `knowledge_index_job` (
	`organization_id` text NOT NULL,
	`id` text NOT NULL,
	`document_id` text NOT NULL,
	`revision` integer NOT NULL,
	`document_version` integer NOT NULL,
	`content_hash` text NOT NULL,
	`profile` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_member_id` text NOT NULL,
	`input_bytes` integer NOT NULL,
	`quota_day` text NOT NULL,
	`state` text NOT NULL,
	`attempted_at` integer,
	`vectors_json` text,
	`mutation_id` text,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`wake_after` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `id`),
	FOREIGN KEY (`organization_id`,`document_id`,`revision`) REFERENCES `knowledge_revision`(`organization_id`,`document_id`,`revision`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "knowledge_index_job_valid" CHECK("knowledge_index_job"."revision">0 AND "knowledge_index_job"."document_version">1 AND length("knowledge_index_job"."content_hash")=64
    AND "knowledge_index_job"."input_bytes" BETWEEN 1 AND 38400 AND "knowledge_index_job"."state" IN ('queued','embedding','indexing','succeeded','failed','unknown','cancelled')
    AND ("knowledge_index_job"."vectors_json" IS NULL OR (json_valid("knowledge_index_job"."vectors_json") AND length(CAST("knowledge_index_job"."vectors_json" AS BLOB))<=1048576)))
);
--> statement-breakpoint
CREATE INDEX `knowledge_index_job_due_idx` ON `knowledge_index_job` (`state`,`wake_after`,`id`);--> statement-breakpoint
CREATE INDEX `knowledge_index_job_day_idx` ON `knowledge_index_job` (`organization_id`,`quota_day`);--> statement-breakpoint
CREATE TABLE `knowledge_index_usage` (
	`day` text PRIMARY KEY NOT NULL,
	`reserved_bytes` integer NOT NULL,
	`jobs` integer NOT NULL,
	CONSTRAINT "knowledge_index_usage_valid" CHECK("knowledge_index_usage"."reserved_bytes">=0 AND "knowledge_index_usage"."jobs">=0)
);
