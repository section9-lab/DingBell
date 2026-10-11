ALTER TABLE `ai_execution` ADD `repair_due_at` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `ai_execution` ADD `repair_token` text;--> statement-breakpoint
CREATE INDEX `ai_execution_repair_idx` ON `ai_execution` (`repair_due_at`,`id`);