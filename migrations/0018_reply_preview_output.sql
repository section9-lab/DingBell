CREATE TABLE `reply_preview_output` (
	`run_id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`body_hash` text NOT NULL,
	`receipt` text NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `reply_preview_run`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reply_preview_output_body_valid" CHECK(length("reply_preview_output"."body") BETWEEN 1 AND 1000 AND length("reply_preview_output"."body_hash")=64 AND "reply_preview_output"."body_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "reply_preview_output_receipt_valid" CHECK(json_valid("reply_preview_output"."receipt") AND json_type("reply_preview_output"."receipt")='object'),
	CONSTRAINT "reply_preview_output_time_valid" CHECK(typeof("reply_preview_output"."recorded_at")='integer' AND "reply_preview_output"."recorded_at" BETWEEN 0 AND 8640000000000000)
);
--> statement-breakpoint
CREATE TRIGGER reply_preview_output_ready BEFORE INSERT ON reply_preview_output
WHEN NOT EXISTS (SELECT 1 FROM reply_preview_run WHERE id=NEW.run_id AND receipt=NEW.receipt AND settlement<>'released' AND NEW.recorded_at>=created_at)
BEGIN SELECT RAISE(ABORT,'TRANSLATION_OUTPUT_NOT_READY'); END;
--> statement-breakpoint
CREATE TRIGGER reply_preview_output_exists BEFORE INSERT ON reply_preview_output
WHEN EXISTS (SELECT 1 FROM reply_preview_output WHERE run_id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'TRANSLATION_OUTPUT_EXISTS'); END;
--> statement-breakpoint
CREATE TRIGGER reply_preview_output_immutable BEFORE UPDATE ON reply_preview_output
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.body IS NOT OLD.body OR NEW.body_hash IS NOT OLD.body_hash OR NEW.receipt IS NOT OLD.receipt OR NEW.recorded_at IS NOT OLD.recorded_at
BEGIN SELECT RAISE(ABORT,'TRANSLATION_OUTPUT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER reply_preview_output_release_guard BEFORE UPDATE OF settlement ON reply_preview_run
WHEN NEW.settlement='released' AND EXISTS (SELECT 1 FROM reply_preview_output WHERE run_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'TRANSLATION_OUTPUT_ALREADY_RECORDED'); END;
