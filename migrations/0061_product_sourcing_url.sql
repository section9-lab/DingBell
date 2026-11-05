-- Procurement link for the merchant-maintained sourcing facts. Kept optional: many supplies are
-- recorded by name only, and no URL is ever read from or written to the platform.
ALTER TABLE product_sourcing ADD COLUMN purchase_url text CONSTRAINT product_sourcing_url_length CHECK(purchase_url IS NULL OR (length(purchase_url) BETWEEN 1 AND 2048));
