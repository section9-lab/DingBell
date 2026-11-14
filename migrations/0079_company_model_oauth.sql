-- Company model connections can use either an API key or an OAuth credential.
-- The revision keeps an immutable snapshot envelope; the credential table owns the
-- mutable token that may rotate on refresh.
ALTER TABLE company_ai_model_revision ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'api_key'
  CHECK(auth_type IN ('api_key','oauth'));
--> statement-breakpoint
CREATE TABLE company_ai_model_credential (
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK(auth_type IN ('api_key','oauth')),
  credential_version INTEGER NOT NULL CHECK(credential_version>0),
  key_version TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  expires_at INTEGER,
  account_label TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(organization_id,provider)
);
--> statement-breakpoint
-- Short-lived device-code login state. The device code is encrypted at rest and
-- never returned to the browser; only the user code and verification URL are.
CREATE TABLE company_ai_model_auth_session (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','complete','failed','expired')),
  device_code_key_version TEXT NOT NULL,
  device_code_nonce TEXT NOT NULL,
  device_code_ciphertext TEXT NOT NULL,
  user_code TEXT NOT NULL,
  verification_uri TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL CHECK(interval_seconds BETWEEN 1 AND 60),
  expires_at INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL,
  failure_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX company_ai_model_auth_session_org_idx
  ON company_ai_model_auth_session(organization_id,created_at);
