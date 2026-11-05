CREATE TABLE posting_history_sync (
 store_id TEXT NOT NULL, organization_id TEXT NOT NULL, source TEXT NOT NULL,
 epoch INTEGER NOT NULL, command_revision INTEGER NOT NULL DEFAULT 1,
 generation INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0,
 requested_from INTEGER NOT NULL, requested_to INTEGER NOT NULL, covered_from INTEGER NOT NULL,
 since INTEGER NOT NULL, "to" INTEGER NOT NULL, cursor TEXT, recent_cursors TEXT NOT NULL DEFAULT '[]',
 state TEXT NOT NULL DEFAULT 'active', due_at INTEGER NOT NULL, pages_read INTEGER NOT NULL DEFAULT 0,
 last_lane TEXT NOT NULL DEFAULT 'details',
 PRIMARY KEY(store_id,source),
 FOREIGN KEY(store_id,organization_id,source) REFERENCES store_sync_source(store_id,organization_id,source) ON DELETE CASCADE,
 CONSTRAINT posting_history_source_valid CHECK(source IN ('fbs_postings','fbo_postings')),
 CONSTRAINT posting_history_counters_valid CHECK(epoch>0 AND command_revision>0 AND generation>0 AND revision>=0 AND pages_read>=0),
 CONSTRAINT posting_history_requested_valid CHECK(requested_from>=946684800000 AND requested_from<requested_to AND covered_from BETWEEN requested_from AND requested_to),
 CONSTRAINT posting_history_bounds_valid CHECK(since>=requested_from AND "to">since AND "to"-since<=2678400000 AND "to"<=requested_to),
 CONSTRAINT posting_history_state_valid CHECK(state IN ('active','complete','cancelled') AND last_lane IN ('live','history','details')),
 CONSTRAINT posting_history_history_valid CHECK(json_valid(recent_cursors) AND json_type(recent_cursors)='array' AND json_array_length(recent_cursors)<=8)
);
