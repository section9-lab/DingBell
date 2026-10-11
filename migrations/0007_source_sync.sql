CREATE TABLE `store_coordinator` (
	`store_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`fence` integer DEFAULT 0 NOT NULL,
	`lease_source` text,
	`lease_token` text,
	`lease_until` integer,
	`commit_token` text,
	`blocked_until` integer,
	FOREIGN KEY (`store_id`,`organization_id`) REFERENCES `store`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "store_coordinator_fence_valid" CHECK("store_coordinator"."fence">=0),
	CONSTRAINT "store_coordinator_lease_complete" CHECK(("store_coordinator"."lease_source" IS NULL AND "store_coordinator"."lease_token" IS NULL AND "store_coordinator"."lease_until" IS NULL)
    OR ("store_coordinator"."lease_source" IS NOT NULL AND "store_coordinator"."lease_source" IN ('chat','products') AND "store_coordinator"."lease_token" IS NOT NULL AND "store_coordinator"."lease_until" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `store_coordinator_scope_unique` ON `store_coordinator` (`store_id`,`organization_id`);--> statement-breakpoint
CREATE TABLE `store_sync_source` (
	`store_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`source` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`credential_version` integer,
	`due_at` integer NOT NULL,
	`last_success_at` integer,
	`last_error` text,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`store_id`, `source`),
	FOREIGN KEY (`store_id`,`organization_id`) REFERENCES `store_coordinator`(`store_id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "store_sync_source_valid" CHECK("store_sync_source"."source" IN ('chat','products')),
	CONSTRAINT "store_sync_source_counters_valid" CHECK("store_sync_source"."epoch">=0 AND "store_sync_source"."failures">=0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `store_sync_source_scope_unique` ON `store_sync_source` (`store_id`,`organization_id`,`source`);--> statement-breakpoint
CREATE INDEX `store_sync_source_due_idx` ON `store_sync_source` (`enabled`,`due_at`,`store_id`);--> statement-breakpoint
CREATE TABLE `product` (
	`id` text NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`listing` text NOT NULL,
	`list_observed_at` integer NOT NULL,
	`list_source_updated_at` integer,
	`facts` text,
	`facts_observed_at` integer,
	`facts_source_updated_at` integer,
	`detail_epoch` integer NOT NULL,
	`detail_generation` integer NOT NULL,
	`detail_revision` integer DEFAULT 0 NOT NULL,
	`detail_state` text DEFAULT 'pending' NOT NULL,
	`detail_attempt` integer DEFAULT 0 NOT NULL,
	`detail_due_at` integer NOT NULL,
	`detail_error` text,
	PRIMARY KEY(`store_id`, `id`),
	FOREIGN KEY (`store_id`,`organization_id`) REFERENCES `store`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_listing_json" CHECK(json_valid("product"."listing") AND json_type("product"."listing")='object'),
	CONSTRAINT "product_facts_json" CHECK("product"."facts" IS NULL OR (json_valid("product"."facts") AND json_type("product"."facts")='object')),
	CONSTRAINT "product_detail_state_valid" CHECK("product"."detail_state" IN ('pending','complete','error')),
	CONSTRAINT "product_detail_counters_valid" CHECK("product"."detail_epoch">0 AND "product"."detail_generation">0 AND "product"."detail_revision">=0 AND "product"."detail_attempt" BETWEEN 0 AND 3),
	CONSTRAINT "product_source_time_unknown" CHECK("product"."list_source_updated_at" IS NULL AND "product"."facts_source_updated_at" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_scope_unique` ON `product` (`store_id`,`organization_id`,`id`);--> statement-breakpoint
CREATE INDEX `product_detail_due_idx` ON `product` (`store_id`,`detail_epoch`,`detail_state`,`detail_due_at`,`id`);--> statement-breakpoint
CREATE TABLE `product_source_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`product_id` text NOT NULL,
	`facts` text NOT NULL,
	`observed_at` integer NOT NULL,
	`source_updated_at` integer,
	FOREIGN KEY (`store_id`,`organization_id`,`product_id`) REFERENCES `product`(`store_id`,`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_snapshot_facts_json" CHECK(json_valid("product_source_snapshot"."facts") AND json_type("product_source_snapshot"."facts")='object'),
	CONSTRAINT "product_snapshot_source_time_unknown" CHECK("product_source_snapshot"."source_updated_at" IS NULL)
);
--> statement-breakpoint
CREATE INDEX `product_snapshot_history_idx` ON `product_source_snapshot` (`organization_id`,`store_id`,`product_id`,`observed_at`,`id`);--> statement-breakpoint
CREATE TABLE `product_sync_cursor` (
	`store_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`cursor` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`recent_cursors` text DEFAULT '[]' NOT NULL,
	`due_at` integer NOT NULL,
	`last_kind` text DEFAULT 'details' NOT NULL,
	`last_completed_at` integer,
	FOREIGN KEY (`store_id`,`organization_id`) REFERENCES `store`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_cursor_counters_valid" CHECK("product_sync_cursor"."epoch">0 AND "product_sync_cursor"."generation">0 AND "product_sync_cursor"."revision">=0),
	CONSTRAINT "product_cursor_history_valid" CHECK(json_valid("product_sync_cursor"."recent_cursors") AND json_type("product_sync_cursor"."recent_cursors")='array' AND json_array_length("product_sync_cursor"."recent_cursors")<=8),
	CONSTRAINT "product_cursor_kind_valid" CHECK("product_sync_cursor"."last_kind" IN ('list','details'))
);
--> statement-breakpoint
INSERT INTO store_coordinator (store_id,organization_id,fence,blocked_until)
SELECT store_id,organization_id,fence+1,blocked_until FROM store_sync;
--> statement-breakpoint
INSERT INTO store_sync_source (store_id,organization_id,source,enabled,epoch,credential_version,due_at,last_success_at,last_error,failures,updated_at)
SELECT store_id,organization_id,'chat',enabled,epoch,credential_version,due_at,last_success_at,last_error,failures,updated_at FROM store_sync;
--> statement-breakpoint
CREATE TABLE `__new_sync_cursor` (
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`source` text DEFAULT 'chat' NOT NULL,
	`thread_id` text NOT NULL,
	`stream` text NOT NULL,
	`conversation_id` text,
	`cursor` text,
	`recent_cursors` text DEFAULT '[]' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`due_at` integer NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`store_id`, `stream`, `thread_id`),
	FOREIGN KEY (`store_id`,`organization_id`,`source`) REFERENCES `store_sync_source`(`store_id`,`organization_id`,`source`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`,`organization_id`,`store_id`) REFERENCES `conversation`(`id`,`organization_id`,`store_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sync_cursor_source_valid" CHECK("__new_sync_cursor"."source"='chat'),
	CONSTRAINT "sync_cursor_history_valid" CHECK(json_valid("__new_sync_cursor"."recent_cursors") AND json_type("__new_sync_cursor"."recent_cursors")='array' AND json_array_length("__new_sync_cursor"."recent_cursors")<=8),
	CONSTRAINT "sync_cursor_revision_valid" CHECK("__new_sync_cursor"."revision">=0),
	CONSTRAINT "sync_cursor_stream_valid" CHECK(("__new_sync_cursor"."stream"='discovery' AND "__new_sync_cursor"."thread_id"='' AND "__new_sync_cursor"."conversation_id" IS NULL) OR ("__new_sync_cursor"."stream" IN ('backfill','incremental') AND "__new_sync_cursor"."thread_id"<>'' AND "__new_sync_cursor"."conversation_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_sync_cursor`("organization_id", "store_id", "source", "thread_id", "stream", "conversation_id", "cursor", "recent_cursors", "revision", "due_at", "completed") SELECT "organization_id", "store_id", 'chat', "thread_id", "stream", "conversation_id", "cursor", "recent_cursors", "revision", "due_at", "completed" FROM `sync_cursor`;--> statement-breakpoint
DROP TABLE `sync_cursor`;--> statement-breakpoint
ALTER TABLE `__new_sync_cursor` RENAME TO `sync_cursor`;--> statement-breakpoint
CREATE INDEX `sync_cursor_due_idx` ON `sync_cursor` (`store_id`,`completed`,`due_at`,`stream`,`thread_id`);
--> statement-breakpoint
DROP TRIGGER store_sync_lifecycle;
--> statement-breakpoint
DROP TABLE store_sync;
--> statement-breakpoint
CREATE TRIGGER store_sync_lifecycle AFTER UPDATE OF status,credential_version ON store
WHEN (NEW.status IN ('paused','disconnected') AND NEW.status IS NOT OLD.status) OR NEW.credential_version<>OLD.credential_version
BEGIN
  UPDATE store_sync_source SET enabled=0,epoch=epoch+1,updated_at=CAST(unixepoch('subsecond') * 1000 AS INTEGER)
    WHERE store_id=NEW.id AND organization_id=NEW.organization_id;
  UPDATE store_coordinator SET fence=fence+1,lease_source=NULL,lease_token=NULL,lease_until=NULL,commit_token=NULL
    WHERE store_id=NEW.id AND organization_id=NEW.organization_id;
END;
--> statement-breakpoint
CREATE TRIGGER product_snapshot_immutable BEFORE UPDATE ON product_source_snapshot
BEGIN SELECT RAISE(ABORT,'PRODUCT_SNAPSHOT_IMMUTABLE'); END;
