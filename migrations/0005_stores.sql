CREATE TABLE `store` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`platform` text DEFAULT 'ozon' NOT NULL,
	`platform_store_id` text NOT NULL,
	`status` text DEFAULT 'unverified' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`credential_version` integer DEFAULT 1 NOT NULL,
	`credential_key_version` text,
	`credential_nonce` text,
	`credential_ciphertext` text,
	`capabilities` text,
	`checked_at` integer,
	`expires_at` integer,
	`check_token` text,
	`check_until` integer,
	`next_check_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "store_platform_valid" CHECK("store"."platform" = 'ozon'),
	CONSTRAINT "store_status_valid" CHECK("store"."status" IN ('unverified','verified','partial','attention','paused','disconnected')),
	CONSTRAINT "store_revision_positive" CHECK("store"."revision" > 0 AND "store"."credential_version" > 0),
	CONSTRAINT "store_credential_envelope_complete" CHECK(("store"."credential_key_version" IS NULL AND "store"."credential_nonce" IS NULL AND "store"."credential_ciphertext" IS NULL)
    OR ("store"."credential_key_version" IS NOT NULL AND "store"."credential_nonce" IS NOT NULL AND "store"."credential_ciphertext" IS NOT NULL)),
	CONSTRAINT "store_capabilities_json" CHECK("store"."capabilities" IS NULL OR json_valid("store"."capabilities"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `store_platform_account_unique` ON `store` (`organization_id`,`platform`,`platform_store_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `store_id_organization_unique` ON `store` (`id`,`organization_id`);--> statement-breakpoint
CREATE INDEX `store_organization_created_idx` ON `store` (`organization_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `store_audit_event` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`target_member_id` text,
	`from_revision` integer,
	`to_revision` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `store_audit_request_idx` ON `store_audit_event` (`request_id`);--> statement-breakpoint
CREATE INDEX `store_audit_organization_time_idx` ON `store_audit_event` (`organization_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `store_grant` (
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`member_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`store_id`, `member_id`),
	FOREIGN KEY (`store_id`,`organization_id`) REFERENCES `store`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`,`organization_id`) REFERENCES `member`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `store_grant_member_idx` ON `store_grant` (`member_id`,`organization_id`,`store_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_id_organization_unique` ON `member` (`id`,`organization_id`);