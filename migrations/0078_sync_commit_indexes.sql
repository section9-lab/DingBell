-- Indexes for the per-page chat commit path. Without these, the ingest projection
-- joined on (store_id, platform_thread_id) and (platform_message_id) without a usable
-- index prefix and scanned the whole store per page.
CREATE INDEX `conversation_store_thread_idx` ON `conversation` (`store_id`,`organization_id`,`platform_thread_id`);
--> statement-breakpoint
CREATE INDEX `message_store_platform_idx` ON `message` (`store_id`,`platform_message_id`);
