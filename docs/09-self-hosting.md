# Self-hosting DingBell

## Independence and defaults

DingBell has no central license check, DingBell account, billing endpoint or mandatory telemetry service. A self-hosted installation uses its own Cloudflare resources and optional provider accounts. All model execution, knowledge indexing, translation, automatic reception and outbound messaging switches default to disabled. The account/team, store metadata, imported data, manual message workspace, bounded CSV export and local analytics remain buildable without model credentials. Actual Ozon features still require the deployer's Ozon credentials and currently retain the acceptance limits documented elsewhere.

Cloudflare services and external providers may charge independently. This document does not claim that any cloud configuration is free. The default repository has no R2 binding because the current operator declined R2 activation; synchronous exports remain limited to 5,000 rows and 8 MiB.

## Local installation

Prerequisites: Node.js 24.14.0, npm, and a POSIX-like shell for the native integration harnesses.

```sh
git clone <your DingBell repository URL>
cd DingBell
npm ci
cp .dev.vars.example .dev.vars
openssl rand -base64 32              # put a new value in BETTER_AUTH_SECRET
npm run db:migrate:local
npm run check
npm run dev
```

Set `APP_BASE_URL` to the exact browser origin. Do not use sample values as secrets. Local D1 and Durable Object state is development data, not a production backup.

To inspect the authenticated UI without configuring email, stop Vite and run `npm run demo:local`. It works only with `APP_BASE_URL=http://127.0.0.1:5173`, a configured local identity secret and the repository's `dingbell-local-only` D1 placeholder. It generates a random password in ignored `.dev.vars.demo-account.json`, applies no remote command and creates one verified local owner. Restart Vite and use the printed credentials. Never copy this local database or account into a deployment.

## Minimum cloud deployment

1. Create a dedicated Cloudflare account/project and D1 database. Record its real database ID; replace `dingbell-local-only` in a deployment-specific Wrangler configuration. Do not commit account IDs if your release policy treats them as private.
2. Review `wrangler.jsonc` bindings, compatibility date, Durable Object migrations, Workflows and Cron. Resource names must belong to the target account.
3. Configure secrets with `wrangler secret put`, not `vars` or source control. At minimum set `BETTER_AUTH_SECRET` and `APP_BASE_URL`. Bootstrap/email and store encryption settings are required only for their documented workflows.
4. Apply D1 migrations to the target database before deploying the matching Worker:

   ```sh
   npx wrangler d1 migrations list DB --remote
   npx wrangler d1 migrations apply DB --remote
   npm run build
   npx wrangler deploy --config dist/dingbell/wrangler.json
   ```

5. Verify `/api/health`, `/api/setup`, authentication, D1 migration status, static assets and scheduled trigger configuration. Health only proves Worker liveness.
6. Keep `OUTBOUND_ENABLED`, `AI_RECEPTION_ENABLED`, `AI_OUTBOUND_ENABLED`, `TRANSLATION_ENABLED`, `REPLY_TEST_ENABLED`, `KNOWLEDGE_INDEXING_ENABLED` and `KNOWLEDGE_VECTOR_CLEANUP_ENABLED` false until each external capability has its own acceptance evidence.

The generated deployment config is under `dist/dingbell/`. Inspect it before deployment; a successful build is not deployment authorization.

## Secret and binding inventory

`.dev.vars.example` is the canonical variable description. Important boundaries:

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
