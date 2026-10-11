CREATE TABLE `fbs_posting` (
	`posting_number` text NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`order_id` text NOT NULL,
	`order_number` text NOT NULL,
	`list_facts` text,
	`list_observed_at` integer,
	`detail_facts` text,
	`detail_observed_at` integer,
	`detail_epoch` integer NOT NULL,
	`detail_generation` integer NOT NULL,
	`detail_revision` integer DEFAULT 0 NOT NULL,
	`detail_state` text DEFAULT 'pending' NOT NULL,
	`detail_attempt` integer DEFAULT 0 NOT NULL,
	`detail_due_at` integer NOT NULL,
	`detail_error` text,
	PRIMARY KEY(`store_id`, `posting_number`),
	FOREIGN KEY (`store_id`,`organization_id`) REFERENCES `store`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "fbs_posting_list_json" CHECK("fbs_posting"."list_facts" IS NULL OR (json_valid("fbs_posting"."list_facts") AND json_type("fbs_posting"."list_facts")='object')),
	CONSTRAINT "fbs_posting_detail_json" CHECK("fbs_posting"."detail_facts" IS NULL OR (json_valid("fbs_posting"."detail_facts") AND json_type("fbs_posting"."detail_facts")='object')),
	CONSTRAINT "fbs_posting_detail_state_valid" CHECK("fbs_posting"."detail_state" IN ('pending','complete','error')),
	CONSTRAINT "fbs_posting_detail_counters_valid" CHECK("fbs_posting"."detail_epoch">0 AND "fbs_posting"."detail_generation">0 AND "fbs_posting"."detail_revision">=0 AND "fbs_posting"."detail_attempt" BETWEEN 0 AND 3)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fbs_posting_scope_unique` ON `fbs_posting` (`store_id`,`organization_id`,`posting_number`);
--> statement-breakpoint
CREATE INDEX `fbs_posting_detail_due_idx` ON `fbs_posting` (`store_id`,`detail_epoch`,`detail_state`,`detail_due_at`,`posting_number`);
--> statement-breakpoint
CREATE INDEX `fbs_posting_order_idx` ON `fbs_posting` (`organization_id`,`store_id`,`order_id`);
--> statement-breakpoint
CREATE TABLE `fbs_posting_observation` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`posting_number` text NOT NULL,
	`source` text NOT NULL,
	`facts` text NOT NULL,
	`observed_at` integer NOT NULL,
	`source_updated_at` integer,
	FOREIGN KEY (`store_id`,`organization_id`,`posting_number`) REFERENCES `fbs_posting`(`store_id`,`organization_id`,`posting_number`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "fbs_observation_source_valid" CHECK("fbs_posting_observation"."source" IN ('list','details')),
	CONSTRAINT "fbs_observation_facts_json" CHECK(json_valid("fbs_posting_observation"."facts") AND json_type("fbs_posting_observation"."facts")='object'),
	CONSTRAINT "fbs_observation_source_time_unknown" CHECK("fbs_posting_observation"."source_updated_at" IS NULL)
);
--> statement-breakpoint
CREATE INDEX `fbs_observation_history_idx` ON `fbs_posting_observation` (`organization_id`,`store_id`,`posting_number`,`source`,`observed_at`,`id`);
--> statement-breakpoint
CREATE TABLE `fbs_sync_window` (
	`store_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`history_start` integer NOT NULL,
	`since` integer NOT NULL,
	`to` integer NOT NULL,
	`cursor` text,
	`recent_cursors` text DEFAULT '[]' NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`due_at` integer NOT NULL,
	`last_kind` text DEFAULT 'details' NOT NULL,
	`last_completed_to` integer,
	FOREIGN KEY (`store_id`,`organization_id`) REFERENCES `store`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "fbs_window_counters_valid" CHECK("fbs_sync_window"."epoch">0 AND "fbs_sync_window"."generation">0 AND "fbs_sync_window"."revision">=0),
	CONSTRAINT "fbs_window_bounds_valid" CHECK("fbs_sync_window"."to">"fbs_sync_window"."since" AND "fbs_sync_window"."to"-"fbs_sync_window"."since"<=2678400000 AND "fbs_sync_window"."history_start"<="fbs_sync_window"."since"),
	CONSTRAINT "fbs_window_state_valid" CHECK("fbs_sync_window"."state" IN ('active','waiting') AND "fbs_sync_window"."last_kind" IN ('list','details')),
	CONSTRAINT "fbs_window_history_valid" CHECK(json_valid("fbs_sync_window"."recent_cursors") AND json_type("fbs_sync_window"."recent_cursors")='array' AND json_array_length("fbs_sync_window"."recent_cursors")<=8)
);
--> statement-breakpoint
-- Rebuild the parent chain with foreign keys enabled. Each shadow child refers to its shadow parent.
CREATE TABLE `__new_store_coordinator` (
	`store_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`fence` integer DEFAULT 0 NOT NULL,
	`lease_source` text,
	`lease_token` text,
	`lease_until` integer,
	`commit_token` text,
	`blocked_until` integer,
	FOREIGN KEY (`store_id`,`organization_id`) REFERENCES `store`(`id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "store_coordinator_fence_valid" CHECK("__new_store_coordinator"."fence">=0),
	CONSTRAINT "store_coordinator_lease_complete" CHECK(("__new_store_coordinator"."lease_source" IS NULL AND "__new_store_coordinator"."lease_token" IS NULL AND "__new_store_coordinator"."lease_until" IS NULL)
    OR ("__new_store_coordinator"."lease_source" IS NOT NULL AND "__new_store_coordinator"."lease_source" IN ('chat','products','fbs_postings') AND "__new_store_coordinator"."lease_token" IS NOT NULL AND "__new_store_coordinator"."lease_until" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX __new_store_coordinator_scope_unique ON __new_store_coordinator(store_id,organization_id);
--> statement-breakpoint
INSERT INTO __new_store_coordinator (store_id,organization_id,fence,blocked_until) SELECT store_id,organization_id,fence+1,blocked_until FROM store_coordinator;
--> statement-breakpoint
CREATE TABLE `__new_store_sync_source` (
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
	FOREIGN KEY (`store_id`,`organization_id`) REFERENCES `__new_store_coordinator`(`store_id`,`organization_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "store_sync_source_valid" CHECK("__new_store_sync_source"."source" IN ('chat','products','fbs_postings')),
	CONSTRAINT "store_sync_source_counters_valid" CHECK("__new_store_sync_source"."epoch">=0 AND "__new_store_sync_source"."failures">=0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX __new_store_sync_source_scope_unique ON __new_store_sync_source(store_id,organization_id,source);
--> statement-breakpoint
INSERT INTO `__new_store_sync_source`("store_id", "organization_id", "source", "enabled", "epoch", "credential_version", "due_at", "last_success_at", "last_error", "failures", "last_attempt_at", "updated_at") SELECT "store_id", "organization_id", "source", "enabled", "epoch", "credential_version", "due_at", "last_success_at", "last_error", "failures", "last_attempt_at", "updated_at" FROM `store_sync_source`;
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
	FOREIGN KEY (`store_id`,`organization_id`,`source`) REFERENCES `__new_store_sync_source`(`store_id`,`organization_id`,`source`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`,`organization_id`,`store_id`) REFERENCES `conversation`(`id`,`organization_id`,`store_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sync_cursor_source_valid" CHECK("__new_sync_cursor"."source"='chat'),
	CONSTRAINT "sync_cursor_history_valid" CHECK(json_valid("__new_sync_cursor"."recent_cursors") AND json_type("__new_sync_cursor"."recent_cursors")='array' AND json_array_length("__new_sync_cursor"."recent_cursors")<=8),
	CONSTRAINT "sync_cursor_revision_valid" CHECK("__new_sync_cursor"."revision">=0),
	CONSTRAINT "sync_cursor_stream_valid" CHECK(("__new_sync_cursor"."stream"='discovery' AND "__new_sync_cursor"."thread_id"='' AND "__new_sync_cursor"."conversation_id" IS NULL) OR ("__new_sync_cursor"."stream" IN ('backfill','incremental') AND "__new_sync_cursor"."thread_id"<>'' AND "__new_sync_cursor"."conversation_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO __new_sync_cursor SELECT * FROM sync_cursor;
--> statement-breakpoint
DROP TRIGGER store_sync_lifecycle;
--> statement-breakpoint
-- Remove the old chain from leaf to root only after every row has been copied.
DROP TABLE sync_cursor;
--> statement-breakpoint
DROP TABLE store_sync_source;
--> statement-breakpoint
DROP TABLE store_coordinator;
--> statement-breakpoint
ALTER TABLE __new_store_coordinator RENAME TO store_coordinator;
--> statement-breakpoint
ALTER TABLE __new_store_sync_source RENAME TO store_sync_source;
--> statement-breakpoint
ALTER TABLE __new_sync_cursor RENAME TO sync_cursor;
--> statement-breakpoint
CREATE UNIQUE INDEX `store_coordinator_scope_unique` ON `store_coordinator` (`store_id`,`organization_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `store_sync_source_scope_unique` ON `store_sync_source` (`store_id`,`organization_id`,`source`);
--> statement-breakpoint
CREATE INDEX `store_sync_source_due_idx` ON `store_sync_source` (`enabled`,`due_at`,`store_id`);
--> statement-breakpoint
CREATE INDEX `sync_cursor_due_idx` ON `sync_cursor` (`store_id`,`completed`,`due_at`,`stream`,`thread_id`);
--> statement-breakpoint
DROP INDEX __new_store_coordinator_scope_unique;
--> statement-breakpoint
DROP INDEX __new_store_sync_source_scope_unique;
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
CREATE TRIGGER fbs_observation_immutable BEFORE UPDATE ON fbs_posting_observation
BEGIN SELECT RAISE(ABORT,'FBS_OBSERVATION_IMMUTABLE'); END;
