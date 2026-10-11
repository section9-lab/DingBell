# Grounded reply quality evaluation

This isolated evaluation reuses Flue's Node/SQLite runtime, the pinned NVIDIA SDK, the application's exact `replyTestInstructions`, output schema and bounded SSE transport. It sends synthetic prompts only. It does not open a store connection, run order/refund tools, send customer messages or activate the application's AI setting.

The fixed corpus contains **200 synthetic cases in 40 authored families, with five deterministic wording/fact variants per family**: 60 presale, 50 order-status, 50 aftersales and 40 safety cases. These are not 200 independent real customer conversations. Each case records reference facts, expected decision, visible document/revision/body hashes, required review criteria and language. Two families exercise Russian facts rendered into Chinese. Unknown shipping, missing inventory, refund authority, order uncertainty, explicit human requests, prompt injection and unsupported external operations remain visible in the results.

## Commands

Prepare the versioned corpus without a model call:

```sh
node probes/reply-quality/run.ts prepare test-results/reply-quality-corpus.json
node --test --test-concurrency=1 tests/reply-quality.test.ts tests/reply-quality-runtime.test.ts
```

Collect an explicitly selected batch, using the existing NVIDIA trial credential from the local ignored `.env` file:

```sh
DINGBELL_REPLY_QUALITY=1 DINGBELL_REPLY_CASES=width-1,refund-request-1,human-request-1 DINGBELL_REPLY_REPEAT=1 node --env-file=.env probes/reply-quality/run.ts collect test-results/reply-quality-batch-01
```

The destination must not exist. Selection is required, unique, at most 24 cases, with an explicit repetition number 1–3. The model is pinned to `nvidia/nemotron-3-super-120b-a12b`; only the official NVIDIA chat endpoint is allowed. No credentials are put in command arguments or evaluation JSON. The caller supplies the environment; the runner does not implicitly load `.env`. Batches wait at least one second between cases.

The default prompt is the candidate `grounded-reply-v2`, which has **not** passed release evaluation. Set `DINGBELL_REPLY_PROMPT_VERSION=grounded-reply-v1` to reproduce or report the preserved original version. Never mix prompt versions in one report. The application chooses the version from each frozen run's configuration; this evaluator does not change deployment configuration or silently upgrade existing runs.

Each case has at most one allowed generation and one HTTP request, 2,048 output tokens, a 45-second transport limit, disabled SDK retries, disabled thinking and no tools. The native task declaration is removed from the outgoing request, matching the application provider. A journal is flushed before network dispatch; per-case results are saved before moving on. Provider failure, truncation or an unconfirmed response stops the batch without automatic retry or model substitution. A process deadline leaves original attempt records for inspection. Never infer that a missing result means no request occurred, and never overwrite a failed run to hide it.

The [NVIDIA prototyping documentation](https://docs.api.nvidia.com/nim/docs/run-anywhere) describes developer access for testing; this does not establish this account's remaining allowance or production billing. The evaluator uses the previously authorized trial key, does not purchase credits, and reports actual tokens when present. Cost remains **unpriced**, not zero. Model setup was checked against the [official model guide](https://docs.nvidia.com/nim/large-language-models/2.0.4/turbo/get-started-nemotron-3-super-120b-a12b.html); generation parameters match the current application, and must be versioned if changed.

## Review and limits

Output constraints are a separate version from the prompt. The default model configuration remains `nvidia-reply-test-v1` to preserve archived plan hashes. Set `DINGBELL_REPLY_MODEL_CONFIG_VERSION=nvidia-reply-test-v2` explicitly for `prepare`, `collect` and `report` to use the application-derived `guided_json` contract. New plans retain that version and the full constraint parameters; reports cannot mix constrained and original runs. A changed contract is rejected before dispatch, and a provider rejection never falls back to unconstrained generation. JSON shape does not establish factual correctness, the right decision category or a completed handoff.

Each new batch retains its exact corpus/prompt hash, selected cases, Flue execution identity and receipt, journal, SSE evidence, output, latency, HTTP status and token report. Files and the synthetic SQLite database use restricted local permissions. `human-review.json` starts with blank fact, policy, language and false-action-claim assessments. Blank values are pending, never passes. Keep reviewer identity and notes with the output hash.

Aggregate compatible, nonoverlapping batches offline:

```sh
node probes/reply-quality/run.ts report test-results/reply-quality-report.json test-results/reply-quality-batch-01 test-results/reply-quality-batch-02
```

Reports reject changed model/prompt/corpus, repeated case/repetition identities, malformed evidence and mismatched captured output. They report missing cases and P0 cases without three repetitions. Programmatic checks cover valid output shape, expected decision/reason, traceable source excerpts, language presence and exact injection markers. They **do not measure semantic correctness**, natural Russian, policy compliance in prose or achieved handoff. Matching a quote does not show that the answer follows from it. The release flag stays false: complete coverage, independent Russian review, fact accuracy ≥95%, all P0 cases, three-run stability and actual tool/state integration remain separate acceptance requirements in `docs/03-acceptance.md` §12.

This harness evaluates generation from fixed visible excerpts, not retrieval quality or the Cloudflare execution environment. Existing native runtime, authorization, knowledge freshness and handoff/send gates require their own integration evidence. A model decision of `handoff` is a suggestion; no ticket or transfer is executed here.
