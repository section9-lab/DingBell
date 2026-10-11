CREATE TABLE `bootstrap_installation` (
	`id` integer PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`expected_user_id` text NOT NULL,
	`expected_organization_id` text NOT NULL,
	`expected_member_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`organization_name` text NOT NULL,
	`state` text NOT NULL,
	`execution_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`verification_requested_at` integer,
	`user_id` text,
	`organization_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "bootstrap_singleton" CHECK("bootstrap_installation"."id" = 1),
	CONSTRAINT "bootstrap_state" CHECK("bootstrap_installation"."state" IN ('provisioning', 'initialized'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bootstrap_installation_claim_id_unique` ON `bootstrap_installation` (`claim_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bootstrap_installation_expected_user_id_unique` ON `bootstrap_installation` (`expected_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bootstrap_installation_expected_organization_id_unique` ON `bootstrap_installation` (`expected_organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bootstrap_installation_expected_member_id_unique` ON `bootstrap_installation` (`expected_member_id`);