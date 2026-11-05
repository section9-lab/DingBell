-- Push is provisioned before cutover. Existing business snapshots and legacy cursors are retained.
CREATE TABLE store_push_endpoint (
 store_id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL, endpoint_id TEXT NOT NULL UNIQUE,
 revision INTEGER NOT NULL CHECK(revision>0),generation INTEGER NOT NULL CHECK(generation>0),
 mode TEXT NOT NULL CHECK(mode IN ('prepared','active','paused')),seller_id TEXT,observed_seller_id TEXT,
 secret_hash TEXT NOT NULL,key_version TEXT NOT NULL,nonce TEXT NOT NULL,ciphertext TEXT NOT NULL,
 last_ping_at INTEGER,last_received_at INTEGER,last_simulation_at INTEGER,last_processed_at INTEGER,cutover_at INTEGER,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 FOREIGN KEY(store_id,organization_id) REFERENCES store(id,organization_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE ozon_push_event (
 id TEXT PRIMARY KEY NOT NULL,organization_id TEXT NOT NULL,store_id TEXT NOT NULL,generation INTEGER NOT NULL,
 dedupe_key TEXT NOT NULL,notification_type TEXT NOT NULL,source TEXT NOT NULL,
 hint TEXT NOT NULL CHECK(json_valid(hint) AND json_type(hint)='object'),
 simulated INTEGER NOT NULL DEFAULT 0 CHECK(simulated IN (0,1)),requires_review INTEGER NOT NULL DEFAULT 0 CHECK(requires_review IN (0,1)),
 state TEXT NOT NULL CHECK(state IN ('pending','processing','retry','completed','ignored','failed')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),next_attempt_at INTEGER NOT NULL,
 lease_token TEXT,lease_until INTEGER,progress TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(progress)),
 received_at INTEGER NOT NULL,finished_at INTEGER,last_error TEXT,
 FOREIGN KEY(store_id,organization_id) REFERENCES store(id,organization_id) ON DELETE CASCADE,
 UNIQUE(store_id,generation,dedupe_key)
);
--> statement-breakpoint
CREATE INDEX ozon_push_event_due ON ozon_push_event(state,next_attempt_at,lease_until,store_id);
--> statement-breakpoint
CREATE INDEX ozon_push_event_scope ON ozon_push_event(organization_id,store_id,received_at,id);
--> statement-breakpoint
CREATE TABLE ozon_push_chat_head (
 conversation_id TEXT PRIMARY KEY NOT NULL,organization_id TEXT NOT NULL,store_id TEXT NOT NULL,message_id TEXT,push_event_id TEXT,observed_at INTEGER NOT NULL,
 FOREIGN KEY(conversation_id,organization_id,store_id) REFERENCES conversation(id,organization_id,store_id) ON DELETE CASCADE,
 FOREIGN KEY(message_id,organization_id,store_id,conversation_id) REFERENCES message(id,organization_id,store_id,conversation_id) ON DELETE CASCADE,
 FOREIGN KEY(push_event_id) REFERENCES ozon_push_event(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE ozon_push_live_message (
 message_id TEXT PRIMARY KEY NOT NULL,organization_id TEXT NOT NULL,store_id TEXT NOT NULL,conversation_id TEXT NOT NULL,push_event_id TEXT NOT NULL,observed_at INTEGER NOT NULL,
 FOREIGN KEY(message_id,organization_id,store_id,conversation_id) REFERENCES message(id,organization_id,store_id,conversation_id) ON DELETE CASCADE,
 FOREIGN KEY(push_event_id) REFERENCES ozon_push_event(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TRIGGER push_live_proof_immutable BEFORE UPDATE ON ozon_push_live_message BEGIN SELECT RAISE(ABORT,'PUSH_LIVE_PROOF_IMMUTABLE'); END;
--> statement-breakpoint
DROP TRIGGER message_update_immutable;
--> statement-breakpoint
-- A canonical, fresh NEW_MESSAGE may promote a previously imported historical row.
-- Its content/identity/time remain immutable; simulation cannot create this proof.
CREATE TRIGGER message_update_immutable BEFORE UPDATE ON message
WHEN OLD.platform_message_id NOT LIKE 'sent:%' AND (
 OLD.id IS NOT NEW.id OR OLD.organization_id IS NOT NEW.organization_id OR OLD.store_id IS NOT NEW.store_id
 OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.platform_message_id IS NOT NEW.platform_message_id
 OR OLD.content IS NOT NEW.content OR OLD.sender_id IS NOT NEW.sender_id OR OLD.sender_type IS NOT NEW.sender_type
 OR OLD.direction IS NOT NEW.direction OR OLD.event_at IS NOT NEW.event_at OR OLD.is_image IS NOT NEW.is_image
 OR (OLD.ingest_mode IS NOT NEW.ingest_mode AND NOT(OLD.ingest_mode='backfill' AND NEW.ingest_mode='incremental'
  AND EXISTS(SELECT 1 FROM ozon_push_live_message WHERE message_id=OLD.id AND organization_id=OLD.organization_id AND store_id=OLD.store_id AND conversation_id=OLD.conversation_id)))
 OR OLD.received_at IS NOT NEW.received_at)
BEGIN SELECT RAISE(ABORT,'MESSAGE_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TABLE store_change_revision (
 store_id TEXT PRIMARY KEY NOT NULL,organization_id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
 message_status_revision INTEGER NOT NULL DEFAULT 0 CHECK(message_status_revision BETWEEN 0 AND 9007199254740991),
 FOREIGN KEY(store_id,organization_id) REFERENCES store(id,organization_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TRIGGER push_endpoint_fence AFTER UPDATE OF mode,endpoint_id ON store_push_endpoint
WHEN NEW.cutover_at IS NOT NULL OR OLD.cutover_at IS NOT NULL BEGIN
 UPDATE store_coordinator SET fence=fence+1,lease_token=NULL,lease_until=NULL,lease_source=NULL,commit_token=NULL
 WHERE store_id=NEW.store_id AND organization_id=NEW.organization_id;
END;
--> statement-breakpoint
CREATE TRIGGER push_endpoint_changed AFTER INSERT ON store_push_endpoint BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
CREATE TRIGGER push_endpoint_updated AFTER UPDATE ON store_push_endpoint BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
CREATE TRIGGER push_event_created AFTER INSERT ON ozon_push_event BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
CREATE TRIGGER push_event_changed AFTER UPDATE OF state ON ozon_push_event BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
CREATE TRIGGER push_message_changed AFTER INSERT ON message BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
CREATE TRIGGER push_message_updated AFTER UPDATE ON message BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
CREATE TRIGGER push_message_status_changed AFTER UPDATE OF is_read,platform_message_id,ingest_mode ON message
WHEN OLD.is_read IS NOT NEW.is_read OR OLD.platform_message_id IS NOT NEW.platform_message_id OR OLD.ingest_mode IS NOT NEW.ingest_mode BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision,message_status_revision) VALUES(NEW.store_id,NEW.organization_id,1,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1,message_status_revision=message_status_revision+1;
END;
--> statement-breakpoint
CREATE TRIGGER push_source_created AFTER INSERT ON store_sync_source BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
CREATE TRIGGER push_source_updated AFTER UPDATE ON store_sync_source BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
CREATE TRIGGER push_product_changed AFTER INSERT ON product BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
CREATE TRIGGER push_product_updated AFTER UPDATE OF facts,detail_state ON product BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
CREATE TRIGGER push_control_updated AFTER UPDATE ON conversation_control BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
CREATE TRIGGER push_fbs_updated AFTER UPDATE OF detail_facts,list_facts ON fbs_posting BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
CREATE TRIGGER push_fbo_updated AFTER UPDATE OF detail_facts,list_facts ON fbo_posting BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
CREATE TRIGGER push_fbp_updated AFTER UPDATE OF detail_facts,list_facts ON fbp_posting BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
