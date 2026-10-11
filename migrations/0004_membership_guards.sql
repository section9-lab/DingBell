ALTER TABLE `identity_audit_event` ADD `target_member_id` text;--> statement-breakpoint
ALTER TABLE `identity_audit_event` ADD `before_role` text;--> statement-breakpoint
ALTER TABLE `identity_audit_event` ADD `after_role` text;
--> statement-breakpoint
-- D1 does not support interactive transactions. Check the invariant at the
-- serialized write, rather than counting owners before the SDK mutation.
CREATE TRIGGER member_last_owner_delete
BEFORE DELETE ON member
WHEN instr(',' || replace(OLD.role, ' ', '') || ',', ',owner,') > 0
  AND NOT EXISTS (
    SELECT 1 FROM member
    WHERE organization_id = OLD.organization_id AND id <> OLD.id
      AND instr(',' || replace(role, ' ', '') || ',', ',owner,') > 0
  )
BEGIN
  SELECT RAISE(ABORT, 'last_owner_required');
END;
--> statement-breakpoint
CREATE TRIGGER member_last_owner_update
BEFORE UPDATE OF role, organization_id, user_id ON member
WHEN instr(',' || replace(OLD.role, ' ', '') || ',', ',owner,') > 0
  AND (instr(',' || replace(NEW.role, ' ', '') || ',', ',owner,') = 0
    OR NEW.organization_id <> OLD.organization_id OR NEW.user_id <> OLD.user_id)
  AND NOT EXISTS (
    SELECT 1 FROM member
    WHERE organization_id = OLD.organization_id AND id <> OLD.id
      AND instr(',' || replace(role, ' ', '') || ',', ',owner,') > 0
  )
BEGIN
  SELECT RAISE(ABORT, 'last_owner_required');
END;
