CREATE TABLE `export_job` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`requester_user_id` text NOT NULL,
	`requester_member_id` text NOT NULL,
	`kind` text NOT NULL,
	`scope` text NOT NULL,
	`filters` text NOT NULL,
	`selected_ids` text,
	`frozen_store_ids` text NOT NULL,
	`filter_hash` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer NOT NULL,
	`snapshot_at` integer NOT NULL,
	`row_count` integer,
	`object_key` text,
	`file_bytes` integer,
	`file_hash` text,
	`expires_at` integer NOT NULL,
	`due_at` integer,
	`lease_token` text,
	`lease_until` integer,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "export_job_kind_scope_valid" CHECK("export_job"."kind" IN ('conversations','messages') AND "export_job"."scope" IN ('all','page','selected') AND json_valid("export_job"."filters") AND json_type("export_job"."filters")='object' AND json_valid("export_job"."frozen_store_ids") AND json_type("export_job"."frozen_store_ids")='array' AND json_array_length("export_job"."frozen_store_ids")>=1 AND length(CAST("export_job"."frozen_store_ids" AS BLOB))<=32768 AND (("export_job"."scope"='all' AND "export_job"."selected_ids" IS NULL) OR ("export_job"."scope" IN ('page','selected') AND json_valid("export_job"."selected_ids") AND json_type("export_job"."selected_ids")='array' AND json_array_length("export_job"."selected_ids") BETWEEN 1 AND 100))),
	CONSTRAINT "export_job_state_valid" CHECK("export_job"."state" IN ('queued','snapshotting','generating','ready','failed','canceled','expired') AND typeof("export_job"."revision")='integer' AND "export_job"."revision" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "export_job_hash_valid" CHECK(length("export_job"."filter_hash")=64 AND "export_job"."filter_hash" NOT GLOB '*[^0-9a-f]*' AND ("export_job"."file_hash" IS NULL OR (length("export_job"."file_hash")=64 AND "export_job"."file_hash" NOT GLOB '*[^0-9a-f]*'))),
	CONSTRAINT "export_job_result_valid" CHECK(("export_job"."state"='ready' AND "export_job"."row_count" BETWEEN 0 AND 100000 AND "export_job"."object_key" IS NOT NULL AND "export_job"."file_bytes" BETWEEN 1 AND 1073741824 AND "export_job"."file_hash" IS NOT NULL AND "export_job"."error_code" IS NULL) OR ("export_job"."state"<>'ready' AND "export_job"."object_key" IS NULL AND "export_job"."file_bytes" IS NULL AND "export_job"."file_hash" IS NULL AND ("export_job"."row_count" IS NULL OR "export_job"."row_count" BETWEEN 0 AND 100001))),
	CONSTRAINT "export_job_lease_valid" CHECK(("export_job"."lease_token" IS NULL AND "export_job"."lease_until" IS NULL) OR ("export_job"."lease_token" IS NOT NULL AND length("export_job"."lease_token") BETWEEN 1 AND 256 AND "export_job"."lease_until" IS NOT NULL)),
	CONSTRAINT "export_job_time_valid" CHECK("export_job"."snapshot_at" BETWEEN 0 AND 8640000000000000 AND "export_job"."created_at"="export_job"."snapshot_at" AND "export_job"."updated_at" BETWEEN "export_job"."created_at" AND 8640000000000000 AND "export_job"."expires_at">"export_job"."created_at" AND "export_job"."expires_at"<=8640000000000000 AND ("export_job"."due_at" IS NULL OR "export_job"."due_at" BETWEEN 0 AND 8640000000000000) AND ("export_job"."lease_until" IS NULL OR "export_job"."lease_until" BETWEEN 0 AND 8640000000000000))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `export_job_scope_unique` ON `export_job` (`id`,`organization_id`);--> statement-breakpoint
CREATE INDEX `export_job_claim_idx` ON `export_job` (`state`,`due_at`,`id`);--> statement-breakpoint
CREATE INDEX `export_job_company_time_idx` ON `export_job` (`organization_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `export_row` (
	`job_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`store_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`job_id`, `ordinal`),
	FOREIGN KEY (`job_id`,`organization_id`) REFERENCES `export_job`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "export_row_valid" CHECK(typeof("export_row"."ordinal")='integer' AND "export_row"."ordinal" BETWEEN 1 AND 100000 AND json_valid("export_row"."payload") AND json_type("export_row"."payload")='object' AND length(CAST("export_row"."payload" AS BLOB)) BETWEEN 2 AND 1048576 AND "export_row"."created_at" BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE INDEX `export_row_job_cursor_idx` ON `export_row` (`job_id`,`ordinal`);