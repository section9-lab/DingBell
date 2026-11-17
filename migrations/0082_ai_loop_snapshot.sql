-- The Agent loop lived only in the runtime ledger, which is closed once a run ends, so the
-- conversation panel showed "no execution record" right after the answer. Persist the last
-- snapshot per run so it stays visible while pending and after completion.
CREATE TABLE `ai_loop_snapshot` (
	`run_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "ai_loop_snapshot_payload_valid" CHECK(json_valid(`payload`) AND json_type(`payload`)='object' AND length(CAST(`payload` AS BLOB)) BETWEEN 2 AND 65536)
);
--> statement-breakpoint
CREATE INDEX `ai_loop_snapshot_conversation_idx` ON `ai_loop_snapshot` (`organization_id`,`store_id`,`conversation_id`,`created_at`);
