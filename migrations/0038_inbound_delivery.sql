ALTER TABLE `ingest_event` ADD `delivery_due_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ingest_event` ADD `delivery_token` text;--> statement-breakpoint
ALTER TABLE `ingest_event` ADD `processed_at` integer;--> statement-breakpoint
ALTER TABLE `ingest_event` ADD `delivery_outcome` text;--> statement-breakpoint
CREATE INDEX `ingest_event_delivery_idx` ON `ingest_event` (`state`,`processed_at`,`delivery_due_at`,`created_at`,`id`);