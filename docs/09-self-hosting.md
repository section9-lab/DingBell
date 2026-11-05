# Self-hosting DingBell

## Deployment targets

The application shares its business core across Cloudflare, Vercel and a standalone Node process. Cloudflare uses PiHarness/Durable Objects, D1 and Cron. Vercel uses the official `durable-harness/pi-durable` World adapter plus a private Node business backend on a native Sandbox Drive. Self-managed servers use Pi Durable and native SQLite on a persistent volume. Runtime artifacts contain one Pi AI / Pi Durable / Chord 1.4.0 graph and exclude Flue.

Vercel does not require an external database. The business Drive is named `dingbell-business-data`, limited to 1 GiB by the initial profile, and located in `iad1`. Each business Sandbox incarnation has a unique `dingbell-business-` name. Drive's exclusive read-write mount and the SQLite process lock prevent simultaneous writers; the gateway checks the production release before replacing an incarnation. Functions expose HTTP and World queues wake maintenance without a connected browser. This consumes Sandbox, Drive, Functions and queue resources; it is not a Function-local persistent SQLite disk.

Default capabilities include identity/team workflows, store metadata and credentials, imported business data, the manual workspace, bounded CSV export and analytics. Published knowledge uses SQLite FTS5 trigram retrieval on all targets; it does not require Workers AI, Vectorize or Workflows and does not claim semantic similarity. R2 remains optional and unbound by default.

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

DingBell has no central license check, DingBell account, billing endpoint or mandatory telemetry service. An installation uses its own chosen host and optional provider accounts. Translation and outbound switches default to disabled. Knowledge publication is explicit and needs no model. Customer-service execution requires complete reviewed execution parameters, an enabled usable budget and a published policy; a connection alone is insufficient. The account/team, store metadata, imported data, manual message workspace, bounded CSV export and local analytics remain buildable without model credentials. Actual Ozon features still require the deployer's Ozon credentials and currently retain the acceptance limits documented elsewhere.

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

### Updating the local Node UI

Repeated Node builds retain content-hashed client assets so existing tabs can still load their release's lazy modules. Each Node process pins its own HTML entry document until restart, preventing a newly built UI from being served against an old backend. Deploy into fresh directories for clean releases; do not delete assets still needed by open tabs. A missing module or failed page load now presents an explicit reload action rather than a raw router stack trace. Reloading is never automatic and does not replay business writes; preserve unsaved input before reloading.

Chat synchronization treats sender identities as bounded opaque metadata: Ozon `ChatBot` senders can use textual IDs. Message pagination IDs, SKU validation, cursor progress checks and inbound-customer trigger rules remain strict. The message center distinguishes an enabled sync awaiting automatic retry from a disabled sync requiring manager recovery, with a link to store sync settings.

### Reconnecting a disconnected Ozon store

For normal temporary stops, choose **暂停连接**, then **恢复连接** next time. The encrypted API Key remains in the server database across page refreshes, service restarts and pause/resume cycles; restoration does not require retyping it. A server-derived **凭证保存状态** confirms the saved credential version. A blank password field intentionally avoids revealing the existing Key; only replacement requires entering another one. Credential forms trim accidental outer whitespace and explicitly say when validation prevented submission.

Deleting the Key is now explicitly named **删除凭证**, with a destructive confirmation; this retains the existing API's `disconnected` state semantics and stops synchronization. It does not delete imported products, orders, conversations, member grants or sync checkpoints. Legacy disconnected stores whose Key was already cleared require one-time reentry: owners and administrators can choose **重新连接** in either the store list or its details, enter an Ozon Seller API Key and choose **保存并重新连接**. This updates the original store, not a duplicate account. No provider request is made merely by saving. The store returns to **待验证**: explicitly run **检查只读能力**, then enable each desired sync source separately. Restoring a connection does not automatically restart sync, enable AI or send messages. Lost save acknowledgements are reread, never automatically replayed. Previously deleted credentials are not silently recovered from backups.

### Company-wide customer-service model

Owners and administrators can configure **Company settings → AI model** with an OpenAI Chat Completions-compatible Base URL, API key and model ID. All stores/conversations in that company share this connection. After saving, the API Key field displays a fixed read-only row of stars, not an empty input. This is a display-only sentinel (not the actual key, its length or its ciphertext) and is never submitted as a credential. Reloading, listing models, changing the model/pricing and testing continue to reuse the saved key. Use **更换 API Key** only to replace it; **取消更换** discards the draft and restores the saved-star display. Changing the provider origin requires an explicit replacement before saving or listing, so the old key cannot be sent to another provider. This configures customer-service Support/intake execution; translation configuration and budgets remain separate. Retired internal reply-test ledgers are archived for historical recovery, not reused for new execution. The model must support streaming and function tools. Image display does not imply multimodal model input.

Keys use the deployment `STORE_CREDENTIAL_KEYS` ring with a separate AES-GCM domain bound to company, revision, URL and model. Reads never return plaintext keys. Leaving the key blank keeps it only on the same origin; changing origins requires re-entry. Configuration revisions are immutable and retained for existing executions; new runs use the latest revision. Back up the key ring and database together. There is no silent fallback to a deployment model after a company connection has been saved.

Common provider hosts are allowlisted (OpenAI, NVIDIA, DeepSeek, DashScope, OpenRouter, Moonshot, SiliconFlow, BigModel and Z.ai). Custom gateways need their exact hostname in deployment variable `AI_MODEL_ALLOWED_HOSTS`, comma-separated. Only HTTPS on the default port is supported; IP literals, local/internal names, URL credentials, query strings, fragments, traversal and redirects are rejected. Deployment operators must allow only trusted, public destinations and maintain their DNS/network policy. Supply a Base URL such as `https://api.openai.com/v1`, not a complete `/chat/completions` endpoint.

You do not need to know a Model ID in advance: enter the Base URL and API Key, then choose **获取模型列表**. The server makes one bounded, authenticated `GET {Base URL}/models` request; no inference or chat request is sent and nothing is saved. When stars are shown, the saved credential is reused only on the same origin; the browser omits the `apiKey` field from the request. Only model IDs are returned, deduplicated and sorted; up to 2,000 IDs from a response capped at 2 MiB are displayed. Further provider pages are not automatically followed. Lists can be searched locally. Changing the URL or key clears prior options and cancels pending discovery. Unsupported, empty, or failed catalogs retain manual Model ID input. The operation is manager-only, rechecks access and configuration after I/O, refuses redirects, has an eight-second deadline, and is limited to once per company per ten seconds. Keys and draft catalogs are not persisted in browser storage or query caches.

A listed model is not proof of chat, streaming, tool-use or vision support; choose a chat model, save it, then test. Catalog pricing is never treated as reviewed execution pricing.

Save first, then explicitly confirm **Test saved configuration**. A test sends no customer data and performs a single streaming tool probe with a requested 64-token output cap and ten-second deadline. It may incur provider charges, is limited to once per company per minute, and never sends an Ozon message. An interrupted test may remain pending; read its saved status rather than assuming completion or automatically retrying it.

Connection tests retain a sanitized failure category and provider HTTP status (`0056_model_test_diagnostics.sql`), so authentication failures, HTTP 403 permission denials, missing models, rate limits, timeouts, output truncation and incompatible tool/SSE responses are not all reported as a generic failure. Raw provider errors, credentials and prompts are never stored in these diagnostics. A successful catalog read does not prove inference permission. Old failures remain unclassified unless their exact original attempt has independent evidence; the application does not guess historical causes or automatically retry tests.

Saving/testing a connection alone does not enable execution or sending. Fill in all seven execution fields: input/output token limits, generation count, and four reviewed USD-per-million-token rates (input, output, cache reads/writes). Unknown prices must not be entered as zero; explicit, reviewed free rates are allowed. Partial configurations are rejected, while an entirely blank form saves only the connection. The runtime also conservatively rejects serialized custom-model request bodies exceeding the declared input allowance minus 4,096 tokens of overhead. Company models default to internal, unreviewed drafts (`support-knowledge-v1`, `autoReply:false`); explicitly choosing automatic replies selects `support-reply-v1` but does not bypass deployment/store outbound gates. Deployment settings cannot override a company's generation count or reply authorization. A published policy and exactly one usable explicitly configured budget remain mandatory; missing, ambiguous, paused or exhausted budgets do not create unlimited credit. Historical unlimited ledgers remain for settling their original runs only. Companies without a saved connection may use a complete reviewed deployment configuration; a saved incomplete connection never silently falls back.

### Conversation images

Imported image messages display lazy-loaded thumbnails with a keyboard-accessible preview and explicit retry. Both plain image URLs and standalone Ozon Markdown image references are supported; no general HTML or Markdown is executed. Existing imported messages do not need to be re-synced.

The browser requests a same-origin, authenticated message-image endpoint. The server checks current company membership, store grants and message ownership, reads the file from an allowlisted Ozon host, and rechecks access after download. Seller API credentials are decrypted only on the server and never sent to CDN hosts or the browser. Redirects are refused; requests have an eight-second deadline and a 4 MiB limit. Only PNG, JPEG, GIF and WebP with matching raster signatures are returned, with no-store headers. Failed, unsupported or expired images show a local fallback. Files are not persisted, and viewing an image does not enable AI, outbound replies or attachment uploads/sends.

### Order center (FBS / FBO)

Apply `migrations/0055_order_center.sql` before running this version (Node applies pending migrations at startup; D1 deployments must migrate before upload). It adds independent FBO tables and rebuilds the sync authority chain with foreign keys enabled, preserving existing FBS facts, source epochs, chat cursors and cooldowns while invalidating in-flight leases. Back up the database before upgrading.

At `/workspace/orders`, **Order center / 订单中心** defaults to all imported FBS and FBO parcels. Every filter sits behind one collapsed **搜索与筛选** panel next to the sync summary: store, order/parcel keyword search, a company-local date range over the snapshot timeline, and the fulfillment mode. The applied filter set stays in the URL (`store`、`fulfillment`、`q`、`fromDate`、`toDate`) plus the legacy exact-order `order` deep link. Parcel details are qualified by store, fulfillment mode and posting number. Existing FBS read endpoints remain available. Message-context lookups now include both sources and still reject ambiguous exact-order references.

In store management, explicitly recheck capabilities and enable **FBO 包裹同步** to import FBO data. An existing FBS capability never authorizes FBO; legacy FBS evidence remains usable until its normal expiry. FBO uses `/v3/posting/fbo/list` and `/v2/posting/fbo/get`, independent frozen windows/cursors/retries, and the same store lease, request permit and provider cooldown as other sources. Neither enabling nor importing triggers notifications or replies. A source-specific permission failure stops only that source; invalid credentials still stop all sources.

Both modes initially cover the preceding 30 days, then catch up in bounded overlapping windows and refresh known details. Apply `migrations/0057_order_history.sql` for explicit **历史订单回补**. A manager can choose a UTC start date (default one year ago, earliest application-supported date 2000-01-01) in each fulfillment source's store panel. The new `/sync/fbs-postings/history` and `/sync/fbo-postings/history` POST controls require the displayed source epoch and history command revision; starting requires the source already enabled with fresh readable credentials. They never enable another source or change live-window coverage. Separate persisted jobs scan backwards in overlapping windows of at most 31 days, including empty windows, with frozen pagination and atomic facts/checkpoint commits. Live lists, historical lists and details rotate under the existing source lease, provider budgets and shared cooldown. **停止历史回补** stops only historical listing; source/store pause also suspends backfill. Reenable resumes saved cursors at the new epoch; stale in-flight pages cannot commit. Already imported data is retained and deduplicated by store, fulfillment mode and parcel. Progress shows requested range, completed contiguous list coverage, active window and pages read; list-range completion does not mean all parcel details have finished. Provider retention/entitlements can limit available history; a one-year request-window limit is not evidence of one-year retention, and no platform-wide complete ledger is promised. **刷新数据** rereads local snapshots, not a synchronous platform import. Per-mode sync status in store management distinguishes disabled/failed imports from zero imported records, without hiding the other mode's data. FBO does not synthesize FBS tracking or planned-shipment fields. Controlled, non-empty live FBO samples remain a separate deployment acceptance step; automated tests use synthetic data.

The list shows a first-item thumbnail; package details show per-item images from the same store's synced product catalog, matched only by an unambiguous SKU. Missing, ambiguous, unsafe or failed images use a local placeholder. These are current product images, not historical order-image snapshots; browsing does not trigger new platform imports.

The order summary counts distinct platform order IDs and packages separately within the selected authorized store, fulfillment filter and optional exact-order filter. An identical platform order ID across modes is counted once; parcels retain their mode-qualified identity. Total pages use package count and page size, not the number of unique orders. Counts and the bounded page share a database snapshot and do not shrink when following a pagination cursor. They describe the imported recent and backfilled range, not all platform history.

### FBP partner-warehouse orders (Beta)

Apply `migrations/0058_fbp_orders.sql` after backing up the data directory. It adds independent FBP tables, extends the existing coordinator/authority/history foreign-key chain with foreign keys enabled, preserves existing source epochs, cursors, historical jobs, cooldowns and imported facts, and invalidates only in-flight leases. It does not enable FBP or any other source.

**FBP is not an FBO rename.** The implementation uses the dedicated Seller API beta methods `POST /v1/posting/fbp/list` and `POST /v1/posting/fbp/get`, not a guessed replacement of the FBO URL or the legacy v3 FBS `fbpFilter`. Current contract references: [FBP list announcement](https://dev.ozon.ru/community/2054-Novyi-beta-metod-dlia-raboty-s-FBP-postingami-v-Seller-API/), [FBP details announcement](https://dev.ozon.ru/community/2237-Novyi-metod-polucheniia-FBP-postingov-po-identifikatoru-otpravleniia/), and the [OpenAPI mirror](https://github.com/MissiaL/ozon-api/blob/main/references/ozon-seller-openapi.json). Beta availability and permissions depend on the account; existing FBS/FBO evidence never proves FBP access.

Recheck the store's read capabilities, then explicitly enable **FBP 包裹同步**. This adds one bounded `limit:1` FBP list probe to the read check (six total requests including roles), with the same deadline, redirect refusal and secret handling. Older capability snapshots remain usable for their already-verified modes; FBP is unknown until checked. No notifications, replies, AI or outbound capabilities are enabled. FBP shares the store's rate limits, lease, credential fence and cooldown, while retaining its own windows, detail attempts and history controls.

The FBP list has top-level `postings` and cursor-only pagination: a nonempty cursor continues the frozen request window; an empty/absent cursor terminates it. Detail responses use `posting`, not `result`. FBP detail status is retained as the provider's numeric **状态码**, with its original substatus, so stored facts never depend on a translation. The web layer translates what it displays in `src/shared/order-status.ts`: the documented FBS/FBO status names, plus a small FBP code table (300 / 380 / 390 / 3050 / 3090 / 3308) read from synced parcels whose code and substatus always agreed. An unseen code falls back to its substatus name and only then shows the bare number, so a new Ozon code never gets a guessed meaning. Order creation time is separate from processing time. List `price` and detail `marketplace_seller_price` amounts/currencies are retained as exact decimal strings from the selected snapshot, not reconstructed from financial aggregates. Unsupported FBS tracking/planned-delivery fields and customer personal data are not synthesized or retained.

The order center, mode-qualified links, exact-order totals, product previews and message references include FBP. If FBP confirms the exact same store, parcel number, order ID **and** order number as a legacy FBS row, the unified view presents it once as FBP. Old FBS facts/observations and compatibility detail links remain available; different order identities and FBO records are not silently merged. Initial coverage is 30 days; explicit **历史订单回补** can request older UTC ranges with durable progress. A successful list scan does not establish complete platform retention or completed detail hydration.

## Minimum cloud deployment

1. Create a dedicated Cloudflare account/project and D1 database. Record its real database ID; replace `dingbell-local-only` in a deployment-specific Wrangler configuration. Do not commit account IDs if your release policy treats them as private.
2. Review `wrangler.jsonc` bindings, compatibility date, append-only Durable Object migrations and Cron. Resource names must belong to the target account.
3. Configure secrets with `wrangler secret put`, not `vars` or source control. At minimum set `BETTER_AUTH_SECRET` and `APP_BASE_URL`. Bootstrap/email and store encryption settings are required only for their documented workflows.
4. Apply D1 migrations to the target database before deploying the matching Worker:

   ```sh
   npm run build
   npm run deploy:cloudflare
   ```

5. Verify `/api/health`, `/api/setup`, authentication, D1 migration status, static assets and scheduled trigger configuration. Health only proves Worker liveness.
6. Keep `OUTBOUND_ENABLED`, `AI_OUTBOUND_ENABLED` and `TRANSLATION_ENABLED` false until each external capability has its own acceptance evidence. Retired reply-test/vector switches and workflows are not current configuration.

The generated deployment config is under `dist/dingbell/`. Inspect it before deployment; a successful build is not deployment authorization.

`deploy:cloudflare` requires a built configuration with a real D1 UUID and migrates the `DB` binding before upload. Existing retired data blocks deployment until the operator has stopped legacy admissions, backed up the database and explicitly supplies `--archive-retired`; original rows and schema are frozen and verified before deletion. A failure stops deployment. Do not apply retiring migrations directly with Wrangler; see [upgrade and rollback](10-upgrade-and-rollback.md). `npm run deploy:cloudflare -- --dry-run` bundles without remote migration or upload. Workers Builds can use `npm run build` and the detected `npm run deploy` commands. Its resource provisioning still needs verification through the actual deploy-button wizard; the isolated CLI check is documented separately.

## Secret and binding inventory

`.dev.vars.example` describes installation settings; `config/runtime.env.example` describes optional execution settings. Important boundaries:

- `BETTER_AUTH_SECRET`: installation identity/session secret.
- `BOOTSTRAP_SECRET`, Resend settings: first owner and email lifecycle; remove bootstrap secret after completion.
- `STORE_CREDENTIAL_KEYS`: independent AES-256-GCM key ring; retain old key versions while ciphertext or backups depend on them.
- Model/provider keys and reviewed pricing JSON: optional, feature-specific, never inferred as free.
- D1, native Durable Objects and optional R2: current deployment bindings, not plaintext environment values. Retain historical Workflow/vector inventories separately if an earlier release used them.

Back up encryption keys separately from D1. Losing either can make retained ciphertext unrecoverable.

## Network destinations

Core browser traffic goes only to the deployment origin. Depending on enabled features, the Worker may contact Cloudflare-managed bindings, Better Auth's local database path, Resend, Ozon Seller API and explicitly configured NVIDIA/model endpoints. There is no DingBell-operated telemetry or license host. Review built assets and provider code before enabling a new destination.

## Production limitations

Read `docs/03-acceptance.md` and `docs/06-implementation-progress.md` before production use. In particular, real Ozon sends, consumer/order ownership, model quality, supplier invoices, external alerts, full deletion, disaster recovery, production scale and final pilot acceptance are not established merely by following this installation guide.
