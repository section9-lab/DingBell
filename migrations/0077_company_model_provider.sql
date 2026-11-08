-- Company models can now reference a bundled Pi provider instead of a hand-typed gateway.
-- Existing rows keep working as an explicit custom OpenAI-compatible connection.
ALTER TABLE company_ai_model_revision ADD COLUMN provider TEXT NOT NULL DEFAULT 'custom';
--> statement-breakpoint
ALTER TABLE company_ai_model_revision ADD COLUMN api TEXT NOT NULL DEFAULT 'openai-completions';
