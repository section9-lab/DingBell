-- A reply policy serves exactly one business stage: config `stages: [...]` becomes `stage: "..."`.
-- Published versions are immutable by trigger, so the trigger is lifted for the rewrite only and
-- recreated byte-identical to 0023_reply_policies.sql. Rows already using `stage` are untouched.
DROP TRIGGER `policy_version_immutable_update`;
--> statement-breakpoint
UPDATE `reply_policy` SET `draft_config`=json_set(json_remove(`draft_config`,'$.stages'),'$.stage',json_extract(`draft_config`,'$.stages[0]'))
WHERE json_type(`draft_config`,'$.stages')='array' AND json_array_length(`draft_config`,'$.stages')>0;
--> statement-breakpoint
UPDATE `policy_version` SET `config`=json_set(json_remove(`config`,'$.stages'),'$.stage',json_extract(`config`,'$.stages[0]'))
WHERE json_type(`config`,'$.stages')='array' AND json_array_length(`config`,'$.stages')>0;
--> statement-breakpoint
CREATE TRIGGER policy_version_immutable_update BEFORE UPDATE ON policy_version
BEGIN SELECT RAISE(ABORT,'policy version is immutable'); END;
