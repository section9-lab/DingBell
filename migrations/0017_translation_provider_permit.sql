ALTER TABLE `reply_preview_run` ADD `provider_request_claimed_at` integer
  CONSTRAINT "reply_preview_provider_permit_valid" CHECK("provider_request_claimed_at" IS NULL OR (typeof("provider_request_claimed_at")='integer' AND "provider_request_claimed_at" BETWEEN "created_at" AND 8640000000000000 AND "settlement"<>'released'));
--> statement-breakpoint
CREATE TRIGGER reply_preview_provider_permit_immutable BEFORE UPDATE OF provider_request_claimed_at ON reply_preview_run
WHEN OLD.provider_request_claimed_at IS NOT NULL AND NEW.provider_request_claimed_at IS NOT OLD.provider_request_claimed_at
BEGIN SELECT RAISE(ABORT,'TRANSLATION_PROVIDER_PERMIT_IMMUTABLE'); END;
