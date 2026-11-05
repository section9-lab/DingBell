-- Versioned merchant assumptions. Inputs only; profit is always derived.
CREATE TABLE accounting_rule (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL, store_id TEXT NOT NULL,
  effective_at INTEGER NOT NULL, valid_from TEXT NOT NULL,
  inputs TEXT NOT NULL CHECK(json_valid(inputs) AND json_type(inputs)='object'),
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
  FOREIGN KEY(store_id,organization_id) REFERENCES store(id,organization_id) ON DELETE CASCADE,
  UNIQUE(store_id,effective_at)
);
--> statement-breakpoint
CREATE INDEX accounting_rule_scope ON accounting_rule(organization_id,store_id,effective_at);
--> statement-breakpoint
CREATE TRIGGER accounting_rule_immutable BEFORE UPDATE ON accounting_rule
BEGIN SELECT RAISE(ABORT,'ACCOUNTING_RULE_IMMUTABLE'); END;
--> statement-breakpoint
-- Freeze atomic assumptions, not derived profit. The fulfillment lane and product line order
-- belong to the identity: equal parcel numbers in different lanes must not share a basis.
CREATE TABLE accounting_posting_basis (
  organization_id TEXT NOT NULL, store_id TEXT NOT NULL, fulfillment TEXT NOT NULL CHECK(fulfillment IN ('fbs','fbo','fbp')),
  posting_number TEXT NOT NULL,
  sale_identity TEXT NOT NULL,
  inputs TEXT NOT NULL CHECK(json_valid(inputs) AND json_type(inputs)='object'),
  captured_at INTEGER NOT NULL, captured_by TEXT NOT NULL,
  PRIMARY KEY(store_id,fulfillment,posting_number),
  FOREIGN KEY(store_id,organization_id) REFERENCES store(id,organization_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TRIGGER accounting_basis_immutable BEFORE UPDATE ON accounting_posting_basis
BEGIN SELECT RAISE(ABORT,'ACCOUNTING_BASIS_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TABLE accounting_expense (
  id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL, store_id TEXT NOT NULL,
  expense_date TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN ('advertising','other')),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0), note TEXT NOT NULL CHECK(length(note) BETWEEN 1 AND 200),
  created_at INTEGER NOT NULL, created_by TEXT NOT NULL, voided_at INTEGER, voided_by TEXT,
  FOREIGN KEY(store_id,organization_id) REFERENCES store(id,organization_id) ON DELETE CASCADE,
  CHECK((voided_at IS NULL)=(voided_by IS NULL))
);
--> statement-breakpoint
CREATE INDEX accounting_expense_period ON accounting_expense(organization_id,store_id,expense_date);
--> statement-breakpoint
-- Closing the previous version and opening the next version are a single SQL write.
-- An authorization expiry cannot leave a closed window without its replacement.
CREATE TRIGGER product_costing_no_overlap BEFORE INSERT ON product_costing
BEGIN
  UPDATE product_costing SET valid_to=NEW.valid_from
    WHERE organization_id=NEW.organization_id AND store_id=NEW.store_id AND product_id=NEW.product_id
      AND valid_to IS NULL AND valid_from<NEW.valid_from AND NEW.valid_to IS NULL;
  SELECT RAISE(ABORT,'PRODUCT_COSTING_OVERLAP') WHERE EXISTS(
    SELECT 1 FROM product_costing c WHERE c.store_id=NEW.store_id AND c.product_id=NEW.product_id
      AND c.valid_from<COALESCE(NEW.valid_to,8640000000000001) AND NEW.valid_from<COALESCE(c.valid_to,8640000000000001));
END;
