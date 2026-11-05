-- Direct saves validate and snapshot one configuration in a single statement.
-- Keep the legacy reviewed-publication path valid for existing API clients.
DROP TRIGGER reply_policy_publish_guard;
CREATE TRIGGER reply_policy_publish_guard BEFORE UPDATE OF published_revision ON reply_policy
WHEN NEW.published_revision IS NOT OLD.published_revision
BEGIN
  SELECT CASE WHEN NEW.published_revision IS NOT COALESCE(OLD.published_revision,0)+1
    OR NEW.enabled<>1 OR NEW.version<>OLD.version+1
    OR NOT (
      (OLD.tested_revision IS OLD.draft_revision AND NEW.draft_config IS OLD.draft_config
        AND OLD.tested_time_zone IS NOT NULL AND NEW.published_time_zone IS OLD.tested_time_zone)
      OR (NEW.draft_revision=OLD.draft_revision+1 AND NEW.tested_revision IS NEW.draft_revision
        AND NEW.tested_time_zone IS NOT NULL AND NEW.published_time_zone IS NEW.tested_time_zone
        AND NEW.tested_time_zone=COALESCE((SELECT time_zone FROM company_settings WHERE organization_id=NEW.organization_id),'UTC')
        AND NEW.draft_base_revision IS NEW.published_revision AND NEW.draft_rollback_of IS NULL)
    ) THEN RAISE(ABORT,'invalid policy publication') END;
END;

CREATE TRIGGER reply_policy_insert_publication_guard BEFORE INSERT ON reply_policy
WHEN NEW.published_revision IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.published_revision<>1 OR NEW.version<>1 OR NEW.draft_revision<>1
    OR NEW.tested_revision IS NOT 1 OR NEW.enabled<>1 OR NEW.draft_base_revision IS NOT 1
    OR NEW.tested_time_zone IS NULL OR NEW.published_time_zone IS NOT NEW.tested_time_zone
    OR NEW.tested_time_zone<>COALESCE((SELECT time_zone FROM company_settings WHERE organization_id=NEW.organization_id),'UTC')
    THEN RAISE(ABORT,'invalid policy publication') END;
END;

CREATE TRIGGER reply_policy_insert_snapshot AFTER INSERT ON reply_policy
WHEN NEW.published_revision IS NOT NULL
BEGIN
  INSERT INTO policy_version (organization_id,policy_id,revision,schema_version,config,time_zone,published_by,published_at,request_id,rollback_of)
  VALUES (NEW.organization_id,NEW.id,NEW.published_revision,1,NEW.draft_config,NEW.published_time_zone,NEW.published_by,NEW.published_at,NEW.published_request_id,NULL);
END;
