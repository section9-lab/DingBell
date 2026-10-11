CREATE TABLE `knowledge_review_job` (
	`organization_id` text NOT NULL,
	`id` text NOT NULL,
	`document_id` text NOT NULL,
	`kind` text NOT NULL,
	`revision` integer NOT NULL,
	`document_version` integer NOT NULL,
	`content_hash` text NOT NULL,
	`profile` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_member_id` text NOT NULL,
	`test_job_id` text,
	`cases_json` text,
	`results_json` text,
	`input_bytes` integer NOT NULL,
	`quota_day` text NOT NULL,
	`state` text NOT NULL,
	`attempted_at` integer,
	`vectors_json` text,
	`mutation_id` text,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`wake_after` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `id`),
	FOREIGN KEY (`organization_id`,`document_id`,`revision`) REFERENCES `knowledge_revision`(`organization_id`,`document_id`,`revision`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "knowledge_review_valid" CHECK("knowledge_review_job"."revision">0 AND "knowledge_review_job"."document_version">1 AND length("knowledge_review_job"."content_hash")=64
    AND "knowledge_review_job"."kind" IN ('test','publish') AND "knowledge_review_job"."state" IN ('queued','running','waiting','succeeded','failed','unknown','cancelled')
    AND (("knowledge_review_job"."kind"='test' AND "knowledge_review_job"."input_bytes" BETWEEN 1 AND 12000 AND json_valid("knowledge_review_job"."cases_json") AND "knowledge_review_job"."test_job_id" IS NULL)
      OR ("knowledge_review_job"."kind"='publish' AND "knowledge_review_job"."input_bytes"=0 AND "knowledge_review_job"."cases_json" IS NULL AND "knowledge_review_job"."test_job_id" IS NOT NULL))
    AND ("knowledge_review_job"."vectors_json" IS NULL OR (json_valid("knowledge_review_job"."vectors_json") AND length(CAST("knowledge_review_job"."vectors_json" AS BLOB))<=1048576))
    AND ("knowledge_review_job"."results_json" IS NULL OR (json_valid("knowledge_review_job"."results_json") AND length(CAST("knowledge_review_job"."results_json" AS BLOB))<=32768)))
);
--> statement-breakpoint
CREATE INDEX `knowledge_review_due_idx` ON `knowledge_review_job` (`state`,`wake_after`,`id`);--> statement-breakpoint
CREATE INDEX `knowledge_review_document_idx` ON `knowledge_review_job` (`organization_id`,`document_id`,`id`);--> statement-breakpoint
CREATE INDEX `knowledge_review_day_idx` ON `knowledge_review_job` (`organization_id`,`quota_day`);