-- Preserve all dependent data with foreign keys enabled; do not use PRAGMA foreign_keys=OFF.
CREATE TABLE __saved_ai_conversation_control AS SELECT * FROM conversation_control;
--> statement-breakpoint
CREATE TABLE __saved_ai_conversation_control_event AS SELECT * FROM conversation_control_event;
--> statement-breakpoint
CREATE TABLE __saved_ai_send_intent AS SELECT * FROM send_intent;
--> statement-breakpoint
CREATE TABLE __saved_ai_send_attempt AS SELECT * FROM send_attempt;
--> statement-breakpoint
DROP TRIGGER "conversation_control_scope_immutable";
--> statement-breakpoint
DROP TRIGGER "conversation_control_state_monotonic";
--> statement-breakpoint
DROP TRIGGER "conversation_control_event_insert_guard";
--> statement-breakpoint
DROP TRIGGER "conversation_control_event_immutable";
--> statement-breakpoint
DROP TRIGGER "send_intent_insert_guard";
--> statement-breakpoint
DROP TRIGGER "send_intent_update_guard";
--> statement-breakpoint
DROP TRIGGER "send_attempt_insert_guard";
--> statement-breakpoint
DROP TRIGGER "send_attempt_update_guard";
--> statement-breakpoint
DROP TABLE conversation_control_event;
--> statement-breakpoint
DROP TABLE conversation_control;
--> statement-breakpoint
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
	`work_status` text,
	`assigned_member_id` text,
	`updated_at` integer DEFAULT 0 NOT NULL,
	`repair_due_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`,`organization_id`,`store_id`) REFERENCES `conversation`(`id`,`organization_id`,`store_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_control_schema_valid" CHECK("conversation_control"."schema_version" IN (1,2)),
	CONSTRAINT "conversation_control_work_status_valid" CHECK(("conversation_control"."schema_version"=1 AND "conversation_control"."work_status" IS NULL) OR ("conversation_control"."schema_version"=2 AND (("conversation_control"."lifecycle"='resolved' AND "conversation_control"."work_status" IS NULL) OR ("conversation_control"."lifecycle"='open' AND "conversation_control"."work_status" IS NOT NULL AND "conversation_control"."work_status" IN ('needs_reply','waiting_customer','waiting_internal'))))),
	CONSTRAINT "conversation_control_counters_valid" CHECK("conversation_control"."version" BETWEEN 0 AND 9007199254740991 AND "conversation_control"."control_epoch" BETWEEN 0 AND 9007199254740991 AND "conversation_control"."sequence" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "conversation_control_state_valid" CHECK("conversation_control"."lifecycle" IN ('open','resolved') AND "conversation_control"."reception" IN ('paused','human','ai') AND ("conversation_control"."reception"<>'ai' OR ("conversation_control"."schema_version"=2 AND "conversation_control"."lifecycle"='open' AND "conversation_control"."work_status"='needs_reply' AND "conversation_control"."assigned_member_id" IS NULL))),
	CONSTRAINT "conversation_control_time_valid" CHECK("conversation_control"."updated_at" BETWEEN 0 AND 8640000000000000 AND "conversation_control"."repair_due_at" BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_control_id_unique` ON `conversation_control` (`controller_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_control_scope_unique` ON `conversation_control` (`controller_id`,`organization_id`,`store_id`,`conversation_id`);
--> statement-breakpoint
CREATE INDEX `conversation_control_repair_idx` ON `conversation_control` (`repair_due_at`,`controller_id`);
--> statement-breakpoint
INSERT INTO conversation_control("conversation_id","organization_id","store_id","controller_id","schema_version","version","control_epoch","sequence","lifecycle","reception","work_status","assigned_member_id","updated_at","repair_due_at") SELECT "conversation_id","organization_id","store_id","controller_id","schema_version","version","control_epoch","sequence","lifecycle","reception","work_status","assigned_member_id","updated_at","repair_due_at" FROM __saved_ai_conversation_control;
--> statement-breakpoint
CREATE TABLE `conversation_control_event` (
	`controller_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`command_id` text NOT NULL,
	`actor_user_id` text,
	`actor_member_id` text,
	`action` text NOT NULL,
	`receipt` text NOT NULL,
	`projected_at` integer NOT NULL,
	PRIMARY KEY(`controller_id`, `sequence`),
	FOREIGN KEY (`controller_id`,`organization_id`,`store_id`,`conversation_id`) REFERENCES `conversation_control`(`controller_id`,`organization_id`,`store_id`,`conversation_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_control_event_sequence_valid" CHECK("conversation_control_event"."sequence" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "conversation_control_event_action_valid" CHECK("conversation_control_event"."action" IN ('claim','takeover','resolve','reopen','set_work_status','transfer','add_note','send_reply','cancel_reply','ai_start','request_handoff')),
	CONSTRAINT "conversation_control_event_actor_valid" CHECK(("conversation_control_event"."action" IN ('ai_start','request_handoff') AND "conversation_control_event"."actor_user_id" IS NULL AND "conversation_control_event"."actor_member_id" IS NULL) OR ("conversation_control_event"."action" NOT IN ('ai_start','request_handoff') AND "conversation_control_event"."actor_user_id" IS NOT NULL AND "conversation_control_event"."actor_member_id" IS NOT NULL)),
	CONSTRAINT "conversation_control_event_receipt_valid" CHECK(json_valid("conversation_control_event"."receipt") AND json_type("conversation_control_event"."receipt")='object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_control_command_unique` ON `conversation_control_event` (`controller_id`,`command_id`);
--> statement-breakpoint
INSERT INTO conversation_control_event("controller_id","organization_id","store_id","conversation_id","sequence","command_id","actor_user_id","actor_member_id","action","receipt","projected_at") SELECT "controller_id","organization_id","store_id","conversation_id","sequence","command_id","actor_user_id","actor_member_id","action","receipt","projected_at" FROM __saved_ai_conversation_control_event;
--> statement-breakpoint
INSERT INTO send_intent SELECT * FROM __saved_ai_send_intent;
--> statement-breakpoint
INSERT INTO send_attempt SELECT * FROM __saved_ai_send_attempt;
--> statement-breakpoint
CREATE TRIGGER conversation_control_scope_immutable BEFORE UPDATE ON conversation_control
WHEN NEW.controller_id<>OLD.controller_id OR NEW.organization_id<>OLD.organization_id
  OR NEW.store_id<>OLD.store_id OR NEW.conversation_id<>OLD.conversation_id
BEGIN SELECT RAISE(ABORT,'CONTROL_SCOPE_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER conversation_control_state_monotonic BEFORE UPDATE ON conversation_control
WHEN NEW.sequence<OLD.sequence OR NEW.version<OLD.version OR NEW.control_epoch<OLD.control_epoch
BEGIN SELECT RAISE(ABORT,'CONTROL_STATE_REGRESSION'); END;
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
CREATE TRIGGER send_intent_insert_guard BEFORE INSERT ON send_intent
BEGIN
  SELECT (CASE WHEN NEW.state='canceled' AND (EXISTS (SELECT 1 FROM send_intent AS saved WHERE saved.controller_id=NEW.controller_id AND saved.id=NEW.id AND NEW.revision>saved.revision AND saved.state NOT IN ('queued','canceled')) OR EXISTS (SELECT 1 FROM send_attempt WHERE controller_id=NEW.controller_id AND intent_id=NEW.id))
    THEN RAISE(ABORT,'REPLY_CANCELLATION_CONFLICT') END);
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM conversation_control WHERE controller_id=NEW.controller_id AND organization_id=NEW.organization_id AND store_id=NEW.store_id AND conversation_id=NEW.conversation_id)
    THEN RAISE(ABORT,'REPLY_SCOPE_MISMATCH') END);
  SELECT (CASE WHEN EXISTS (SELECT 1 FROM send_intent AS saved WHERE saved.controller_id=NEW.controller_id AND saved.id=NEW.id
    AND ((saved.organization_id IS NOT NEW.organization_id OR saved.store_id IS NOT NEW.store_id OR saved.conversation_id IS NOT NEW.conversation_id OR saved.schema_version IS NOT NEW.schema_version OR saved.command_id IS NOT NEW.command_id OR saved.actor_user_id IS NOT NEW.actor_user_id OR saved.actor_member_id IS NOT NEW.actor_member_id OR saved.body IS NOT NEW.body OR saved.body_hash IS NOT NEW.body_hash OR saved.platform_thread_id IS NOT NEW.platform_thread_id OR saved.credential_version IS NOT NEW.credential_version OR saved.control_epoch IS NOT NEW.control_epoch OR saved.created_at IS NOT NEW.created_at) OR (saved.revision=NEW.revision AND (saved.state IS NOT NEW.state OR saved.updated_at IS NOT NEW.updated_at OR saved.due_at IS NOT NEW.due_at OR saved.last_error IS NOT NEW.last_error)) OR (NEW.revision>saved.revision AND (NEW.updated_at<saved.updated_at OR (saved.state IN ('sent','failed','unknown','skipped','canceled') AND NEW.state<>saved.state)))))
    THEN RAISE(ABORT,'REPLY_PROJECTION_CONFLICT') END);
END;
--> statement-breakpoint
CREATE TRIGGER send_intent_update_guard BEFORE UPDATE ON send_intent
BEGIN
  SELECT (CASE WHEN NEW.state='canceled' AND (OLD.state NOT IN ('queued','canceled') OR EXISTS (SELECT 1 FROM send_attempt WHERE controller_id=NEW.controller_id AND intent_id=NEW.id))
    THEN RAISE(ABORT,'REPLY_CANCELLATION_CONFLICT') END);
  SELECT (CASE WHEN NEW.controller_id<>OLD.controller_id OR NEW.id<>OLD.id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.store_id IS NOT OLD.store_id OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.schema_version IS NOT OLD.schema_version OR NEW.command_id IS NOT OLD.command_id OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.actor_member_id IS NOT OLD.actor_member_id OR NEW.body IS NOT OLD.body OR NEW.body_hash IS NOT OLD.body_hash OR NEW.platform_thread_id IS NOT OLD.platform_thread_id OR NEW.credential_version IS NOT OLD.credential_version OR NEW.control_epoch IS NOT OLD.control_epoch OR NEW.created_at IS NOT OLD.created_at OR NEW.revision<=OLD.revision OR NEW.updated_at<OLD.updated_at
    OR (OLD.state IN ('sent','failed','unknown','skipped','canceled') AND NEW.state<>OLD.state)
    THEN RAISE(ABORT,'REPLY_PROJECTION_CONFLICT') END);
END;
--> statement-breakpoint
CREATE TRIGGER send_attempt_insert_guard BEFORE INSERT ON send_attempt
BEGIN
  SELECT (CASE WHEN EXISTS (SELECT 1 FROM send_intent WHERE controller_id=NEW.controller_id AND id=NEW.intent_id AND state='canceled')
    THEN RAISE(ABORT,'REPLY_CANCELLATION_CONFLICT') END);
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM send_intent WHERE controller_id=NEW.controller_id AND id=NEW.intent_id AND organization_id=NEW.organization_id AND store_id=NEW.store_id AND conversation_id=NEW.conversation_id AND revision>=NEW.revision)
    THEN RAISE(ABORT,'REPLY_SCOPE_MISMATCH') END);
  SELECT (CASE WHEN EXISTS (SELECT 1 FROM send_attempt AS saved WHERE saved.controller_id=NEW.controller_id AND saved.id=NEW.id
    AND ((saved.organization_id IS NOT NEW.organization_id OR saved.store_id IS NOT NEW.store_id OR saved.conversation_id IS NOT NEW.conversation_id OR saved.intent_id IS NOT NEW.intent_id OR saved.started_at IS NOT NEW.started_at OR saved.deadline_at IS NOT NEW.deadline_at) OR (saved.revision=NEW.revision AND (saved.state IS NOT NEW.state OR saved.finished_at IS NOT NEW.finished_at OR saved.http_status IS NOT NEW.http_status OR saved.provider_result IS NOT NEW.provider_result OR saved.error_code IS NOT NEW.error_code)) OR (NEW.revision>saved.revision AND saved.state IN ('sent','failed','unknown') AND NEW.state<>saved.state)))
    THEN RAISE(ABORT,'REPLY_PROJECTION_CONFLICT') END);
END;
--> statement-breakpoint
CREATE TRIGGER send_attempt_update_guard BEFORE UPDATE ON send_attempt
BEGIN
  SELECT (CASE WHEN NEW.controller_id<>OLD.controller_id OR NEW.id<>OLD.id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.store_id IS NOT OLD.store_id OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.intent_id IS NOT OLD.intent_id OR NEW.started_at IS NOT OLD.started_at OR NEW.deadline_at IS NOT OLD.deadline_at OR NEW.revision<=OLD.revision
    OR (OLD.state IN ('sent','failed','unknown') AND NEW.state<>OLD.state)
    THEN RAISE(ABORT,'REPLY_PROJECTION_CONFLICT') END);
END;
--> statement-breakpoint
DROP TABLE __saved_ai_conversation_control;
--> statement-breakpoint
DROP TABLE __saved_ai_conversation_control_event;
--> statement-breakpoint
DROP TABLE __saved_ai_send_intent;
--> statement-breakpoint
DROP TABLE __saved_ai_send_attempt;
