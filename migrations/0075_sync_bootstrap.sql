-- 0075: one-time bootstrap markers for initial Ozon synchronization.
-- The global row `startup` runs once per deployment. Per-store rows prevent a
-- restart or a repeated scheduled tick from re-seeding an already bootstrapped store.
CREATE TABLE `sync_bootstrap` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`last_error` text,
	CONSTRAINT "sync_bootstrap_time_valid" CHECK(
		("started_at" IS NULL OR typeof("started_at")='integer' AND "started_at" BETWEEN 0 AND 8640000000000000)
		AND ("completed_at" IS NULL OR typeof("completed_at")='integer' AND "completed_at" BETWEEN 0 AND 8640000000000000))
);
