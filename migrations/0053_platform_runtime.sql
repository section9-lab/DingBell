-- Runtime bindings are distinct from legacy Flue identities. Never reinterpret an old receipt.
CREATE TABLE runtime_agent_binding (
  instance_id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CONSTRAINT runtime_agent_binding_kind CHECK(kind IN ('translation','reply-test','support')),
  run_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  definition TEXT NOT NULL CONSTRAINT runtime_agent_binding_definition CHECK(json_valid(definition)),
  fingerprint TEXT NOT NULL,
  receipt TEXT CONSTRAINT runtime_agent_binding_receipt CHECK(receipt IS NULL OR json_valid(receipt)),
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX runtime_agent_binding_uid_unique ON runtime_agent_binding(uid);
--> statement-breakpoint
CREATE UNIQUE INDEX runtime_agent_binding_kind_run_unique ON runtime_agent_binding(kind,run_id);
--> statement-breakpoint
CREATE TRIGGER runtime_agent_binding_immutable BEFORE UPDATE ON runtime_agent_binding
WHEN NEW.instance_id<>OLD.instance_id OR NEW.kind<>OLD.kind OR NEW.run_id<>OLD.run_id OR NEW.uid<>OLD.uid
 OR NEW.definition<>OLD.definition OR NEW.fingerprint<>OLD.fingerprint OR NEW.created_at<>OLD.created_at
 OR (OLD.receipt IS NOT NULL AND NEW.receipt IS NOT OLD.receipt)
BEGIN SELECT RAISE(ABORT,'RUNTIME_BINDING_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TABLE runtime_platform_setting (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
