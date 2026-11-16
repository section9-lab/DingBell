-- Company-level default for AI reception. When enabled, a live inbound message on an
-- unassigned conversation lets AI take over without a manual handoff; an AI handoff or a
-- human reply still parks the conversation, so the default never fights a human decision.
CREATE TABLE `company_ai_reception_default` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	CONSTRAINT "company_ai_reception_default_enabled_valid" CHECK(`enabled` IN (0,1)),
	CONSTRAINT "company_ai_reception_default_time_valid" CHECK(typeof(`updated_at`)='integer' AND `updated_at` BETWEEN 0 AND 8640000000000000),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
