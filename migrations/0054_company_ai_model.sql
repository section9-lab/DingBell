CREATE TABLE company_ai_model_revision (
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision>0),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  key_version TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  execution TEXT CHECK(execution IS NULL OR json_valid(execution)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(organization_id,revision)
);
--> statement-breakpoint
CREATE TRIGGER company_ai_model_revision_immutable BEFORE UPDATE ON company_ai_model_revision BEGIN
  SELECT RAISE(ABORT,'COMPANY_AI_MODEL_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TABLE company_ai_model_test (
  organization_id TEXT PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','passed','failed')),
  tested_at INTEGER NOT NULL,
  next_test_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE company_ai_model_audit (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('save','test')),
  revision INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
