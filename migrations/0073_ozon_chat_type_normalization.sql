-- Ozon documents chat_type as PascalCase ("Buyer_Seller", and "Buyer_Sueller" in its own
-- text) while some responses use upper case. Parsing now normalizes the value at the API
-- boundary; this backfills rows imported before that change so authorization predicates and
-- reply gates see one canonical value. Idempotent and limited to the two known chat types.
UPDATE conversation SET platform_type='BUYER_SELLER'
WHERE upper(platform_type)='BUYER_SELLER' AND platform_type<>'BUYER_SELLER';
--> statement-breakpoint
UPDATE conversation SET platform_type='BUYER_SELLER'
WHERE upper(platform_type)='BUYER_SUELLER' AND platform_type<>'BUYER_SELLER';
--> statement-breakpoint
UPDATE conversation SET platform_type='SELLER_SUPPORT'
WHERE upper(platform_type)='SELLER_SUPPORT' AND platform_type<>'SELLER_SUPPORT';
