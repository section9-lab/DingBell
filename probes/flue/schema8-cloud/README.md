# Authentic schema 8 Cloudflare fixture

These two isolated projects exercise a real historical Flue release followed by the current release against the same Durable Object identity. They are not product applications and use only synthetic text. Do not run `npm install` in the repository directories or deploy either project as DingBell production.

| Dependency / identity | Legacy | Current |
| --- | --- | --- |
| `@flue/runtime`, `@flue/vite` | `2.0.0-nightly.202607240825` | `2.2.2` |
| `@earendil-works/pi-ai` | `0.81.1` | `0.87.1` |
| Agents / Cloudflare plugin / Wrangler | `0.20.1` / `1.49.0` / `4.116.0` | Same |
| Vite / Hono | `8.1.2` / `4.12.32` | Same |
| Worker | `dingbell-flue-schema8-probe` | Same |
| Agent / DO class | `HistoricalProbe` / `FlueHistoricalProbeAgent` | Same |
| Binding / migration | `FLUE_HISTORICAL_PROBE_AGENT` / `v1` | Same |

Both package lockfiles pin transitive dependencies and official registry integrity values. The old release natively creates schema 8; no script reads or edits Flue's private tables. Its config does not accept the newer `tracing` option, so only the current project sets `tracing: false`. Neither project configures an external telemetry exporter. There are no real model credentials or requests.

The legacy faux provider returns a fixed answer. The current provider deliberately throws on generation: it must read the stored answer, and cannot manufacture a replacement during upgrade. This fixture verifies an already completed submission, not recovery of an old running submission. The old release predates `idempotencyKey`; no cross-version keyed replay is claimed.

## Prepare and test locally

From the repository root, copy both projects into a new directory outside the repository. Node 24.14 or the repository's pinned compatible Node version is required.

```sh
DINGBELL_SCHEMA8_WORKSPACE="$(mktemp -d "${TMPDIR:-/tmp}/dingbell-schema8-cloud.XXXXXX")"
cp -R probes/flue/schema8-cloud/legacy "$DINGBELL_SCHEMA8_WORKSPACE/cloud-legacy"
cp -R probes/flue/schema8-cloud/current "$DINGBELL_SCHEMA8_WORKSPACE/cloud-current"
(
  cd "$DINGBELL_SCHEMA8_WORKSPACE/cloud-legacy"
  npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
  node node_modules/vite/bin/vite.js build
)
(
  cd "$DINGBELL_SCHEMA8_WORKSPACE/cloud-current"
  npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
  node node_modules/vite/bin/vite.js build
)
node probes/flue/schema8-cloud/local-check.mjs "$DINGBELL_SCHEMA8_WORKSPACE"
```

The local runner creates a random in-memory test token, uses the same local DO persistence directory for both processes, and shuts down each complete process group. Health must identify the expected runtime and its public adapter constant: legacy `FLUE_SCHEMA_VERSION = 8`, current `FLUE_FORMAT_VERSION = 1`. It reads the original receipt after switching versions without a new POST. Every old message field must remain unchanged; the current HTTP projection may add timestamps. It also compares the generated Worker name, bindings, migrations and compatibility settings. Evidence is saved to `cloud-local-evidence.json` in the prepared workspace; it contains synthetic records, not the token. No cloud operation occurs.

## Explicit cloud upgrade check

First verify the dedicated Worker name is available or belongs to this specific fixture. Use one intended test account for both deployments. Put a random `PROBE_TOKEN` of at least 32 characters in an owner-readable JSON file outside the repository and set `DINGBELL_PROBE_SECRET_FILE` to that file path. Do not put its value in command arguments. Preview URLs are disabled; all fixture/history endpoints require the token, and only health is public.

Deploy the legacy artifact using the existing authenticated Wrangler installation:

```sh
node node_modules/wrangler/bin/wrangler.js deploy \
  --config "$DINGBELL_SCHEMA8_WORKSPACE/cloud-legacy/dist/dingbell_flue_schema8_probe/wrangler.json" \
  --secrets-file "$DINGBELL_PROBE_SECRET_FILE" --autoconfig=false
node probes/flue/schema8-cloud/cloud-check.mjs before \
  "$DINGBELL_SCHEMA8_ORIGIN/" "$DINGBELL_SCHEMA8_CHECKPOINT"
```

`DINGBELL_SCHEMA8_ORIGIN` must be the dedicated `https://dingbell-flue-schema8-probe.<your-subdomain>.workers.dev` origin, without a trailing slash in the variable. The checkpoint path must be new. Before either phase proceeds, the runner makes bounded read-only health checks for up to 60 seconds, waiting for the correct service, runtime variant/version and public storage-format constant. A deployment success alone is insufficient during propagation. The subsequent missing/wrong-token checks still require exactly 401; 404 is a failure. Record the deployment version, then deploy the current artifact with the same account, Worker identity, migration history and secret:

```sh
node node_modules/wrangler/bin/wrangler.js deploy \
  --config "$DINGBELL_SCHEMA8_WORKSPACE/cloud-current/dist/dingbell_flue_schema8_probe/wrangler.json" \
  --secrets-file "$DINGBELL_PROBE_SECRET_FILE" --autoconfig=false
node probes/flue/schema8-cloud/cloud-check.mjs after \
  "$DINGBELL_SCHEMA8_ORIGIN/" "$DINGBELL_SCHEMA8_CHECKPOINT"
```

The `after` phase confirms current runtime `2.2.2` and public format `1` before reading the original receipt, performs GETs only, and writes `<checkpoint>.after.json` including the observed health. Pair it with both deployment version IDs and the source/build hashes; the runner does not deploy. These scripts preserve the synthetic historical record for inspection. They do not exercise cloud rollback, delete all fixture data, test unknown future storage versions, or verify product tenant isolation.
