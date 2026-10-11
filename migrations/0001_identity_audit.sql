CREATE TABLE `identity_audit_event` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`actor_user_id` text,
	`organization_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `identity_audit_request_idx` ON `identity_audit_event` (`request_id`);--> statement-breakpoint
CREATE INDEX `identity_audit_organization_time_idx` ON `identity_audit_event` (`organization_id`,`created_at`);