CREATE TABLE `conversation_export_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_member_id` text NOT NULL,
	`kind` text NOT NULL,
	`scope` text NOT NULL,
	`filters` text NOT NULL,
	`selected_ids` text,
	`filter_hash` text NOT NULL,
	`selected_count` integer NOT NULL,
	`snapshot_at` integer NOT NULL,
	`row_count` integer NOT NULL,
	`file_bytes` integer NOT NULL,
	`file_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_export_audit_kind_valid" CHECK("conversation_export_audit"."kind" IN ('conversations','messages') AND "conversation_export_audit"."scope" IN ('all','page','selected')),
	CONSTRAINT "conversation_export_audit_scope_valid" CHECK(json_valid("conversation_export_audit"."filters") AND json_type("conversation_export_audit"."filters")='object' AND length(CAST("conversation_export_audit"."filters" AS BLOB)) BETWEEN 2 AND 4096 AND (("conversation_export_audit"."scope"='all' AND "conversation_export_audit"."selected_ids" IS NULL AND "conversation_export_audit"."selected_count"=0) OR ("conversation_export_audit"."scope" IN ('page','selected') AND json_valid("conversation_export_audit"."selected_ids") AND json_type("conversation_export_audit"."selected_ids")='array' AND json_array_length("conversation_export_audit"."selected_ids")="conversation_export_audit"."selected_count" AND "conversation_export_audit"."selected_count" BETWEEN 1 AND 100 AND length(CAST("conversation_export_audit"."selected_ids" AS BLOB)) BETWEEN 3 AND 32768))),
	CONSTRAINT "conversation_export_audit_hash_valid" CHECK(length("conversation_export_audit"."filter_hash")=64 AND "conversation_export_audit"."filter_hash" NOT GLOB '*[^0-9a-f]*' AND length("conversation_export_audit"."file_hash")=64 AND "conversation_export_audit"."file_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "conversation_export_audit_counts_valid" CHECK(typeof("conversation_export_audit"."selected_count")='integer' AND "conversation_export_audit"."selected_count" BETWEEN 0 AND 100 AND typeof("conversation_export_audit"."row_count")='integer' AND "conversation_export_audit"."row_count" BETWEEN 0 AND 5000 AND typeof("conversation_export_audit"."file_bytes")='integer' AND "conversation_export_audit"."file_bytes" BETWEEN 1 AND 8388608),
	CONSTRAINT "conversation_export_audit_time_valid" CHECK(typeof("conversation_export_audit"."snapshot_at")='integer' AND "conversation_export_audit"."snapshot_at" BETWEEN 0 AND 8640000000000000 AND typeof("conversation_export_audit"."created_at")='integer' AND "conversation_export_audit"."created_at" BETWEEN "conversation_export_audit"."snapshot_at" AND 8640000000000000)
);
--> statement-breakpoint
CREATE INDEX `conversation_export_audit_company_time_idx` ON `conversation_export_audit` (`organization_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `conversation_export_audit_actor_time_idx` ON `conversation_export_audit` (`actor_member_id`,`created_at`,`id`);