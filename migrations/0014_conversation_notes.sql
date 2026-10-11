CREATE TABLE `__new_conversation_control_event` (
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
	CONSTRAINT "conversation_control_event_sequence_valid" CHECK("__new_conversation_control_event"."sequence" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "conversation_control_event_action_valid" CHECK("__new_conversation_control_event"."action" IN ('claim','takeover','resolve','reopen','set_work_status','transfer','add_note')),
	CONSTRAINT "conversation_control_event_receipt_valid" CHECK(json_valid("__new_conversation_control_event"."receipt") AND json_type("__new_conversation_control_event"."receipt")='object')
);
--> statement-breakpoint
INSERT INTO `__new_conversation_control_event`("controller_id", "organization_id", "store_id", "conversation_id", "sequence", "command_id", "actor_user_id", "actor_member_id", "action", "receipt", "projected_at") SELECT "controller_id", "organization_id", "store_id", "conversation_id", "sequence", "command_id", "actor_user_id", "actor_member_id", "action", "receipt", "projected_at" FROM `conversation_control_event`;--> statement-breakpoint
DROP TABLE `conversation_control_event`;--> statement-breakpoint
ALTER TABLE `__new_conversation_control_event` RENAME TO `conversation_control_event`;--> statement-breakpoint
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
