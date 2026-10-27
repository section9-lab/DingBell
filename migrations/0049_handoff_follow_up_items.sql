CREATE TABLE `handoff_follow_up_item_event` (
	`controller_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`source_sequence` integer NOT NULL,
	`item_index` integer NOT NULL,
	`revision` integer NOT NULL,
	`command_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_member_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`status` text NOT NULL,
	`evidence_message_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`controller_id`, `run_id`, `item_index`, `revision`),
	FOREIGN KEY (`controller_id`,`organization_id`,`store_id`,`conversation_id`) REFERENCES `conversation_control`(`controller_id`,`organization_id`,`store_id`,`conversation_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidence_message_id`,`organization_id`,`store_id`,`conversation_id`) REFERENCES `message`(`id`,`organization_id`,`store_id`,`conversation_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "handoff_follow_up_item_identity_valid" CHECK(length("handoff_follow_up_item_event"."run_id") BETWEEN 1 AND 256 AND length("handoff_follow_up_item_event"."command_id") BETWEEN 1 AND 256 AND length("handoff_follow_up_item_event"."actor_user_id") BETWEEN 1 AND 256 AND length("handoff_follow_up_item_event"."actor_member_id") BETWEEN 1 AND 256 AND length("handoff_follow_up_item_event"."actor_name")<=1000),
	CONSTRAINT "handoff_follow_up_item_position_valid" CHECK(typeof("handoff_follow_up_item_event"."source_sequence")='integer' AND "handoff_follow_up_item_event"."source_sequence" BETWEEN 1 AND 9007199254740991 AND typeof("handoff_follow_up_item_event"."item_index")='integer' AND "handoff_follow_up_item_event"."item_index" BETWEEN 0 AND 7 AND typeof("handoff_follow_up_item_event"."revision")='integer' AND "handoff_follow_up_item_event"."revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "handoff_follow_up_item_status_valid" CHECK(("handoff_follow_up_item_event"."status"='evidence_linked' AND "handoff_follow_up_item_event"."evidence_message_id" IS NOT NULL) OR ("handoff_follow_up_item_event"."status" IN ('pending','not_required','unavailable') AND "handoff_follow_up_item_event"."evidence_message_id" IS NULL)),
	CONSTRAINT "handoff_follow_up_item_time_valid" CHECK(typeof("handoff_follow_up_item_event"."created_at")='integer' AND "handoff_follow_up_item_event"."created_at" BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `handoff_follow_up_item_command_unique` ON `handoff_follow_up_item_event` (`controller_id`,`command_id`);--> statement-breakpoint
CREATE INDEX `handoff_follow_up_item_run_idx` ON `handoff_follow_up_item_event` (`controller_id`,`run_id`,`item_index`,`revision`);--> statement-breakpoint
CREATE TRIGGER handoff_follow_up_item_guard BEFORE INSERT ON handoff_follow_up_item_event
BEGIN
 SELECT (CASE WHEN NOT EXISTS (
  SELECT 1 FROM conversation_control_event AS source
  JOIN conversation_control AS control ON control.controller_id=source.controller_id AND control.organization_id=source.organization_id AND control.store_id=source.store_id AND control.conversation_id=source.conversation_id
  JOIN member AS actor ON actor.id=NEW.actor_member_id AND actor.organization_id=source.organization_id AND actor.user_id=NEW.actor_user_id
  JOIN user AS person ON person.id=actor.user_id AND person.email_verified=1 AND person.name=NEW.actor_name
  WHERE source.controller_id=NEW.controller_id AND source.organization_id=NEW.organization_id AND source.store_id=NEW.store_id AND source.conversation_id=NEW.conversation_id
   AND source.sequence=NEW.source_sequence AND source.action='request_handoff' AND json_extract(source.receipt,'$.run.request.runId')=NEW.run_id AND json_extract(source.receipt,'$.input.schemaVersion')=2
   AND NEW.item_index<json_array_length(source.receipt,'$.input.neededInformation') AND control.lifecycle='open' AND control.reception<>'ai'
   AND NEW.revision=COALESCE((SELECT MAX(previous.revision)+1 FROM handoff_follow_up_item_event AS previous WHERE previous.controller_id=NEW.controller_id AND previous.run_id=NEW.run_id AND previous.item_index=NEW.item_index),1)
   AND (actor.role IN ('owner','admin') OR (actor.role='member' AND EXISTS (SELECT 1 FROM store_grant AS permission WHERE permission.organization_id=source.organization_id AND permission.store_id=source.store_id AND permission.member_id=actor.id)))
   AND NOT EXISTS (SELECT 1 FROM conversation_control_event AS newer WHERE newer.controller_id=source.controller_id AND newer.sequence>source.sequence AND newer.action IN ('ai_start','ai_resume','ai_listen','ai_intake_start'))
   AND (NEW.status<>'evidence_linked' OR EXISTS (SELECT 1 FROM message AS evidence JOIN message_append AS appended ON appended.message_id=evidence.id AND appended.organization_id=evidence.organization_id AND appended.store_id=evidence.store_id AND appended.conversation_id=evidence.conversation_id
    WHERE evidence.id=NEW.evidence_message_id AND evidence.organization_id=source.organization_id AND evidence.store_id=source.store_id AND evidence.conversation_id=source.conversation_id
     AND evidence.direction='inbound' AND evidence.sender_type='Customer' AND appended.sequence>json_extract(source.receipt,'$.run.admission.inputRevision')))
 ) THEN RAISE(ABORT,'INVALID_HANDOFF_ITEM_EVENT') END);
END;--> statement-breakpoint
CREATE TRIGGER handoff_follow_up_item_immutable BEFORE UPDATE ON handoff_follow_up_item_event
BEGIN SELECT RAISE(ABORT,'HANDOFF_ITEM_EVENT_IMMUTABLE'); END;