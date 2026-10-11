CREATE TABLE `company_settings` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`time_zone` text NOT NULL,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "company_settings_version_valid" CHECK(typeof("company_settings"."version")='integer' AND "company_settings"."version" BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `company_settings_audit_event` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`outcome` text NOT NULL,
	`from_version` integer NOT NULL,
	`to_version` integer,
	`before_time_zone` text NOT NULL,
	`requested_time_zone` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `company_settings_audit_request_idx` ON `company_settings_audit_event` (`request_id`);--> statement-breakpoint
CREATE INDEX `company_settings_audit_organization_time_idx` ON `company_settings_audit_event` (`organization_id`,`created_at`,`id`);