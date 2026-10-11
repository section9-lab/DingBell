CREATE TABLE `probe_bootstrap` (
	`id` integer PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`expected_user_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`organization_name` text NOT NULL,
	`state` text NOT NULL,
	`execution_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`user_id` text,
	`organization_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `probe_bootstrap_claim_id_unique` ON `probe_bootstrap` (`claim_id`);