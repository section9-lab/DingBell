CREATE INDEX `conversation_org_time_idx` ON `conversation` (`organization_id`,`last_message_at`,`id`);--> statement-breakpoint
CREATE INDEX `conversation_org_thread_idx` ON `conversation` (`organization_id`,`platform_thread_id`,`last_message_at`,`id`);--> statement-breakpoint
CREATE INDEX `message_org_order_idx` ON `message` (`organization_id`,`order_number`,`conversation_id`);
