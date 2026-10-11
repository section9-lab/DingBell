CREATE TABLE `conversation_control` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`controller_id` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`control_epoch` integer DEFAULT 0 NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	`lifecycle` text DEFAULT 'open' NOT NULL,
	`reception` text DEFAULT 'paused' NOT NULL,
	`assigned_member_id` text,
	`updated_at` integer DEFAULT 0 NOT NULL,
	`repair_due_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`,`organization_id`,`store_id`) REFERENCES `conversation`(`id`,`organization_id`,`store_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_control_schema_valid" CHECK("conversation_control"."schema_version"=1),
	CONSTRAINT "conversation_control_counters_valid" CHECK("conversation_control"."version" BETWEEN 0 AND 9007199254740991 AND "conversation_control"."control_epoch" BETWEEN 0 AND 9007199254740991 AND "conversation_control"."sequence" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "conversation_control_state_valid" CHECK("conversation_control"."lifecycle" IN ('open','resolved') AND "conversation_control"."reception" IN ('paused','human')),
	CONSTRAINT "conversation_control_time_valid" CHECK("conversation_control"."updated_at" BETWEEN 0 AND 8640000000000000 AND "conversation_control"."repair_due_at" BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_control_id_unique` ON `conversation_control` (`controller_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_control_scope_unique` ON `conversation_control` (`controller_id`,`organization_id`,`store_id`,`conversation_id`);--> statement-breakpoint
CREATE INDEX `conversation_control_repair_idx` ON `conversation_control` (`repair_due_at`,`controller_id`);--> statement-breakpoint
CREATE TABLE `conversation_control_event` (
	`controller_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`command_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_member_id` text NOT NULL,
	`action` text NOT NULL,
	`receipt` text NOT NULL,
	`projected_at` integer NOT NULL,
	PRIMARY KEY(`controller_id`, `sequence`),
	FOREIGN KEY (`controller_id`,`organization_id`,`store_id`,`conversation_id`) REFERENCES `conversation_control`(`controller_id`,`organization_id`,`store_id`,`conversation_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_control_event_sequence_valid" CHECK("conversation_control_event"."sequence" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "conversation_control_event_action_valid" CHECK("conversation_control_event"."action" IN ('claim','takeover','resolve')),
	CONSTRAINT "conversation_control_event_receipt_valid" CHECK(json_valid("conversation_control_event"."receipt") AND json_type("conversation_control_event"."receipt")='object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_control_command_unique` ON `conversation_control_event` (`controller_id`,`command_id`);
--> statement-breakpoint
CREATE TRIGGER conversation_control_event_insert_guard BEFORE INSERT ON conversation_control_event
BEGIN
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM conversation_control
    WHERE controller_id=NEW.controller_id AND organization_id=NEW.organization_id AND store_id=NEW.store_id AND conversation_id=NEW.conversation_id)
    THEN RAISE(ABORT,'CONTROL_SCOPE_MISMATCH') END);
  SELECT (CASE WHEN EXISTS (SELECT 1 FROM conversation_control_event
    WHERE controller_id=NEW.controller_id AND (sequence=NEW.sequence OR command_id=NEW.command_id)
      AND receipt<>NEW.receipt)
    THEN RAISE(ABORT,'CONTROL_EVENT_CONFLICT') END);
END;
--> statement-breakpoint
CREATE TRIGGER conversation_control_event_immutable BEFORE UPDATE ON conversation_control_event
BEGIN SELECT RAISE(ABORT,'CONTROL_EVENT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER conversation_control_scope_immutable BEFORE UPDATE ON conversation_control
WHEN NEW.controller_id<>OLD.controller_id OR NEW.organization_id<>OLD.organization_id
  OR NEW.store_id<>OLD.store_id OR NEW.conversation_id<>OLD.conversation_id
BEGIN SELECT RAISE(ABORT,'CONTROL_SCOPE_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER conversation_control_state_monotonic BEFORE UPDATE ON conversation_control
WHEN NEW.sequence<OLD.sequence OR NEW.version<OLD.version OR NEW.control_epoch<OLD.control_epoch
BEGIN SELECT RAISE(ABORT,'CONTROL_STATE_REGRESSION'); END;
