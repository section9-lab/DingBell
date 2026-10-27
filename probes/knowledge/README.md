# Knowledge semantic evaluation

This isolated benchmark uses fictional Chinese/Russian ecommerce facts, the application's chunker and its fixed BGE-M3 embedding adapter. It measures local exact-cosine ranking across the declared knowledge language. It does not deploy a Worker, create an index, use customer data, publish knowledge, or generate/send replies.

There are 20 documents and 52 questions: 40 answerable, including four cross-language queries and two facts placed near the end of multi-chunk manuals, plus 12 difficult negatives requiring unavailable order, stock, discount or personal approval facts. Similar model names such as OR26/OR26X and L5/L5 Pro are deliberately distinct. Calibration and holdout each contain 20 answerable and six unsupported questions. The split is fixed before collection; it is an authored regression corpus, not an independently reviewed customer distribution or the phase-six 200-case answer evaluation.

Question/reference labels and corpus content are in `cases.ts`. Embedding inputs contain only production-prepared chunks or the exact question, never its reference answer. A plan hash binds the corpus, labels, model/profile, exact inputs and declared scoring settings. Artifacts from another plan, missing/duplicate rows, invalid dimensions and nonfinite/zero vectors are rejected. Vector row order does not determine text identity.

## Prepare and inspect without model calls

From the repository root, choose new output paths; existing files are never overwritten:

```sh
node probes/knowledge/run.ts prepare test-results/semantic-plan.json
npm run test:knowledge-evaluation-local
```

The current plan has 75 inputs, at most 128 inputs and 64,000 UTF-8 bytes in total. These are input bounds, not currency limits. No runner reads `.env` itself. `prepare` and `evaluate` do not load Wrangler or contact a model.

## Collect actual embeddings

First verify the intended Cloudflare account and its available allowance/cost authorization. [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) documents a daily allowance and paid overage; a successful login does not prove free quota remains. The runner cannot enforce an account-wide zero-cost guarantee. Keep the model/profile unchanged when comparing reports.

```sh
DINGBELL_KNOWLEDGE_EVAL=1 CLOUDFLARE_ACCOUNT_ID=<authorized-account-id> \
  node probes/knowledge/run.ts collect test-results/semantic-run-unique
```

This uses the installed official Wrangler remote binding and the existing `embedKnowledge` adapter: `@cf/baai/bge-m3`, 1024 dimensions, at most 16 inputs per batch, with truncation disabled. Five batches cover the current plan. The generated BGE-M3 documentation's parameter table currently differs from its `text` usage example; this probe follows the working application adapter and verifies the real returned shape instead of silently changing that contract. [Cloudflare model page](https://developers.cloudflare.com/workers-ai/models/bge-m3/), [publisher model card](https://huggingface.co/BAAI/bge-m3).

The output directory must be new. Each attempt is saved before calling the model; its result is saved before proceeding. A timeout, invalid response or lost capture stops collection without retry or provider fallback. Partial captures remain available, but cannot be scored as a complete dataset. Inspect them before explicitly starting another run; a pending request may already have consumed allowance. A three-minute deadline stops new batches and disposes the proxy. Original capture files are never replaced.

Successful runs save `plan.json`, per-batch attempt/result records, `vectors.json` and `report.json`. All are synthetic-content evidence, with no API tokens. Per-batch timings are request timings, not production latency percentiles; token billing is not inferred from UTF-8 byte counts.

## Re-evaluate captured vectors offline

```sh
node probes/knowledge/run.ts evaluate \
  test-results/semantic-run-unique/vectors.json test-results/semantic-replay.json
```

Input files are limited to 2 MiB. Reports include every question's ranked matches, expected rank/score, and separate calibration/holdout hit@1, hit@3 and reciprocal rank at three. The declared `0.7` threshold is an initial diagnostic, not an accepted production confidence threshold. `unsupportedAboveThreshold` counts unsupported questions with a high-scoring candidate; it is not a measured rate of incorrect generated answers. Do not lower the threshold just to turn a report green.

Cosine similarity does not establish that a passage contains the requested fact. All reports explicitly keep answer quality `not_evaluated`. An artifact's `origin` describes its declared collection source, not cryptographic provider attestation; unit tests use synthetic vectors. Local exact ranking does not prove Vectorize approximate retrieval, production scope filtering, workflow publication, tenant authorization, real merchant accuracy or safe autonomous answers. Those retain their own acceptance gates.

The local command also creates 10,000 synthetic D1-shaped knowledge documents in an OS temporary SQLite database, verifies foreign keys and indexed first/middle keyset pages, prints observational timings, and deletes the database. This directory check makes no embedding/model call and is not D1, Vectorize, semantic-quality or SLA evidence.
