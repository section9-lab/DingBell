# Platform capability probe

This isolated stage-one probe checks Cloudflare R2, Queues and Cron Triggers. It contains only synthetic fixtures and never connects a shop, sends a customer message or invokes an AI model. It uses the existing Flue 2.2.2 Vite customizer: HTTP routes live in `src/app.ts`; a SQLite-backed Durable Object plus native `queue` and `scheduled` handlers live in `src/cloudflare.ts`. It introduces no dependency, D1 database or application scheduler.

## What the checks prove

| Check | Required observation |
| --- | --- |
| Authentication | Health is public; all application `/__probe/*` controls reject absent/incorrect Bearer tokens; a missing deployment secret fails closed. |
| R2 | Put a fixed synthetic object, verify metadata using `head`, read matching bytes and SHA-256, delete, then observe both `get` and `head` missing. Keys are restricted to `synthetic/<UUID-v4>/fixture.txt`. |
| Queue deduplication | Three distinct native messages share one business key; the real consumer records three deliveries and one atomic synthetic effect in the DO. |
| Queue retry | The first attempt explicitly retries; a native redelivery with the same message ID succeeds. |
| Dead letter | A poison message fails all three attempts (`max_retries: 2`); Cloudflare's queue machinery forwards it to the separately configured DLQ and its real consumer records it. The app never sends directly to the DLQ. |
| Cron | A new native scheduled invocation increases a persistent counter, with the actual cron expression, scheduled time and observation time available over an authenticated read endpoint. |
| Isolation | Removing the R2 binding leaves Queue/Cron checks usable; SQLite state survives a local Worker restart. |

Local workerd results establish local contracts only. Cloud acceptance additionally needs real resources, delivery and Cron invocation. The synthetic effect and deduplication record share a DO transaction; this does **not** prove exactly-once delivery to an external commerce API.

## Local verification

From the repository root:

```sh
node --test --test-concurrency=1 tests/integration/platform.test.ts
node node_modules/typescript/bin/tsc --noEmit -p probes/platform/tsconfig.json
```

The integration suite builds the Flue-generated Worker, runs the installed Wrangler 4.116.0 locally with remote bindings disabled, uses disposable local storage, and removes the process tree and storage afterward. It checks both the complete binding set and a deployment without R2. Its random test token is not a cloud secret.

For an interactive local run:

```sh
node node_modules/vite/bin/vite.js build --config probes/platform/vite.config.ts
node node_modules/wrangler/bin/wrangler.js dev \
  --config probes/platform/dist/dingbell_platform_probe/wrangler.json \
  --bundle --local --test-scheduled \
  --ip 127.0.0.1 --port 8790 --inspector-port 0 \
  --var PROBE_TOKEN:local-synthetic-test-token
```

In a second terminal:

```sh
DINGBELL_PLATFORM_URL=http://127.0.0.1:8790 \
DINGBELL_PLATFORM_TOKEN=local-synthetic-test-token \
node probes/platform/run-check.ts --local
```

The installed Wrangler exposes its development-only `/__scheduled?cron=...` endpoint with `--test-scheduled`. The Vite output normally sets `no_bundle: true`; `--bundle` is needed locally for Wrangler to inject that test middleware. No corresponding trigger endpoint exists in application code or in the deployed Worker. The newer documentation's `/cdn-cgi/local/scheduled` endpoint was unavailable in the repository's pinned toolchain during validation; this probe follows the installed official Wrangler implementation instead of imitating Cron with an application route.

## Cloud configuration and runner

Deployment is a separate operator action. This README and the integration suite do not deploy or create resources. Use a dedicated probe Worker and queues. Set the following **build-time** variables when resource names differ:

| Variable | Default / effect |
| --- | --- |
| `DINGBELL_PLATFORM_QUEUE` | `dingbell-platform-probe` |
| `DINGBELL_PLATFORM_DLQ` | `dingbell-platform-probe-dlq`; must be a different queue |
| `DINGBELL_PLATFORM_BUCKET` | `dingbell-platform-probe`, used only when R2 is enabled |
| `DINGBELL_PLATFORM_SKIP_R2=1` | Omits the R2 binding entirely; no R2 resource is required |
| `DINGBELL_PLATFORM_CRON` | Unset means `crons: []`; set `* * * * *` only for a temporary cloud observation |

For the current account, cloud R2 remains **NOT_RUN**: subscription enablement has been deferred. Build the cloud queue/cron probe without R2:

```sh
DINGBELL_PLATFORM_SKIP_R2=1 DINGBELL_PLATFORM_CRON='* * * * *' \
node node_modules/vite/bin/vite.js build --config probes/platform/vite.config.ts
```

The generated deployment configuration is `probes/platform/dist/dingbell_platform_probe/wrangler.json`. Supply `PROBE_TOKEN` as a Worker secret using the normal Cloudflare operator workflow; build output never embeds `DINGBELL_PLATFORM_TOKEN`. There is no hardcoded account ID. The queue consumer retry and DLQ configuration is part of the generated configuration. Only the main queue has a producer binding.

After an operator provisions and deploys the probe, provide its URL and token through environment variables, then run:

```sh
node probes/platform/run-check.ts --mode queue-cron --cron-timeout-ms 180000
```

`DINGBELL_PLATFORM_URL` and `DINGBELL_PLATFORM_TOKEN` are required. The runner uses exactly the same authenticated checks as the local suite. Cloud mode never invokes an HTTP scheduling endpoint: it snapshots the counter and waits for a **new** actual Cron event. Existing historical counts do not satisfy the check. Trigger changes can take up to 15 minutes to propagate; after propagation, rerun the observation if it times out. Do not count a timeout as a cloud pass. Omitting `--mode queue-cron` additionally requires R2 checks and is appropriate only after R2 has actually been enabled.

Disable the temporary frequent trigger after validation: rebuild without `DINGBELL_PLATFORM_CRON` and have the operator redeploy the generated `crons: []` configuration. Confirm the deployed trigger list is empty. R2 fixtures are deleted by the runner even after assertion failures when the binding remains reachable. Queue/cron evidence remains in the dedicated probe DO; remove the dedicated probe Worker and its resources when the evidence is no longer needed. Do not delete product resources.

## Evidence boundaries and references

The probe does not establish production throughput, regional behavior, external API idempotency, recovery after an acknowledged remote side effect, or a production retention policy. Those remain separate application acceptance criteria.

Official references, checked 2026-10-08:

- [Flue Cloudflare composition](https://flueframework.com/docs/guide/cloudflare-target/)
- [Cloudflare Queue configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/)
- [Cloudflare Queue local development](https://developers.cloudflare.com/queues/configuration/local-development/)
- [Cloudflare Queue retries and dead letters](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
- [Cloudflare Cron Triggers and local testing](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- Installed `node_modules/wrangler/templates/middleware/middleware-scheduled.ts` and Wrangler CLI `dev --help` are the precise local endpoint contract for the pinned Wrangler version.
