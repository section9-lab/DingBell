# Pi Durable portability probe

This isolated TypeScript fixture checks the execution paths proposed in [ADR-11](../../docs/04-research-and-decisions.md#adr-11-共用核心与三个完整部署目标2026-10-29). It uses the same deterministic faux provider and two replay-safe tools for Node SQLite, Cloudflare PiHarness and durable-harness's World storage. No model credentials, customer data, Ozon requests or production bindings are used. It is not a deployable DingBell application.

See [RESULTS.md](RESULTS.md) and [evidence.json](evidence.json) for the recorded runs, exact versions, observed contract gap and unverified scope. Both Cloudflare and Vercel execution checks have passed in the cloud. The Vercel adapter, timeout/queue protocol and separate evidence are documented in [VERCEL.md](VERCEL.md).

## Dependencies and isolation

This directory owns its package manifest and lockfile. Pi Durable/Pi AI/Chord provide the shared engine and synthetic model. Agents SDK provides PiHarness; durable-harness provides the World adapter; world-local provides the local queue/storage test backend. Wrangler supplies the actual local workerd runtime and optional cloud deployment. TypeScript and the host types check the fixture. Exact versions and registry integrity values are recorded rather than using floating versions at rerun time.

The probe does not change the main application's runtime dependencies or lockfile. The root TypeScript configuration excludes this independently checked fixture so Pi 1.4/Agents 0.30 do not become required for checking the existing Pi 0.87/Flue application. These dependencies are candidates for migration, not approved production upgrades. The lockfile contains platform-specific and development packages; its package count is not a runtime footprint comparison with Flue.

## Local verification

Use Node 24.14 or later in the Node 24 line, and a POSIX host for the process-kill checks. From this directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
npm run check:types
npm run test:local
npm run build:cloudflare
```

`test:local` runs three scenarios:

- Node SQLite: concurrent keyed admission, process SIGKILL during a tool, recovery of the original submission, stable tool identity, completed-tool reuse and terminal reopen without another model call.
- World: the same crash scenario using the published durable-harness adapter and world-local. On restart, the registered World queue finishes the run; a passive reader observes it before the test opens a Harness to read the terminal receipt.
- PiHarness: real local workerd, authenticated HTTP, concurrent operation deduplication, forced object reset, alarm-only recovery, stable tool identity, terminal object reset and durable cancellation.

The Cloudflare gate is a separate Durable Object. During the recovery assertion, the runner only reads that gate, so status polling does not itself wake the interrupted Pi session. The tools are synthetic reads; replaying them does not establish exactly-once external side effects. Temporary local stores and child processes are removed by the harness.

## Isolated Cloudflare cloud verification

This is an explicit resource-creating test. Authenticate Wrangler in the intended test account first; use `CLOUDFLARE_ACCOUNT_ID` when the account is ambiguous. It creates a newly named `dingbell-pi-portability-*` Worker with its own two DO namespaces, runs bounded synthetic checks, redeploys that same Worker, reads the original receipts without submitting again, then deletes the fixture Worker. It does not activate R2 or touch DingBell's Worker, databases or model settings.

```sh
node node_modules/wrangler/bin/wrangler.js whoami
npm run test:cloud
```

The runner generates an owner-readable secrets file outside the repository, passes only its path to Wrangler, and removes the file afterwards. HTTP readiness GETs are bounded; business submissions and reset RPCs are not silently retried. A failed reset HTTP response is checked against persistent gate/boot/task evidence, not interpreted as proof by itself.

Sanitized run details go to the ignored `../../test-results/pi-portability/` directory. Inspect `status`, both deployed version IDs and `removed`. If cleanup is unsuccessful, remove only the uniquely named fixture created by that run after reviewing its evidence file. A failed deployment may require checking whether a partial upload created a Worker. The checked-in evidence excludes account IDs, origins and secrets.

## Boundaries

The probe confirms execution-library interoperability with one pinned combination. It does not port D1 business storage, authentication, budgets, knowledge, files, export jobs or the customer sender. Native request/operation deduplication accepts different input under an existing key; DingBell must preserve its frozen-payload/fingerprint conflict check when replacing Flue. Cancellation still does not retract an external effect.

The Vercel cloud probe confirms one actual Function timeout, native queue recovery and terminal receipt preservation across redeployment. It does not verify cancellation semantics, arbitrary queue redelivery, production load or DingBell business integration. No real-model quality, power-loss durability, schema upgrade, multi-node ownership or whole-application cross-platform migration is claimed.
