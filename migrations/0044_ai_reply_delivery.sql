CREATE TABLE `__new_conversation_control_event` (
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
	CONSTRAINT "conversation_control_event_sequence_valid" CHECK("__new_conversation_control_event"."sequence" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "conversation_control_event_action_valid" CHECK("__new_conversation_control_event"."action" IN ('claim','takeover','resolve','reopen','set_work_status','transfer','add_note','send_reply','cancel_reply','ai_start','ai_resume','ai_listen','request_handoff','customer_message','ai_intake_start','ai_classification','ai_dispatch_stop','ai_send_reply')),
	CONSTRAINT "conversation_control_event_actor_valid" CHECK(("__new_conversation_control_event"."action" IN ('ai_start','request_handoff','customer_message','ai_intake_start','ai_classification','ai_dispatch_stop','ai_send_reply') AND "__new_conversation_control_event"."actor_user_id" IS NULL AND "__new_conversation_control_event"."actor_member_id" IS NULL) OR ("__new_conversation_control_event"."action" NOT IN ('ai_start','request_handoff','customer_message','ai_intake_start','ai_classification','ai_dispatch_stop','ai_send_reply') AND "__new_conversation_control_event"."actor_user_id" IS NOT NULL AND "__new_conversation_control_event"."actor_member_id" IS NOT NULL)),
	CONSTRAINT "conversation_control_event_receipt_valid" CHECK(json_valid("__new_conversation_control_event"."receipt") AND json_type("__new_conversation_control_event"."receipt")='object')
);
--> statement-breakpoint
INSERT INTO `__new_conversation_control_event`("controller_id", "organization_id", "store_id", "conversation_id", "sequence", "command_id", "actor_user_id", "actor_member_id", "action", "receipt", "projected_at") SELECT "controller_id", "organization_id", "store_id", "conversation_id", "sequence", "command_id", "actor_user_id", "actor_member_id", "action", "receipt", "projected_at" FROM `conversation_control_event`;
--> statement-breakpoint
DROP TABLE `conversation_control_event`;
--> statement-breakpoint
ALTER TABLE `__new_conversation_control_event` RENAME TO `conversation_control_event`;
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_control_command_unique` ON `conversation_control_event` (`controller_id`,`command_id`);
--> statement-breakpoint
-- Preserve attempts before rebuilding their referenced table, with foreign keys still enabled.
CREATE TABLE `__saved_send_attempt` AS SELECT * FROM `send_attempt`;
--> statement-breakpoint
DROP TABLE `send_attempt`;
--> statement-breakpoint
CREATE TABLE `__new_send_intent` (
	`controller_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`id` text NOT NULL,
	`schema_version` integer NOT NULL,
	`command_id` text NOT NULL,
	`actor_user_id` text,
	`actor_member_id` text,
	`ai_run_id` text,
	`body` text NOT NULL,
	`body_hash` text NOT NULL,
	`platform_thread_id` text NOT NULL,
	`credential_version` integer NOT NULL,
	`control_epoch` integer NOT NULL,
	`state` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`due_at` integer,
	`last_error` text,
	`projected_at` integer NOT NULL,
	PRIMARY KEY(`controller_id`, `id`),
	FOREIGN KEY (`ai_run_id`) REFERENCES `ai_reply_intent`(`run_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`controller_id`,`organization_id`,`store_id`,`conversation_id`) REFERENCES `conversation_control`(`controller_id`,`organization_id`,`store_id`,`conversation_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "send_intent_version_valid" CHECK("__new_send_intent"."schema_version" IN (1,2) AND "__new_send_intent"."id"="__new_send_intent"."command_id" AND "__new_send_intent"."revision" BETWEEN 1 AND 9007199254740991 AND "__new_send_intent"."credential_version" BETWEEN 1 AND 9007199254740991 AND "__new_send_intent"."control_epoch" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "send_intent_actor_valid" CHECK(("__new_send_intent"."schema_version"=1 AND "__new_send_intent"."actor_user_id" IS NOT NULL AND "__new_send_intent"."actor_member_id" IS NOT NULL AND "__new_send_intent"."ai_run_id" IS NULL) OR ("__new_send_intent"."schema_version"=2 AND "__new_send_intent"."actor_user_id" IS NULL AND "__new_send_intent"."actor_member_id" IS NULL AND "__new_send_intent"."ai_run_id" IS NOT NULL AND "__new_send_intent"."id"='ai-reply:'||"__new_send_intent"."ai_run_id")),
	CONSTRAINT "send_intent_state_valid" CHECK("__new_send_intent"."state" IN ('queued','sending','sent','failed','unknown','skipped','canceled') AND ("__new_send_intent"."state"<>'canceled' OR ("__new_send_intent"."due_at" IS NULL AND "__new_send_intent"."last_error" IS NULL))),
	CONSTRAINT "send_intent_time_valid" CHECK("__new_send_intent"."created_at" BETWEEN 0 AND 8640000000000000 AND "__new_send_intent"."updated_at" BETWEEN "__new_send_intent"."created_at" AND 8640000000000000 AND ("__new_send_intent"."due_at" IS NULL OR "__new_send_intent"."due_at" BETWEEN 0 AND 8640000000000000) AND "__new_send_intent"."projected_at" BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
INSERT INTO `__new_send_intent`("controller_id", "organization_id", "store_id", "conversation_id", "id", "schema_version", "command_id", "actor_user_id", "actor_member_id", "ai_run_id", "body", "body_hash", "platform_thread_id", "credential_version", "control_epoch", "state", "revision", "created_at", "updated_at", "due_at", "last_error", "projected_at") SELECT "controller_id", "organization_id", "store_id", "conversation_id", "id", "schema_version", "command_id", "actor_user_id", "actor_member_id", NULL, "body", "body_hash", "platform_thread_id", "credential_version", "control_epoch", "state", "revision", "created_at", "updated_at", "due_at", "last_error", "projected_at" FROM `send_intent`;
--> statement-breakpoint
DROP TABLE `send_intent`;
--> statement-breakpoint
ALTER TABLE `__new_send_intent` RENAME TO `send_intent`;
--> statement-breakpoint
CREATE UNIQUE INDEX `send_intent_scope_unique` ON `send_intent` (`controller_id`,`id`,`organization_id`,`store_id`,`conversation_id`);
--> statement-breakpoint
CREATE INDEX `send_intent_conversation_time_idx` ON `send_intent` (`organization_id`,`conversation_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TABLE `send_attempt` (
	`controller_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`id` text NOT NULL,
	`intent_id` text NOT NULL,
	`revision` integer NOT NULL,
	`state` text NOT NULL,
	`started_at` integer NOT NULL,
	`deadline_at` integer NOT NULL,
	`finished_at` integer,
	`http_status` integer,
	`provider_result` text,
	`error_code` text,
	`projected_at` integer NOT NULL,
	PRIMARY KEY(`controller_id`, `id`),
	FOREIGN KEY (`controller_id`,`intent_id`,`organization_id`,`store_id`,`conversation_id`) REFERENCES `send_intent`(`controller_id`,`id`,`organization_id`,`store_id`,`conversation_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "send_attempt_identity_valid" CHECK("send_attempt"."id"="send_attempt"."intent_id"||':1' AND "send_attempt"."revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "send_attempt_state_valid" CHECK("send_attempt"."state" IN ('sending','sent','failed','unknown') AND ("send_attempt"."provider_result" IS NULL OR "send_attempt"."provider_result"='success')),
	CONSTRAINT "send_attempt_time_valid" CHECK("send_attempt"."started_at" BETWEEN 0 AND 8640000000000000 AND "send_attempt"."deadline_at" BETWEEN "send_attempt"."started_at" AND 8640000000000000 AND ("send_attempt"."finished_at" IS NULL OR "send_attempt"."finished_at" BETWEEN "send_attempt"."started_at" AND 8640000000000000) AND ("send_attempt"."http_status" IS NULL OR "send_attempt"."http_status" BETWEEN 100 AND 599) AND "send_attempt"."projected_at" BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `send_attempt_intent_unique` ON `send_attempt` (`controller_id`,`intent_id`);
--> statement-breakpoint
INSERT INTO `send_attempt` SELECT * FROM `__saved_send_attempt`;
--> statement-breakpoint
DROP TABLE `__saved_send_attempt`;
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
  SELECT (CASE WHEN NEW.schema_version=2 AND NOT EXISTS (
    SELECT 1 FROM ai_reply_intent prepared JOIN ai_execution execution ON execution.id=prepared.run_id
    WHERE prepared.run_id=NEW.ai_run_id AND prepared.id=NEW.id AND execution.controller_id=NEW.controller_id
      AND execution.organization_id=NEW.organization_id AND execution.store_id=NEW.store_id AND execution.conversation_id=NEW.conversation_id
      AND prepared.body=NEW.body AND prepared.platform_thread_id=NEW.platform_thread_id AND prepared.credential_version=NEW.credential_version
      AND json_extract(execution.payload,'$.run.controlEpoch')=NEW.control_epoch)
    THEN RAISE(ABORT,'REPLY_AI_INTENT_MISMATCH') END);
  SELECT (CASE WHEN NEW.state='canceled' AND (EXISTS (SELECT 1 FROM send_intent AS saved WHERE saved.controller_id=NEW.controller_id AND saved.id=NEW.id AND NEW.revision>saved.revision AND saved.state NOT IN ('queued','canceled')) OR EXISTS (SELECT 1 FROM send_attempt WHERE controller_id=NEW.controller_id AND intent_id=NEW.id))
    THEN RAISE(ABORT,'REPLY_CANCELLATION_CONFLICT') END);
  SELECT (CASE WHEN NOT EXISTS (SELECT 1 FROM conversation_control WHERE controller_id=NEW.controller_id AND organization_id=NEW.organization_id AND store_id=NEW.store_id AND conversation_id=NEW.conversation_id)
    THEN RAISE(ABORT,'REPLY_SCOPE_MISMATCH') END);
  SELECT (CASE WHEN EXISTS (SELECT 1 FROM send_intent AS saved WHERE saved.controller_id=NEW.controller_id AND saved.id=NEW.id
    AND ((saved.organization_id IS NOT NEW.organization_id OR saved.store_id IS NOT NEW.store_id OR saved.conversation_id IS NOT NEW.conversation_id OR saved.schema_version IS NOT NEW.schema_version OR saved.ai_run_id IS NOT NEW.ai_run_id OR saved.command_id IS NOT NEW.command_id OR saved.actor_user_id IS NOT NEW.actor_user_id OR saved.actor_member_id IS NOT NEW.actor_member_id OR saved.body IS NOT NEW.body OR saved.body_hash IS NOT NEW.body_hash OR saved.platform_thread_id IS NOT NEW.platform_thread_id OR saved.credential_version IS NOT NEW.credential_version OR saved.control_epoch IS NOT NEW.control_epoch OR saved.created_at IS NOT NEW.created_at) OR (saved.revision=NEW.revision AND (saved.state IS NOT NEW.state OR saved.updated_at IS NOT NEW.updated_at OR saved.due_at IS NOT NEW.due_at OR saved.last_error IS NOT NEW.last_error)) OR (NEW.revision>saved.revision AND (NEW.updated_at<saved.updated_at OR (saved.state IN ('sent','failed','unknown','skipped','canceled') AND NEW.state<>saved.state)))))
    THEN RAISE(ABORT,'REPLY_PROJECTION_CONFLICT') END);
END;
--> statement-breakpoint
CREATE TRIGGER send_intent_update_guard BEFORE UPDATE ON send_intent
BEGIN
  SELECT (CASE WHEN NEW.state='canceled' AND (OLD.state NOT IN ('queued','canceled') OR EXISTS (SELECT 1 FROM send_attempt WHERE controller_id=NEW.controller_id AND intent_id=NEW.id))
    THEN RAISE(ABORT,'REPLY_CANCELLATION_CONFLICT') END);
  SELECT (CASE WHEN NEW.controller_id<>OLD.controller_id OR NEW.id<>OLD.id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.store_id IS NOT OLD.store_id OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.schema_version IS NOT OLD.schema_version OR NEW.ai_run_id IS NOT OLD.ai_run_id OR NEW.command_id IS NOT OLD.command_id OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.actor_member_id IS NOT OLD.actor_member_id OR NEW.body IS NOT OLD.body OR NEW.body_hash IS NOT OLD.body_hash OR NEW.platform_thread_id IS NOT OLD.platform_thread_id OR NEW.credential_version IS NOT OLD.credential_version OR NEW.control_epoch IS NOT OLD.control_epoch OR NEW.created_at IS NOT OLD.created_at OR NEW.revision<=OLD.revision OR NEW.updated_at<OLD.updated_at
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
