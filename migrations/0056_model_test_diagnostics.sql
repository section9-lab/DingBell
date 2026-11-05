-- Keep past test results. Never persist raw provider error bodies or credentials.
ALTER TABLE company_ai_model_test ADD COLUMN failure_code TEXT
  CHECK(failure_code IS NULL OR failure_code IN ('credentials_unavailable','url_rejected','unauthorized','forbidden','not_found','request_rejected','rate_limited','provider_unavailable','redirect_refused','timed_out','network_error','invalid_response','output_limit','tool_call_missing','tool_call_invalid','test_failed'));
--> statement-breakpoint
ALTER TABLE company_ai_model_test ADD COLUMN provider_status INTEGER
  CHECK(provider_status IS NULL OR (typeof(provider_status)='integer' AND provider_status BETWEEN 100 AND 599));
