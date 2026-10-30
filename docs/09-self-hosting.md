# Self-hosting DingBell

## Deployment targets

The application shares its business core across Cloudflare, Vercel and a standalone Node process. Cloudflare uses PiHarness/Durable Objects, D1 and Cron. Vercel uses the official `durable-harness/pi-durable` World adapter plus a private Node business backend on a native Sandbox Drive. Self-managed servers use Pi Durable and native SQLite on a persistent volume. Runtime artifacts contain one Pi AI / Pi Durable / Chord 1.4.0 graph and exclude Flue.

Vercel does not require an external database. The business Drive is named `dingbell-business-data`, limited to 1 GiB by the initial profile, and located in `iad1`. Each business Sandbox incarnation has a unique `dingbell-business-` name. Drive's exclusive read-write mount and the SQLite process lock prevent simultaneous writers; the gateway checks the production release before replacing an incarnation. Functions expose HTTP and World queues wake maintenance without a connected browser. This consumes Sandbox, Drive, Functions and queue resources; it is not a Function-local persistent SQLite disk.

Default capabilities include identity/team workflows, store metadata and credentials, imported business data, the manual workspace, bounded CSV export and analytics. Optional Cloudflare Workers AI/Vectorize semantic retrieval remains a Cloudflare binding integration. Node/Vercel do not substitute another embedding profile. R2 remains optional and unbound by default.

Deployment buttons stay disabled until final installation-wizard and authorized first-owner email checks pass. See [recorded verification](../probes/deployment/README.md); do not infer a successful installation from an isolated execution probe.

## Standalone Node

```sh
npm ci
npm run setup:runtimes
npm run build:node
cp .dev.vars.example .env.node
# Configure the settings described below. Use http://localhost:3000 for local testing.
node --env-file=.env.node dist/node/server/server.mjs
```

Use Node 24.22.x. Set `APP_BASE_URL` to the exact browser origin; `HOST` defaults to `127.0.0.1` and `PORT` to `3000`. Put an HTTPS reverse proxy in front of an Internet-facing server. `DINGBELL_DATA_DIR` defaults to `./data`; `DINGBELL_MIGRATIONS_DIR` and `DINGBELL_ASSETS_DIR` may override source migration and compiled client paths. Installation and credential settings use ordinary process environment variables. All execution flags omitted from the environment remain disabled.

Run one process per data directory. A second process fails before migration or business writes. The build is self-contained and runs without `node_modules`. `deploy/node/Dockerfile` packages the same build, with a non-root user and `/data` volume. A local Docker engine was unavailable during this verification; the standalone artifact itself is exercised without dependencies and on Vercel's Linux Sandbox.

For a consistent self-managed backup, stop the server cleanly, copy the entire data directory (business, object and Pi databases together), and separately retain the encryption/authentication secrets. Restore into a new private directory, preserve the original backup, set `DINGBELL_DATA_DIR`, then start the matching release and verify integrity, sessions, original receipts and budgets before exposing traffic. Never copy just a live `.sqlite` file while omitting its WAL, or start a second writer as a backup method. Managed World checkpoints are separate from Vercel's business Drive; a Drive copy alone is not a complete cross-service disaster-recovery backup.

## Vercel

Import this repository as an Other project with the checked-in `vercel.json`. It installs isolated toolchains, type-checks TypeScript, builds the frontend/Node backend and compiles the Function wrappers before the Node builder runs. Configure:

- `DINGBELL_GATEWAY_SECRET`: independent random secret, at least 32 characters; internal gateway and authority calls only.
- `BETTER_AUTH_SECRET`, `BOOTSTRAP_SECRET`, `RESEND_API_KEY`, `MAIL_FROM`, `STORE_CREDENTIAL_KEYS`, `STORE_CREDENTIAL_ACTIVE_KEY`: same installation meanings as on Node/Cloudflare.
- `APP_BASE_URL`: optional when the standard production alias is used; required for your exact custom HTTPS origin. Without it, the adapter uses `VERCEL_PROJECT_PRODUCTION_URL`.

The first production request creates the private Drive/backend and the native maintenance queue. Preview deployments cannot replace the production backend. Keep the gateway secret stable across redeployments. The adapter never retries a business HTTP mutation after an uncertain network result. A deployment transition may temporarily return 503; clients should read original state before retrying a mutation. Synchronous CSV responses are capped at 4 MiB to remain below the Function response limit; narrow larger exports.

## Independence and defaults

DingBell has no central license check, DingBell account, billing endpoint or mandatory telemetry service. An installation uses its own chosen host and optional provider accounts. All model execution, knowledge indexing, translation, automatic reception and outbound messaging switches default to disabled. The account/team, store metadata, imported data, manual message workspace, bounded CSV export and local analytics remain buildable without model credentials. Actual Ozon features still require the deployer's Ozon credentials and currently retain the acceptance limits documented elsewhere.

Cloudflare services and external providers may charge independently. This document does not claim that any cloud configuration is free. The default repository has no R2 binding because the current operator declined R2 activation; synchronous exports remain limited to 5,000 rows and 8 MiB.

## Local Cloudflare development

Prerequisites: Node.js 24.22.x, npm, and a POSIX-like shell for the native integration harnesses.

```sh
git clone <your DingBell repository URL>
cd DingBell
npm ci
npm run setup:runtimes
cp .dev.vars.example .dev.vars
openssl rand -base64 32              # put a new value in BETTER_AUTH_SECRET
npm run db:migrate:local
npm run check
npm run dev
```

Set `APP_BASE_URL` to the exact browser origin. Do not use sample values as secrets. Local D1 and Durable Object state is development data, not a production backup.

The root `.dev.vars.example` contains installation and store-encryption settings. Optional model, knowledge and outbound settings are in `config/runtime.env.example`; append only the reviewed settings you need. Cloudflare feature gates are also explicitly disabled in `wrangler.jsonc`. Change those variables intentionally when enabling a verified capability.

To inspect the authenticated UI without configuring email, stop Vite and run `npm run demo:local`. It works only with `APP_BASE_URL=http://127.0.0.1:5173`, a configured local identity secret and the repository's `dingbell-local-only` D1 placeholder. It generates a random password in ignored `.dev.vars.demo-account.json`, applies no remote command and creates one verified local owner. Restart Vite and use the printed credentials. Never copy this local database or account into a deployment.

## Minimum cloud deployment

1. Create a dedicated Cloudflare account/project and D1 database. Record its real database ID; replace `dingbell-local-only` in a deployment-specific Wrangler configuration. Do not commit account IDs if your release policy treats them as private.
2. Review `wrangler.jsonc` bindings, compatibility date, Durable Object migrations, Workflows and Cron. Resource names must belong to the target account.
3. Configure secrets with `wrangler secret put`, not `vars` or source control. At minimum set `BETTER_AUTH_SECRET` and `APP_BASE_URL`. Bootstrap/email and store encryption settings are required only for their documented workflows.
4. Apply D1 migrations to the target database before deploying the matching Worker:

   ```sh
   npm run build
   npm run deploy:cloudflare
   ```

5. Verify `/api/health`, `/api/setup`, authentication, D1 migration status, static assets and scheduled trigger configuration. Health only proves Worker liveness.
6. Keep `OUTBOUND_ENABLED`, `AI_RECEPTION_ENABLED`, `AI_OUTBOUND_ENABLED`, `TRANSLATION_ENABLED`, `REPLY_TEST_ENABLED`, `KNOWLEDGE_INDEXING_ENABLED` and `KNOWLEDGE_VECTOR_CLEANUP_ENABLED` false until each external capability has its own acceptance evidence.

The generated deployment config is under `dist/dingbell/`. Inspect it before deployment; a successful build is not deployment authorization.

`deploy:cloudflare` requires a built configuration with a real D1 UUID and migrates the `DB` binding before upload. A migration failure stops deployment. `npm run deploy:cloudflare -- --dry-run` bundles without remote migration or upload. Workers Builds can use `npm run build` and the detected `npm run deploy` commands. Its resource provisioning still needs verification through the actual deploy-button wizard; the isolated CLI check is documented separately.

## Secret and binding inventory

`.dev.vars.example` describes installation settings; `config/runtime.env.example` describes optional execution settings. Important boundaries:

- `BETTER_AUTH_SECRET`: installation identity/session secret.
- `BOOTSTRAP_SECRET`, Resend settings: first owner and email lifecycle; remove bootstrap secret after completion.
- `STORE_CREDENTIAL_KEYS`: independent AES-256-GCM key ring; retain old key versions while ciphertext or backups depend on them.
- Model/provider keys and reviewed pricing JSON: optional, feature-specific, never inferred as free.
- D1, Durable Objects, Workflows, optional AI/Vectorize and optional R2: deployment bindings, not plaintext environment values.

Back up encryption keys separately from D1. Losing either can make retained ciphertext unrecoverable.

## Network destinations

Core browser traffic goes only to the deployment origin. Depending on enabled features, the Worker may contact Cloudflare-managed bindings, Better Auth's local database path, Resend, Ozon Seller API and explicitly configured NVIDIA/model endpoints. There is no DingBell-operated telemetry or license host. Review built assets and provider code before enabling a new destination.

## Production limitations

Read `docs/03-acceptance.md` and `docs/06-implementation-progress.md` before production use. In particular, real Ozon sends, consumer/order ownership, model quality, supplier invoices, external alerts, full deletion, disaster recovery, production scale and final pilot acceptance are not established merely by following this installation guide.
