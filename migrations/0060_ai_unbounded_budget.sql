-- AI reception no longer requires a maintained budget: admission falls back to one unbounded row
-- per company. That row must not occupy the single-window slot merchants use for their own budgets,
-- so the overlap trigger and the API-level overlap check both ignore the reserved `ai-unbounded-` id.
DROP TRIGGER IF EXISTS ai_budget_overlap;
--> statement-breakpoint
CREATE TRIGGER ai_budget_overlap BEFORE INSERT ON ai_budget
WHEN NEW.id NOT LIKE 'ai-unbounded-%'
 AND EXISTS (SELECT 1 FROM ai_budget WHERE organization_id=NEW.organization_id AND id NOT LIKE 'ai-unbounded-%' AND starts_at<NEW.ends_at AND ends_at>NEW.starts_at)
BEGIN SELECT RAISE(ABORT,'AI_BUDGET_OVERLAP'); END;
