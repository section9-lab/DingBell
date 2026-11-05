-- Remove the vector-index and reply-test subsystems: knowledge retrieval is now
-- text-only (grep/read over stored markdown), and the reply-test budget/run/query
-- machinery is dropped entirely. The full markdown body of each knowledge
-- revision is stored directly on knowledge_revision for read-only retrieval.
ALTER TABLE knowledge_revision ADD markdown text;

--> statement-breakpoint
DROP TABLE knowledge_index_job;
--> statement-breakpoint
DROP TABLE knowledge_index_usage;
--> statement-breakpoint
DROP TABLE knowledge_review_job;
--> statement-breakpoint
DROP TABLE knowledge_vector_cleanup;
--> statement-breakpoint
DROP TABLE ai_knowledge_query;
--> statement-breakpoint
DROP TABLE reply_test_budget_audit;
--> statement-breakpoint
DROP TABLE reply_test_query;
--> statement-breakpoint
DROP TABLE reply_test_query_usage;
--> statement-breakpoint
DROP TABLE reply_test_run;
--> statement-breakpoint
DROP TABLE reply_test_budget;
