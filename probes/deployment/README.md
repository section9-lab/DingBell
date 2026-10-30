# Full-application deployment verification

The default runtime is Pi Durable. Deployment buttons remain withheld until the published revision passes its actual installation wizard and authorized first-owner email verification. A synthetic cloud baseline does not establish those two checks.

## What the checks establish

| Target | Verified scope | Evidence |
| --- | --- | --- |
| Cloudflare | Fresh D1 with all 54 migrations; production Pi Worker, native object classes, Workflows, Cron and assets; real auth, company isolation, settings write, redeploy preserving cookie/settings; isolated resources removed | [Cloudflare evidence](evidence.json) |
| Vercel | Production Functions, official durable-harness/World, private Node/SQLite business backend on a native Drive; real auth and company isolation; native queue attaches a new Sandbox without a public wake request; integrity, cookie/settings and redeploy preserved; no cloud TypeScript declaration diagnostics; isolated resources removed | [Vercel evidence](vercel-evidence.json) |
| Node | Native SQLite migrations and single-writer lock; real business identity, budget and Pi tool contracts; sender success/unknown retain one provider attempt across restart; standalone compiled HTTP server works without node_modules | `tests/node-application.test.ts`, `tests/node-support.test.ts`, `tests/node-objects.test.ts`, `tests/integration/node-server.test.ts` |

The cloud baselines use synthetic, already-verified identities and do not send real mail, model requests or Ozon messages. Local Node/workerd business execution tests use a controlled provider response and exercise actual Pi execution and budget settlement. Separate [Pi portability checks](../pi-portability/RESULTS.md) cover process/Function interruption, durable recovery and original receipts; the [native Vercel storage check](../vercel-native/README.md) covers SQLite WAL rollback and writer exclusion.

Authentication, membership, store credentials, imported data, budgets, tools and the sender share business rules across adapters. Optional Cloudflare Workers AI/Vectorize retrieval remains unavailable in the default Node/Vercel profile. Cross-service disaster recovery, real model quality and real commerce operations retain their separate acceptance requirements. Docker was not built locally because no Docker engine was available; the standalone artifact and Vercel Linux backend were exercised.

## Upgrade regression

A repeat check on 2026-10-30 exposed an upgrade failure after an earlier successful baseline: deleting an active Sandbox left the replacement unable to acquire the Drive, returning 503. The adapter now stops the session, confirms Drive release and only then deletes that unique incarnation. The final check performs two consecutive upgrades and preserves the same authenticated settings through both. [Failure and follow-up](upgrade-regression.json) are retained alongside the passing evidence. The failed run's project was removed; subsequent Drive and Sandbox reads both returned 404.

## Run isolated cloud checks

From a clean checkout with root dependencies and authenticated CLIs:

```sh
npm ci
npm run setup:runtimes
npm run build
node probes/deployment/cloudflare.ts --isolated-cloud
node probes/deployment/vercel.ts --isolated-cloud --cli /absolute/path/to/vercel/dist/vc.js --scope your-team-scope
```

These commands create uniquely named synthetic-only resources in the selected account and delete them afterward. They refuse to replace an existing local Vercel project link or environment file. They do not operate on an existing DingBell installation. Keep ignored `test-results/` logs/state private. If interrupted, inspect cleanup evidence and the exact temporary resources before rerunning.

Cloudflare applies migrations through the same built DB binding before upload. Upgrades to Pi fail closed while legacy runs remain unsettled or the drain proof cannot be read. Existing Flue data and migrations v1–v5 remain; checkpoints are not converted. See [upgrade instructions](../../docs/10-upgrade-and-rollback.md).

Vercel persistence uses only first-party Vercel services. Function-local files are not durable: business SQLite lives on `dingbell-business-data`, a single-writer Sandbox Drive. Each Sandbox incarnation has a unique name; the production release fences replacements. World queues wake maintenance without browser traffic. This profile consumes Sandbox/Drive/queue resources and does not promise a free or multi-writer database. See [self-hosting](../../docs/09-self-hosting.md) for settings, secrets and backup boundaries.

## Remaining installation acceptance

- Run the actual Cloudflare and Vercel deployment wizards from the final published revision, including required secrets, resource names and the final public origin. The Cloudflare CLI probe discovers the origin and deploys again; it does not prove a single-wizard installation.
- Complete public `/setup` and real email verification using an authorized recipient, `RESEND_API_KEY` and verified `MAIL_FROM`. Local browser checks cover refresh/resume, verification, invitation, recovery, token scrubbing, desktop and 390px layouts using synthetic email.
- Enable README deployment buttons only after these checks pass. Keep all external capability gates disabled by default.

## Repository checks

`npm run check:platforms`, `npm test`, `npm run test:portable`, `node --test tests/integration/build.test.ts`, `npm run db:check` and `npm run check:release` cover types, source contracts, native/compiled runtime artifacts, production bundle boundaries, migration metadata and all target license inventories. The repository has no separate Lint script. Final counts and dates are recorded in the implementation progress log; synthetic checks are not production business acceptance.
