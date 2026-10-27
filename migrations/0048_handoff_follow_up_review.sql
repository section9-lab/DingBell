CREATE TABLE `handoff_follow_up_review` (
	`controller_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`source_sequence` integer NOT NULL,
	`command_id` text NOT NULL,
	`reviewer_user_id` text NOT NULL,
	`reviewer_member_id` text NOT NULL,
	`reviewer_name` text NOT NULL,
	`reviewed_at` integer NOT NULL,
	PRIMARY KEY(`controller_id`, `run_id`),
	FOREIGN KEY (`controller_id`,`organization_id`,`store_id`,`conversation_id`) REFERENCES `conversation_control`(`controller_id`,`organization_id`,`store_id`,`conversation_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "handoff_follow_up_identity_valid" CHECK(length("handoff_follow_up_review"."run_id") BETWEEN 1 AND 256 AND length("handoff_follow_up_review"."command_id") BETWEEN 1 AND 256 AND length("handoff_follow_up_review"."reviewer_user_id") BETWEEN 1 AND 256 AND length("handoff_follow_up_review"."reviewer_member_id") BETWEEN 1 AND 256 AND length("handoff_follow_up_review"."reviewer_name")<=1000),
	CONSTRAINT "handoff_follow_up_sequence_valid" CHECK(typeof("handoff_follow_up_review"."source_sequence")='integer' AND "handoff_follow_up_review"."source_sequence" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "handoff_follow_up_time_valid" CHECK(typeof("handoff_follow_up_review"."reviewed_at")='integer' AND "handoff_follow_up_review"."reviewed_at" BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `handoff_follow_up_command_unique` ON `handoff_follow_up_review` (`controller_id`,`command_id`);--> statement-breakpoint
CREATE INDEX `handoff_follow_up_conversation_idx` ON `handoff_follow_up_review` (`organization_id`,`conversation_id`,`reviewed_at`,`run_id`);--> statement-breakpoint
CREATE TRIGGER handoff_follow_up_review_guard BEFORE INSERT ON handoff_follow_up_review
BEGIN
 SELECT (CASE WHEN NOT EXISTS (
  SELECT 1 FROM conversation_control_event AS source
  JOIN conversation_control AS control ON control.controller_id=source.controller_id AND control.organization_id=source.organization_id AND control.store_id=source.store_id AND control.conversation_id=source.conversation_id
  JOIN member AS reviewer ON reviewer.id=NEW.reviewer_member_id AND reviewer.organization_id=source.organization_id AND reviewer.user_id=NEW.reviewer_user_id
  JOIN user AS person ON person.id=reviewer.user_id AND person.email_verified=1 AND person.name=NEW.reviewer_name
  WHERE source.controller_id=NEW.controller_id AND source.organization_id=NEW.organization_id AND source.store_id=NEW.store_id AND source.conversation_id=NEW.conversation_id
   AND source.sequence=NEW.source_sequence AND source.action='request_handoff' AND json_extract(source.receipt,'$.run.request.runId')=NEW.run_id
   AND control.lifecycle='open' AND control.reception<>'ai'
   AND (reviewer.role IN ('owner','admin') OR (reviewer.role='member' AND EXISTS (SELECT 1 FROM store_grant AS permission WHERE permission.organization_id=source.organization_id AND permission.store_id=source.store_id AND permission.member_id=reviewer.id)))
   AND NOT EXISTS (SELECT 1 FROM conversation_control_event AS newer WHERE newer.controller_id=source.controller_id AND newer.sequence>source.sequence AND newer.action IN ('ai_start','ai_resume','ai_listen','ai_intake_start'))
 ) THEN RAISE(ABORT,'INVALID_HANDOFF_REVIEW') END);
END;--> statement-breakpoint
CREATE TRIGGER handoff_follow_up_review_immutable BEFORE UPDATE ON handoff_follow_up_review
BEGIN SELECT RAISE(ABORT,'HANDOFF_REVIEW_IMMUTABLE'); END;