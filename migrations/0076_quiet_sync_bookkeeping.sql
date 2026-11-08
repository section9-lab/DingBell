-- 0076: polling rewrites must not look like business changes.
-- The coordinator and Ozon pollers rewrite due_at, observations and read state on every
-- page. Bumping the realtime revision for identical values makes every open page refetch
-- all company queries every second or two, which presents as a constantly refreshing UI.
-- Only value changes that a member can observe bump the revision; the sync panel polls
-- while it is open, and message read flags keep their separate status revision.
DROP TRIGGER IF EXISTS push_source_updated;
--> statement-breakpoint
CREATE TRIGGER push_source_updated AFTER UPDATE OF enabled,epoch,credential_version,last_error,failures ON store_sync_source
WHEN OLD.enabled IS NOT NEW.enabled
  OR OLD.epoch IS NOT NEW.epoch
  OR OLD.credential_version IS NOT NEW.credential_version
  OR OLD.last_error IS NOT NEW.last_error
  OR OLD.failures IS NOT NEW.failures
BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS push_fbp_updated;
--> statement-breakpoint
CREATE TRIGGER push_fbp_updated AFTER UPDATE OF detail_facts,list_facts ON fbp_posting
WHEN OLD.detail_facts IS NOT NEW.detail_facts OR OLD.list_facts IS NOT NEW.list_facts
BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS push_fbo_updated;
--> statement-breakpoint
CREATE TRIGGER push_fbo_updated AFTER UPDATE OF detail_facts,list_facts ON fbo_posting
WHEN OLD.detail_facts IS NOT NEW.detail_facts OR OLD.list_facts IS NOT NEW.list_facts
BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS push_fbs_updated;
--> statement-breakpoint
CREATE TRIGGER push_fbs_updated AFTER UPDATE OF detail_facts,list_facts ON fbs_posting
WHEN OLD.detail_facts IS NOT NEW.detail_facts OR OLD.list_facts IS NOT NEW.list_facts
BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS push_product_updated;
--> statement-breakpoint
CREATE TRIGGER push_product_updated AFTER UPDATE OF facts,detail_state ON product
WHEN OLD.facts IS NOT NEW.facts OR OLD.detail_state IS NOT NEW.detail_state
BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS push_control_updated;
--> statement-breakpoint
CREATE TRIGGER push_control_updated AFTER UPDATE ON conversation_control
WHEN OLD.schema_version IS NOT NEW.schema_version OR OLD.version IS NOT NEW.version
  OR OLD.control_epoch IS NOT NEW.control_epoch OR OLD.sequence IS NOT NEW.sequence
  OR OLD.lifecycle IS NOT NEW.lifecycle OR OLD.reception IS NOT NEW.reception
  OR OLD.work_status IS NOT NEW.work_status OR OLD.assigned_member_id IS NOT NEW.assigned_member_id
BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS push_message_updated;
--> statement-breakpoint
CREATE TRIGGER push_message_updated AFTER UPDATE ON message
WHEN OLD.content IS NOT NEW.content OR OLD.platform_message_id IS NOT NEW.platform_message_id
  OR OLD.sender_id IS NOT NEW.sender_id OR OLD.sender_type IS NOT NEW.sender_type
  OR OLD.event_at IS NOT NEW.event_at OR OLD.is_image IS NOT NEW.is_image
  OR OLD.order_number IS NOT NEW.order_number OR OLD.sku IS NOT NEW.sku
BEGIN
 INSERT INTO store_change_revision(store_id,organization_id,revision) VALUES(NEW.store_id,NEW.organization_id,1)
 ON CONFLICT(store_id) DO UPDATE SET revision=revision+1;
END;
