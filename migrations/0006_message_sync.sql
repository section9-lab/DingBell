CREATE TABLE `conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`channel_type` text DEFAULT 'private' NOT NULL,
	`platform_thread_id` text NOT NULL,
	`platform_type` text NOT NULL,
	`platform_status` text NOT NULL,
	`platform_created_at` integer NOT NULL,
	`last_message_id` text,
	`imported_at` integer NOT NULL,
	`last_message_at` integer,
	FOREIGN KEY (`store_id`,`organization_id`) REFERENCES `store`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_channel_valid" CHECK("conversation"."channel_type"='private')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_platform_thread_unique` ON `conversation` (`store_id`,`channel_type`,`platform_thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_scope_unique` ON `conversation` (`id`,`organization_id`,`store_id`);--> statement-breakpoint
CREATE INDEX `conversation_store_time_idx` ON `conversation` (`organization_id`,`store_id`,`last_message_at`,`id`);--> statement-breakpoint
CREATE TABLE `ingest_event` (
	`id` text PRIMARY KEY NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text NOT NULL,
	`state` text NOT NULL,
	`live_observed_at` integer,
	`trace_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`,`organization_id`,`store_id`,`conversation_id`) REFERENCES `message`(`id`,`organization_id`,`store_id`,`conversation_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ingest_event_state_valid" CHECK("ingest_event"."state" IN ('pending','historical','observed')),
	CONSTRAINT "ingest_event_version_valid" CHECK("ingest_event"."schema_version"=1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ingest_event_message_unique` ON `ingest_event` (`message_id`);--> statement-breakpoint
CREATE INDEX `ingest_event_pending_idx` ON `ingest_event` (`state`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `message` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`platform_message_id` text NOT NULL,
	`sender_id` text,
	`sender_type` text NOT NULL,
	`direction` text NOT NULL,
	`content` text NOT NULL,
	`is_image` integer NOT NULL,
	`is_read` integer NOT NULL,
	`order_number` text,
	`sku` text,
	`event_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`ingest_mode` text NOT NULL,
	FOREIGN KEY (`conversation_id`,`organization_id`,`store_id`) REFERENCES `conversation`(`id`,`organization_id`,`store_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "message_content_json" CHECK(json_valid("message"."content") AND json_type("message"."content")='array'),
	CONSTRAINT "message_direction_valid" CHECK("message"."direction" IN ('inbound','outbound','unknown')),
	CONSTRAINT "message_mode_valid" CHECK("message"."ingest_mode" IN ('backfill','incremental'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_platform_unique` ON `message` (`store_id`,`conversation_id`,`platform_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_scope_unique` ON `message` (`id`,`organization_id`,`store_id`,`conversation_id`);--> statement-breakpoint
CREATE INDEX `message_conversation_time_idx` ON `message` (`organization_id`,`conversation_id`,`event_at`,`id`);--> statement-breakpoint
CREATE TABLE `store_sync` (
	`store_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`fence` integer DEFAULT 0 NOT NULL,
	`credential_version` integer,
	`lease_token` text,
	`lease_until` integer,
	`commit_token` text,
	`due_at` integer NOT NULL,
	`blocked_until` integer,
	`last_success_at` integer,
	`last_error` text,
	`failures` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`store_id`,`organization_id`) REFERENCES `store`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "store_sync_counters_valid" CHECK("store_sync"."epoch">=0 AND "store_sync"."fence">=0 AND "store_sync"."failures">=0),
	CONSTRAINT "store_sync_lease_complete" CHECK(("store_sync"."lease_token" IS NULL AND "store_sync"."lease_until" IS NULL) OR ("store_sync"."lease_token" IS NOT NULL AND "store_sync"."lease_until" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `store_sync_scope_unique` ON `store_sync` (`store_id`,`organization_id`);--> statement-breakpoint
CREATE INDEX `store_sync_due_idx` ON `store_sync` (`enabled`,`due_at`,`store_id`);--> statement-breakpoint
CREATE TABLE `sync_cursor` (
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`stream` text NOT NULL,
	`conversation_id` text,
	`cursor` text,
	`recent_cursors` text DEFAULT '[]' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`due_at` integer NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`store_id`, `stream`, `thread_id`),
	FOREIGN KEY (`store_id`,`organization_id`) REFERENCES `store_sync`(`store_id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`,`organization_id`,`store_id`) REFERENCES `conversation`(`id`,`organization_id`,`store_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sync_cursor_history_valid" CHECK(json_valid("sync_cursor"."recent_cursors") AND json_type("sync_cursor"."recent_cursors")='array' AND json_array_length("sync_cursor"."recent_cursors")<=8),
	CONSTRAINT "sync_cursor_revision_valid" CHECK("sync_cursor"."revision">=0),
	CONSTRAINT "sync_cursor_stream_valid" CHECK(("sync_cursor"."stream"='discovery' AND "sync_cursor"."thread_id"='' AND "sync_cursor"."conversation_id" IS NULL) OR ("sync_cursor"."stream" IN ('backfill','incremental') AND "sync_cursor"."thread_id"<>'' AND "sync_cursor"."conversation_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `sync_cursor_due_idx` ON `sync_cursor` (`store_id`,`completed`,`due_at`,`stream`,`thread_id`);--> statement-breakpoint
CREATE TRIGGER message_insert_immutable BEFORE INSERT ON message
WHEN EXISTS (
  SELECT 1 FROM message AS previous WHERE previous.store_id=NEW.store_id AND previous.conversation_id=NEW.conversation_id
    AND previous.platform_message_id=NEW.platform_message_id AND (
      previous.content IS NOT NEW.content OR previous.sender_id IS NOT NEW.sender_id OR previous.sender_type IS NOT NEW.sender_type
      OR previous.direction IS NOT NEW.direction OR previous.event_at IS NOT NEW.event_at OR previous.is_image IS NOT NEW.is_image)
)
BEGIN SELECT RAISE(ABORT,'MESSAGE_ID_CONFLICT'); END;
--> statement-breakpoint
CREATE TRIGGER store_sync_lifecycle AFTER UPDATE OF status,credential_version ON store
WHEN (NEW.status IN ('paused','disconnected') AND NEW.status IS NOT OLD.status) OR NEW.credential_version<>OLD.credential_version
BEGIN
  UPDATE store_sync SET enabled=0,epoch=epoch+1,lease_token=NULL,lease_until=NULL,commit_token=NULL,
    updated_at=CAST(unixepoch('subsecond') * 1000 AS INTEGER)
  WHERE store_id=NEW.id AND organization_id=NEW.organization_id;
END;
--> statement-breakpoint
CREATE TRIGGER message_update_immutable BEFORE UPDATE ON message
WHEN OLD.id IS NOT NEW.id OR OLD.organization_id IS NOT NEW.organization_id OR OLD.store_id IS NOT NEW.store_id
  OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.platform_message_id IS NOT NEW.platform_message_id
  OR OLD.content IS NOT NEW.content OR OLD.sender_id IS NOT NEW.sender_id OR OLD.sender_type IS NOT NEW.sender_type
  OR OLD.direction IS NOT NEW.direction OR OLD.event_at IS NOT NEW.event_at OR OLD.is_image IS NOT NEW.is_image
  OR OLD.ingest_mode IS NOT NEW.ingest_mode OR OLD.received_at IS NOT NEW.received_at
BEGIN SELECT RAISE(ABORT,'MESSAGE_IMMUTABLE'); END;
