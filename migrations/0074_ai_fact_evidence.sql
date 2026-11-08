-- 0074: append-only product/order fact evidence for the support-agent reply contract.
-- A fact read by the agent is frozen per run. send_message may only reference an id from
-- this table, and the sender re-reads the same fact before delivery. Rows never change.

CREATE TABLE `ai_fact_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`snapshot` text NOT NULL,
	`observed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `ai_execution`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ai_fact_evidence_scope_valid" CHECK(length("organization_id") BETWEEN 1 AND 256 AND length("store_id") BETWEEN 1 AND 256 AND length("conversation_id") BETWEEN 1 AND 256),
	CONSTRAINT "ai_fact_evidence_kind_valid" CHECK("kind" IN ('product','order')),
	CONSTRAINT "ai_fact_evidence_ref_valid" CHECK(length("ref") BETWEEN 1 AND 256),
	CONSTRAINT "ai_fact_evidence_hash_valid" CHECK(length("snapshot_hash")=64 AND "snapshot_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "ai_fact_evidence_snapshot_valid" CHECK(json_valid("snapshot") AND json_type("snapshot")='object'),
	CONSTRAINT "ai_fact_evidence_time_valid" CHECK(typeof("observed_at")='integer' AND "observed_at" BETWEEN 0 AND 8640000000000000 AND typeof("created_at")='integer' AND "created_at" BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE INDEX `ai_fact_evidence_run_idx` ON `ai_fact_evidence` (`run_id`,`kind`,`ref`);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_fact_evidence_snapshot_unique` ON `ai_fact_evidence` (`run_id`,`kind`,`ref`,`snapshot_hash`);
--> statement-breakpoint
CREATE TRIGGER ai_fact_evidence_immutable BEFORE UPDATE ON ai_fact_evidence
BEGIN SELECT RAISE(ABORT,'AI_FACT_EVIDENCE_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER ai_fact_evidence_no_delete BEFORE DELETE ON ai_fact_evidence
BEGIN SELECT RAISE(ABORT,'AI_FACT_EVIDENCE_IMMUTABLE'); END;
