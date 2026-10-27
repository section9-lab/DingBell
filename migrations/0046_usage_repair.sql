ALTER TABLE `reply_preview_run` ADD `repair_due_at` integer DEFAULT 0
  CONSTRAINT "reply_preview_repair_valid" CHECK(`repair_due_at` IS NULL OR (typeof(`repair_due_at`)='integer' AND `repair_due_at` BETWEEN 0 AND 8640000000000000));
--> statement-breakpoint
ALTER TABLE `reply_preview_run` ADD `repair_token` text;
--> statement-breakpoint
CREATE INDEX `reply_preview_repair_idx` ON `reply_preview_run` (`settlement`,`repair_due_at`,`id`);
--> statement-breakpoint
ALTER TABLE `reply_test_run` ADD `repair_due_at` integer DEFAULT 0
  CONSTRAINT "reply_test_repair_valid" CHECK(`repair_due_at` IS NULL OR (typeof(`repair_due_at`)='integer' AND `repair_due_at` BETWEEN 0 AND 8640000000000000));
--> statement-breakpoint
ALTER TABLE `reply_test_run` ADD `repair_token` text;
--> statement-breakpoint
CREATE INDEX `reply_test_repair_idx` ON `reply_test_run` (`settlement`,`repair_due_at`,`id`);
