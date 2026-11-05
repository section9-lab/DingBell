-- FBP beta methods have independent facts and checkpoints; never relabel FBS/FBO storage.
CREATE TABLE fbp_posting (
 posting_number text NOT NULL, organization_id text NOT NULL, store_id text NOT NULL,
 order_id text NOT NULL, order_number text NOT NULL, list_facts text, list_observed_at integer,
 detail_facts text, detail_observed_at integer, detail_epoch integer NOT NULL, detail_generation integer NOT NULL,
 detail_revision integer NOT NULL DEFAULT 0, detail_state text NOT NULL DEFAULT 'pending', detail_attempt integer NOT NULL DEFAULT 0,
 detail_due_at integer NOT NULL, detail_error text,
 PRIMARY KEY(store_id,posting_number),
 FOREIGN KEY(store_id,organization_id) REFERENCES store(id,organization_id) ON DELETE CASCADE,
 CONSTRAINT fbp_posting_list_json CHECK(list_facts IS NULL OR (json_valid(list_facts) AND json_type(list_facts)='object')),
 CONSTRAINT fbp_posting_detail_json CHECK(detail_facts IS NULL OR (json_valid(detail_facts) AND json_type(detail_facts)='object')),
 CONSTRAINT fbp_posting_detail_state_valid CHECK(detail_state IN ('pending','complete','error')),
 CONSTRAINT fbp_posting_detail_counters_valid CHECK(detail_epoch>0 AND detail_generation>0 AND detail_revision>=0 AND detail_attempt BETWEEN 0 AND 3)
);
--> statement-breakpoint
CREATE UNIQUE INDEX fbp_posting_scope_unique ON fbp_posting(store_id,organization_id,posting_number);
--> statement-breakpoint
CREATE INDEX fbp_posting_detail_due_idx ON fbp_posting(store_id,detail_epoch,detail_state,detail_due_at,posting_number);
--> statement-breakpoint
CREATE INDEX fbp_posting_order_idx ON fbp_posting(organization_id,store_id,order_id);
--> statement-breakpoint
CREATE INDEX fbp_posting_number_idx ON fbp_posting(organization_id,store_id,order_number,order_id,posting_number);
--> statement-breakpoint
CREATE TABLE fbp_posting_observation (
 id text PRIMARY KEY NOT NULL, organization_id text NOT NULL, store_id text NOT NULL, posting_number text NOT NULL,
 source text NOT NULL, facts text NOT NULL, observed_at integer NOT NULL, source_updated_at integer,
 FOREIGN KEY(store_id,organization_id,posting_number) REFERENCES fbp_posting(store_id,organization_id,posting_number) ON DELETE CASCADE,
 CONSTRAINT fbp_observation_source_valid CHECK(source IN ('list','details')),
 CONSTRAINT fbp_observation_facts_json CHECK(json_valid(facts) AND json_type(facts)='object'),
 CONSTRAINT fbp_observation_source_time_unknown CHECK(source_updated_at IS NULL)
);
--> statement-breakpoint
CREATE INDEX fbp_observation_history_idx ON fbp_posting_observation(organization_id,store_id,posting_number,source,observed_at,id);
--> statement-breakpoint
CREATE TRIGGER fbp_observation_immutable BEFORE UPDATE ON fbp_posting_observation BEGIN SELECT RAISE(ABORT,'FBP_OBSERVATION_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TABLE fbp_sync_window (
 store_id text PRIMARY KEY NOT NULL, organization_id text NOT NULL, epoch integer NOT NULL, generation integer NOT NULL DEFAULT 1,
 revision integer NOT NULL DEFAULT 0, history_start integer NOT NULL, since integer NOT NULL, "to" integer NOT NULL,
 cursor text, recent_cursors text NOT NULL DEFAULT '[]', state text NOT NULL DEFAULT 'active', due_at integer NOT NULL,
 last_kind text NOT NULL DEFAULT 'details', last_completed_to integer,
 FOREIGN KEY(store_id,organization_id) REFERENCES store(id,organization_id) ON DELETE CASCADE,
 CONSTRAINT fbp_window_counters_valid CHECK(epoch>0 AND generation>0 AND revision>=0),
 CONSTRAINT fbp_window_bounds_valid CHECK("to">since AND "to"-since<=2678400000 AND history_start<=since),
 CONSTRAINT fbp_window_state_valid CHECK(state IN ('active','waiting') AND last_kind IN ('list','details')),
 CONSTRAINT fbp_window_history_valid CHECK(json_valid(recent_cursors) AND json_type(recent_cursors)='array' AND json_array_length(recent_cursors)<=8)
);
--> statement-breakpoint
-- Rebuild the entire FK chain with foreign_keys enabled, including historical jobs.
-- Only in-flight leases are invalidated; credentials, epochs, cooldowns and cursors survive.
CREATE TABLE __new_store_coordinator (
 store_id text PRIMARY KEY NOT NULL, organization_id text NOT NULL, fence integer NOT NULL DEFAULT 0,
 lease_source text, lease_token text, lease_until integer, commit_token text, blocked_until integer,
 FOREIGN KEY(store_id,organization_id) REFERENCES store(id,organization_id) ON DELETE CASCADE,
 CONSTRAINT store_coordinator_fence_valid CHECK(fence>=0),
 CONSTRAINT store_coordinator_lease_complete CHECK((lease_source IS NULL AND lease_token IS NULL AND lease_until IS NULL)
 OR (lease_source IS NOT NULL AND lease_source IN ('chat','products','fbs_postings','fbo_postings','fbp_postings') AND lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX __new_store_coordinator_scope_unique ON __new_store_coordinator(store_id,organization_id);
--> statement-breakpoint
INSERT INTO __new_store_coordinator(store_id,organization_id,fence,blocked_until) SELECT store_id,organization_id,fence+1,blocked_until FROM store_coordinator;
--> statement-breakpoint
CREATE TABLE __new_store_sync_source (
 store_id text NOT NULL, organization_id text NOT NULL, source text NOT NULL, enabled integer NOT NULL DEFAULT 0,
 epoch integer NOT NULL DEFAULT 0, credential_version integer, due_at integer NOT NULL, last_success_at integer,
 last_error text, failures integer NOT NULL DEFAULT 0, last_attempt_at integer, updated_at integer NOT NULL,
 PRIMARY KEY(store_id,source),FOREIGN KEY(store_id,organization_id) REFERENCES __new_store_coordinator(store_id,organization_id) ON DELETE CASCADE,
 CONSTRAINT store_sync_source_valid CHECK(source IN ('chat','products','fbs_postings','fbo_postings','fbp_postings')),
 CONSTRAINT store_sync_source_counters_valid CHECK(epoch>=0 AND failures>=0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX __new_store_sync_source_scope_unique ON __new_store_sync_source(store_id,organization_id,source);
--> statement-breakpoint
INSERT INTO __new_store_sync_source SELECT * FROM store_sync_source;
--> statement-breakpoint
CREATE TABLE __new_sync_cursor (
 organization_id text NOT NULL, store_id text NOT NULL, source text NOT NULL DEFAULT 'chat', thread_id text NOT NULL,
 stream text NOT NULL, conversation_id text, cursor text, recent_cursors text NOT NULL DEFAULT '[]', revision integer NOT NULL DEFAULT 0,
 due_at integer NOT NULL, completed integer NOT NULL DEFAULT 0,
 PRIMARY KEY(store_id,stream,thread_id),
 FOREIGN KEY(store_id,organization_id,source) REFERENCES __new_store_sync_source(store_id,organization_id,source) ON DELETE CASCADE,
 FOREIGN KEY(conversation_id,organization_id,store_id) REFERENCES conversation(id,organization_id,store_id) ON DELETE CASCADE,
 CONSTRAINT sync_cursor_source_valid CHECK(source='chat'),
 CONSTRAINT sync_cursor_history_valid CHECK(json_valid(recent_cursors) AND json_type(recent_cursors)='array' AND json_array_length(recent_cursors)<=8),
 CONSTRAINT sync_cursor_revision_valid CHECK(revision>=0),
 CONSTRAINT sync_cursor_stream_valid CHECK((stream='discovery' AND thread_id='' AND conversation_id IS NULL) OR (stream IN ('backfill','incremental') AND thread_id<>'' AND conversation_id IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO __new_sync_cursor SELECT * FROM sync_cursor;
--> statement-breakpoint
CREATE TABLE __new_posting_history_sync (
 store_id TEXT NOT NULL, organization_id TEXT NOT NULL, source TEXT NOT NULL,
 epoch INTEGER NOT NULL, command_revision INTEGER NOT NULL DEFAULT 1,generation INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 0,
 requested_from INTEGER NOT NULL,requested_to INTEGER NOT NULL,covered_from INTEGER NOT NULL,since INTEGER NOT NULL,"to" INTEGER NOT NULL,
 cursor TEXT,recent_cursors TEXT NOT NULL DEFAULT '[]',state TEXT NOT NULL DEFAULT 'active',due_at INTEGER NOT NULL,pages_read INTEGER NOT NULL DEFAULT 0,last_lane TEXT NOT NULL DEFAULT 'details',
 PRIMARY KEY(store_id,source),FOREIGN KEY(store_id,organization_id,source) REFERENCES __new_store_sync_source(store_id,organization_id,source) ON DELETE CASCADE,
 CONSTRAINT posting_history_source_valid CHECK(source IN ('fbs_postings','fbo_postings','fbp_postings')),
 CONSTRAINT posting_history_counters_valid CHECK(epoch>0 AND command_revision>0 AND generation>0 AND revision>=0 AND pages_read>=0),
 CONSTRAINT posting_history_requested_valid CHECK(requested_from>=946684800000 AND requested_from<requested_to AND covered_from BETWEEN requested_from AND requested_to),
 CONSTRAINT posting_history_bounds_valid CHECK(since>=requested_from AND "to">since AND "to"-since<=2678400000 AND "to"<=requested_to),
 CONSTRAINT posting_history_state_valid CHECK(state IN ('active','complete','cancelled') AND last_lane IN ('live','history','details')),
 CONSTRAINT posting_history_history_valid CHECK(json_valid(recent_cursors) AND json_type(recent_cursors)='array' AND json_array_length(recent_cursors)<=8)
);
--> statement-breakpoint
INSERT INTO __new_posting_history_sync SELECT * FROM posting_history_sync;
--> statement-breakpoint
DROP TRIGGER store_sync_lifecycle;
--> statement-breakpoint
DROP TABLE posting_history_sync;
--> statement-breakpoint
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
ALTER TABLE __new_posting_history_sync RENAME TO posting_history_sync;
--> statement-breakpoint
CREATE UNIQUE INDEX store_coordinator_scope_unique ON store_coordinator(store_id,organization_id);
--> statement-breakpoint
CREATE UNIQUE INDEX store_sync_source_scope_unique ON store_sync_source(store_id,organization_id,source);
--> statement-breakpoint
CREATE INDEX store_sync_source_due_idx ON store_sync_source(enabled,due_at,store_id);
--> statement-breakpoint
CREATE INDEX sync_cursor_due_idx ON sync_cursor(store_id,completed,due_at,stream,thread_id);
--> statement-breakpoint
DROP INDEX __new_store_coordinator_scope_unique;
--> statement-breakpoint
DROP INDEX __new_store_sync_source_scope_unique;
--> statement-breakpoint
CREATE TRIGGER store_sync_lifecycle AFTER UPDATE OF status,credential_version ON store
WHEN (NEW.status IN ('paused','disconnected') AND NEW.status IS NOT OLD.status) OR NEW.credential_version<>OLD.credential_version
BEGIN
 UPDATE store_sync_source SET enabled=0,epoch=epoch+1,updated_at=CAST(unixepoch('subsecond')*1000 AS INTEGER) WHERE store_id=NEW.id AND organization_id=NEW.organization_id;
 UPDATE store_coordinator SET fence=fence+1,lease_source=NULL,lease_token=NULL,lease_until=NULL,commit_token=NULL WHERE store_id=NEW.id AND organization_id=NEW.organization_id;
END;
--> statement-breakpoint
DROP VIEW commerce_posting;
--> statement-breakpoint
-- Older FBS API versions included FBP. A proven exact FBP identity wins presentation,
-- without deleting legacy FBS facts, observations or compatibility detail links.
CREATE VIEW commerce_posting AS
 SELECT 'fbs' AS fulfillment_type,legacy.* FROM fbs_posting legacy WHERE NOT EXISTS (
  SELECT 1 FROM fbp_posting partner WHERE partner.store_id=legacy.store_id AND partner.organization_id=legacy.organization_id
   AND partner.posting_number=legacy.posting_number AND partner.order_id=legacy.order_id AND partner.order_number=legacy.order_number)
 UNION ALL SELECT 'fbo' AS fulfillment_type,* FROM fbo_posting
 UNION ALL SELECT 'fbp' AS fulfillment_type,* FROM fbp_posting;
