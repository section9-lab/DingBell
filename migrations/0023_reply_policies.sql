CREATE TABLE `policy_version` (
	`organization_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`revision` integer NOT NULL,
	`schema_version` integer NOT NULL,
	`config` text NOT NULL,
	`time_zone` text NOT NULL,
	`published_by` text NOT NULL,
	`published_at` integer NOT NULL,
	`request_id` text NOT NULL,
	`rollback_of` integer,
	PRIMARY KEY(`organization_id`, `policy_id`, `revision`),
	FOREIGN KEY (`organization_id`,`policy_id`) REFERENCES `reply_policy`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "policy_version_content_valid" CHECK(json_valid("policy_version"."config") AND "policy_version"."schema_version"=1 AND "policy_version"."revision">0)
);
--> statement-breakpoint
CREATE TABLE `reply_policy` (
	`organization_id` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`version` integer NOT NULL,
	`draft_revision` integer NOT NULL,
	`tested_revision` integer,
	`tested_time_zone` text,
	`draft_base_revision` integer,
	`draft_rollback_of` integer,
	`draft_config` text NOT NULL,
	`published_revision` integer,
	`enabled` integer DEFAULT false NOT NULL,
	`published_by` text,
	`published_at` integer,
	`published_request_id` text,
	`published_time_zone` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "reply_policy_kind_valid" CHECK("reply_policy"."kind" IN ('automatic','notification') AND json_valid("reply_policy"."draft_config") AND json_extract("reply_policy"."draft_config",'$.kind')="reply_policy"."kind"),
	CONSTRAINT "reply_policy_versions_valid" CHECK(typeof("reply_policy"."version")='integer' AND "reply_policy"."version" BETWEEN 1 AND 9007199254740991
    AND typeof("reply_policy"."draft_revision")='integer' AND "reply_policy"."draft_revision" BETWEEN 1 AND "reply_policy"."version"
    AND ("reply_policy"."tested_revision" IS NULL OR "reply_policy"."tested_revision"="reply_policy"."draft_revision")
    AND ("reply_policy"."published_revision" IS NULL OR "reply_policy"."published_revision" BETWEEN 1 AND "reply_policy"."version")),
	CONSTRAINT "reply_policy_enabled_valid" CHECK("reply_policy"."enabled" IN (0,1) AND ("reply_policy"."enabled"=0 OR "reply_policy"."published_revision" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `reply_policy_audit_event` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`expected_version` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reply_policy_audit_request_idx` ON `reply_policy_audit_event` (`request_id`);--> statement-breakpoint
CREATE INDEX `reply_policy_audit_organization_time_idx` ON `reply_policy_audit_event` (`organization_id`,`created_at`,`id`);
--> statement-breakpoint
-- The publication and its immutable snapshot commit in the same SQLite statement.
CREATE TRIGGER reply_policy_publish_guard BEFORE UPDATE OF published_revision ON reply_policy
WHEN NEW.published_revision IS NOT OLD.published_revision
BEGIN
  SELECT (CASE WHEN NEW.published_revision IS NOT COALESCE(OLD.published_revision,0)+1
    OR OLD.tested_revision IS NOT OLD.draft_revision OR NEW.draft_config IS NOT OLD.draft_config
    OR OLD.tested_time_zone IS NULL OR NEW.published_time_zone IS NOT OLD.tested_time_zone
    OR NEW.enabled<>1 OR NEW.version<>OLD.version+1 THEN RAISE(ABORT,'invalid policy publication') END);
END;
--> statement-breakpoint
CREATE TRIGGER reply_policy_publish_snapshot AFTER UPDATE OF published_revision ON reply_policy
WHEN NEW.published_revision IS NOT OLD.published_revision
BEGIN
  INSERT INTO policy_version (organization_id,policy_id,revision,schema_version,config,time_zone,published_by,published_at,request_id,rollback_of)
  VALUES (NEW.organization_id,NEW.id,NEW.published_revision,1,NEW.draft_config,NEW.published_time_zone,NEW.published_by,NEW.published_at,NEW.published_request_id,NEW.draft_rollback_of);
END;
--> statement-breakpoint
CREATE TRIGGER policy_version_immutable_update BEFORE UPDATE ON policy_version
BEGIN SELECT RAISE(ABORT,'policy version is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER policy_version_immutable_replace BEFORE INSERT ON policy_version
WHEN EXISTS (SELECT 1 FROM policy_version WHERE organization_id=NEW.organization_id AND policy_id=NEW.policy_id AND revision=NEW.revision)
BEGIN SELECT RAISE(ABORT,'policy version is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER policy_version_immutable_delete BEFORE DELETE ON policy_version
WHEN EXISTS (SELECT 1 FROM reply_policy WHERE organization_id=OLD.organization_id AND id=OLD.policy_id)
BEGIN SELECT RAISE(ABORT,'policy version is immutable'); END;
