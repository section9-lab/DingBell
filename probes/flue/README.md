# Flue integration probe

This isolated test application exercises Flue 2.2.2 on the Cloudflare runtime with Pi's official faux provider. It returns `fixture-ok` without model credentials or external model requests. It is not a DingBell customer-facing service and must not be deployed as production.

The Vite root, Wrangler configuration, provider registry and generated `FlueProbeAgent` class belong to this directory. The production application's agent scan must not include this directory. No runtime flag switches a production agent to the fixture provider.

## Local checks

Run from the repository root after installing the root dependencies:

```sh
node --test probes/flue/app.test.ts
node_modules/.bin/tsc --noEmit --project probes/flue/tsconfig.json
npm run test:flue
npm run probe:build
```

For manual `npm run probe:dev`, set `DINGBELL_PROBE_TOKEN` to a random secret or put `PROBE_TOKEN` in the ignored `probes/flue/.dev.vars` file. Send it as `Authorization: Bearer <token>`. The integration harness generates its own token. The Vite config only injects the environment token during local serving, never into a build.

The unit tests exercise the Hono route composition with injected runtime operations. `npm run test:flue` starts the actual local Cloudflare runtime and verifies concurrent keyed dispatch, conflicts, completed-result persistence, native abort settlement and interrupted durable-tool recovery. It uses a temporary local Durable Object store and cleans up its processes, loopback test controller and store. The process-group harness is currently verified on macOS.

The local suite also runs the same public-extension interruption/deletion, bounded-submission and contract runners used in the cloud. It verifies a minimal application-owned takeover epoch, including process restart; this is not the complete product authorization or sending pipeline. A separate historical compatibility script verifies authentic Node SQLite data; Cloudflare DO snapshot upgrades remain outside that check. `npm run check` separately verifies that the production artifact excludes this fixture and its HTTP endpoints. Cloud checks are explicit and separate from the default local tests.

## Probe endpoints

| Endpoint | Behavior |
| --- | --- |
| `GET /api/health` | Returns `{ "service": "dingbell-flue-probe", "status": "ok" }`. |
| `POST /__probe/:id/dispatch` | Passes the JSON payload to native `dispatch(Probe, ...)`; the path owns `id`. Returns the native receipt with status 202. |
| `GET /__probe/:id/reply/:submissionId` | Reads the native settled reply using the submission ID. |
| `/agents/probe/*` | Native `createAgentRouter(Probe)` surface, including `POST /agents/probe/:id/abort`. |
| `GET /__probe/:id/lifecycle` | Reads fixture existence, object boot ID, interruption marker and gate evidence. |
| `POST /__probe/:id/lifecycle/interrupt` | Requires a UUID nonce and a waiting fixture; injects one object reset. The reset terminates its RPC, so expect 500 and independently verify recovery. |
| `POST /__probe/:id/lifecycle/release` | Releases the durable test gate. |
| `POST /__probe/:id/lifecycle/destroy` | Requires a released gate and a completed submission ID; calls the public Agents SDK destroy method. Independently verify absence, regardless of the 200/500 RPC response. |
| `GET /__probe/:id/observations` | Returns bounded, live-only submission event metadata from the same DO. No message content or error stacks are retained. |
| `POST /__probe/:id/observations/failure` | Enables or disables a synthetic rejected observer promise to verify failure containment. |
| `POST /__probe/:id/control/run` | Starts one synthetic run and durably binds its original run context to the native submission receipt. |
| `POST /__probe/:id/control/mode` | Advances the application-owned epoch and selects `human` or `ai` without waiting for native settlement. |
| `POST /__probe/:id/control/candidate` | Reads the stored run's submission and checks its original context; returns a decision only and never sends a customer message. |
| `/__probe/:id/bounded/*` | Separate `BoundedProbe` dispatch, reply, inspection, interruption and settled-instance deletion checks. |

Only health is public. Both Agent route families require the Worker `PROBE_TOKEN` secret. A missing server secret returns 503; a missing or incorrect client token returns 401 before reaching Flue. This is test-environment authentication, not the product's identity or organization system.

Use a fresh instance ID per independent test. For idempotency tests, freeze the complete dispatch payload, including `initialData`, and reuse its `idempotencyKey`. Native `FlueError` types and HTTP statuses are retained; stack traces and untyped exception details are excluded from probe responses.

Replay through the same entry point. Native HTTP submission and server-side `dispatch` use different submission kinds; reusing a key across them returns `409 submission_conflict` rather than replaying the receipt.

The faux response queue and counters are memory-only. Persistent-state assertions use Flue receipts and conversation results, not faux provider counters. A settled failed/aborted `read()` returns 409 with only `agent_run_failed` / `agent_run_aborted` and the submission ID; the original error cause and stack stay private.

## Local interruption and abort checks

The synthetic message `fixture:gate` selects a controlled model through Flue's public `useDelivery()` hook. It calls a native durable tool with two `step.do` operations: `prepare`, then `wait`. A loopback HTTP controller in the parent test process records both calls, keyed by instance and tool-call IDs, and holds the `wait` response until released.

- For abort, the test waits until the controller confirms tool execution, calls the native abort endpoint, reads the original submission's aborted settlement and checks that its pending HTTP call was cancelled. Replaying the original key stays aborted; a new keyed submission on the same instance succeeds.
- For recovery, the test waits for tool execution and sends SIGKILL to the entire Worker process group. It restarts with the same local storage while keeping the controller alive. Only GETs are issued before recovery: the same tool-call ID reaches `wait` again, while `prepare` remains recorded exactly once. After releasing the controller, the original submission completes and history still has one user input.

The gate address comes only from the local `DINGBELL_PROBE_GATE_URL` environment and must be HTTP loopback. Vite injects it only during `serve`; a build does not include it. The gate uses the same test token, and the tool propagates its AbortSignal. This loopback path is unavailable in the deployed cloud fixture; the separate cloud-capable gate below uses a binding instead. Client input cannot supply either destination.

Workers fetch uses `redirect: 'manual'` plus status validation to reject redirects; it does not support Node's `redirect: 'error'`. A failed tool produces `fixture-tool-error`, so an interrupted or failed tool cannot accidentally count as a successful fixture answer.

These tests establish the recorded-step contract, not exactly-once external side effects: a side effect completed before its durable checkpoint is saved can still run again. Business-side idempotency and authorization remain required. They also do not prove that native abort is sufficient for human takeover; the business controller must invalidate old candidates independently.

## Public extension interruption and deletion

`fixture:cloud-gate` uses a separate SQLite-backed `ProbeGate` Durable Object through its binding. It stores prepare and wait-entry execution IDs in transactions; status polling does not increment either count. Its binding and additive `v2` migration preserve the existing `FlueProbeAgent` identity and `v1` migration. Only fixture IDs shaped as `lifecycle-<UUID>` can use the lifecycle routes; these routes retain the probe bearer authentication.

Flue's public `extend({ base })` adds test-only inspection, interruption, deletion and observation RPC methods. An interruption writes a nonce and the current boot ID to an application-owned key, calls `storage.sync()` to flush it, then calls `ctx.abort()`. It does not call Flue's semantic abort endpoint or override any runtime lifecycle hook. The runner verifies a new boot ID, the original nonce, the same tool-call ID, one prepare and multiple distinct wait executions. It releases the gate and reads the original submission without redispatching. GET polling can wake the object; this does not independently prove recovery without incoming requests.

After completion, public SDK `destroy()` removes the Flue instance. Its asynchronous object reset may interrupt the RPC after storage deletion: local workerd returned 200, while the cloud returned 500 in the recorded run. Neither response is treated as proof. The runner requires a new boot ID, `getAgentInstance() === null`, a cleared interruption marker and `404 agent_instance_not_found` for the original submission. The `removed` cloud phase repeats absence checks after redeployment without dispatching again.

This is a sequential fixture controller, not a product deletion API or concurrency fence. It does not verify D1/R2/search/export/backup deletion. `ProbeGate` retains synthetic counters as independent evidence; the basic replay fixture is also retained. It is therefore not a cleanup of all probe data.

## Remaining contract probes

`BoundedProbe` has its own stable identity and additive `v3` migration, with `maxAttempts: 1` and `timeoutMs: 3000`. It reuses the deterministic tool while leaving `Probe`'s durability defaults unchanged. `bounded-check.ts` verifies a native submission timeout and a forced reset that exhausts the attempt budget, then verifies terminal failed-key replay and deletion. Timeout and settlement are different timestamps: the native supervisor can settle after the configured deadline. Evidence records both the configured limit and observed settlement delay.

Flue 2.2.2 emits its first `submission_running` event before applying the Agent durability configuration. The event can report the admission default `maxAttempts: 10` even though this Agent is limited to 1. The probe preserves the event and verifies actual enforcement through the terminal `submission_retry_exhausted` result and absence of a second tool execution. Do not use the initial event's limit as effective configuration or business authorization.

`contracts-check.ts` checks discarded receipts, key-length boundaries, native instance-target isolation, failed-key replay, live `observe()` correlation, repeated admission events and contained asynchronous observer failure. Native instance isolation does not prove product tenant authorization. The local suite additionally confirms that process restart does not replay observation history while the original durable result remains readable.

The takeover fixture stores immutable `runId`, `epoch`, `inputRevision` and `policyVersion` in `ProbeGate`, independently of Flue's scheduler. The candidate route takes only a run ID, reads its stored submission and checks the stored context against current control state. A human takeover and later AI resumption invalidate the old run, including after process restart; caller-supplied replacement context cannot authorize the old result. A valid decision reports `sent: false`. Customer delivery, budgets, concurrent business transitions and delayed-abort fencing remain later product tests.

Public format-guard unit tests accept current format 1 and reject unknown/newer markers. They do not prove persisted-data startup rejection or rollback. The upstream store contract suite requires raw version-stamp mutation; this probe does not edit Flue's private tables or present simulated markers as authentic historical data.

## Authentic historical SQLite compatibility

`compatibility-check.ts` runs the official `@flue/runtime@2.0.0-nightly.202607240825` release with its compatible `@earendil-works/pi-ai@0.81.1` provider, installed in a separate directory. That release's public adapter identifies schema 8. Its public `start()` / `sqlite()` / `dispatch()` APIs generate a real historical database; the script never queries or modifies private tables.

Install outside the repository, then run from this repository's root:

```sh
DINGBELL_SCHEMA8_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dingbell-schema8.XXXXXX")"
(
  cd "$DINGBELL_SCHEMA8_DIR"
  npm init -y
  npm install --ignore-scripts --no-audit --no-fund --save-exact \
    --registry=https://registry.npmjs.org \
    @flue/runtime@2.0.0-nightly.202607240825 @earendil-works/pi-ai@0.81.1
)
node probes/flue/compatibility-check.ts "$DINGBELL_SCHEMA8_DIR" "$DINGBELL_SCHEMA8_DIR/check"
```

Each phase runs in a fresh Node process. After clean shutdown and a completed WAL checkpoint, the script preserves an original backup and upgrades a copy with 2.2.2. It reads the original submission ID before any new dispatch, verifies the incarnation UID and every original message field, and requires zero model calls. The newer HTTP projection adds message timestamps; the old message IDs and content must remain unchanged. This genuine nightly predates `idempotencyKey`, so this check does not claim cross-version keyed replay.

The old runtime must reject a copy of the upgraded database with `persisted_schema_version_unsupported`; it must successfully read a restored copy of the original backup. The backup SHA-256 must remain unchanged. Evidence includes exact runtime/provider versions, official registry URLs and integrity values, lockfile/package hashes and database/receipt hashes. It is a Node SQLite compatibility check, not a Cloudflare DO snapshot restore, an unknown future-format database test, or a promise that an old binary can open an upgraded store. No shared dependencies are changed by the script.

## Isolated cloud check

Use a dedicated `dingbell-flue-probe` Worker in the intended test account. Check that it does not belong to another application before the initial deployment. The source config declares its own SQLite DO migration and disables version preview URLs. Do not add customer credentials or data to this fixture.

1. Authenticate using official `wrangler login`; verify the account with `wrangler whoami`.
2. Build with `npm run probe:build`.
3. Prepare an owner-readable JSON secrets file **outside the repository** containing a randomly generated `PROBE_TOKEN` of at least 32 characters. Do not put its value in command arguments or build variables.
4. Deploy with the explicit generated config and `--secrets-file` so the secret and code are uploaded together:

```sh
npx wrangler deploy \
  --config probes/flue/dist/dingbell_flue_probe/wrangler.json \
  --secrets-file "$DINGBELL_PROBE_SECRET_FILE" \
  --autoconfig=false
```

`DINGBELL_PROBE_SECRET_FILE` is the file path, not the token. Set `CLOUDFLARE_ACCOUNT_ID` in the environment when account selection is ambiguous; do not commit account IDs to the shared source config.

5. Run `node probes/flue/cloud-check.ts before <probe-origin/> <new-checkpoint-path>`, with `DINGBELL_PROBE_SECRET_FILE` set in the environment. The script only accepts the dedicated `dingbell-flue-probe.*.workers.dev` origin and refuses HTTP redirects. It checks rejected unauthorized requests, native dispatch/read, concurrent deduplication, conflicts and a single input/reply in history.
6. Run the script with `lifecycle`, the same origin and a **different new checkpoint path**. This runs the controlled interruption and deletion checks and records the boot IDs, nonce, step counts, receipt and destroy response status without storing the secret.
7. Run the script with `bounded` and `contracts`, each with its own **new checkpoint path**. These modes never deploy. They record sanitized runtime evidence and remove their settled Flue fixtures while retaining independent Gate evidence.
8. Record the version ID. Redeploy the same Worker with the same Agent identity, migrations and secret; record the new version ID. Run `after` with the basic checkpoint: it **reads the original result before replaying** the submission. Run `removed` with the lifecycle checkpoint: it verifies that the deleted instance and original result remain absent.
9. Store sanitized checkpoint/deployment evidence under ignored `test-results/` and remove the temporary secret file after verification. A later run can upload a fresh random secret; never reset the DO migration just to rerun a test.

The script does not deploy or assert a version change itself; pair its output with Wrangler's deployment evidence. Redeployment alone does not prove a forced cold start; the lifecycle phase uses the explicit reset and boot marker for that evidence. See [implementation progress](../../docs/06-implementation-progress.md) for actual results and remaining acceptance work.
