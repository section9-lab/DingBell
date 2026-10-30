# DingBell

AI customer support for ecommerce teams, with a shared TypeScript business core and Pi Durable runtime adapters.

| Target | Agent execution | Business persistence and coordination |
| --- | --- | --- |
| Cloudflare | Official Cloudflare PiHarness and Durable Object alarms | D1, native Durable Objects and Cron |
| Vercel | Official `durable-harness/pi-durable`, World and native queues | Node/SQLite on Vercel Sandbox Drives, one writer per installation |
| Self-managed | Pi Durable with native Node SQLite | Node 24, SQLite and a persistent data volume |

There is no DingBell account, license server or mandatory DingBell service. Vercel persistence uses Vercel's own services and does not require libSQL, Neon or another database provider. A local SQLite file inside a Vercel Function is never used as durable storage. See [deployment and verification](probes/deployment/README.md).

Deployment buttons remain withheld while the final cloud installation and first-owner email checks are in progress. A working dashboard or execution-only probe is not a complete installation check.

## What is shared

Authentication, companies and membership, encrypted store credentials, imported conversations/products/orders, conversation ownership, frozen execution inputs, budget admission and settlement, translation, answer tools and the sender use the same business rules across adapters. The sender preserves the original intent and allows one provider attempt; unknown outcomes are not resent automatically. Historical execution receipts are never replaced with newly created runs.

Platform-specific integrations are explicit. Cloudflare's optional Workers AI/Vectorize knowledge index and Workflows retain their own bindings. The default Node/Vercel profile leaves those integrations unavailable; it does not substitute an incompatible embedding model or claim semantic retrieval parity. Large asynchronous exports require the separately configured optional object-store adapter. The default synchronous CSV path remains bounded to 5,000 rows and 8 MiB, with a 4 MiB synchronous response cap on Vercel.

Model execution, knowledge indexing, automatic reception and outbound sends all default to disabled. Enable a capability only after configuring its provider, reviewed pricing, budget and store permissions. Synthetic tests do not establish model answer quality, real Ozon delivery or invoice accuracy. [Acceptance boundaries](docs/03-acceptance.md) and [architecture](docs/02-architecture.md) describe these contracts.

## Run on your own server

Use Node 24.22.x and a persistent, private disk. Run one process against each data directory.

```sh
npm ci
npm run setup:runtimes
npm run build:node
cp .dev.vars.example .env.node
node --env-file=.env.node dist/node/server/server.mjs
```

Set `APP_BASE_URL` to the exact public origin and configure independent authentication, installation and credential-encryption secrets. Set `HOST=0.0.0.0` only when exposing the service through your network or HTTPS reverse proxy. The default bind address is loopback. The default data directory is `./data`; preserve the entire directory and back up encryption keys separately.

The standalone build includes its dependencies; the deployed server does not need `node_modules`. A Docker recipe is available at [deploy/node/Dockerfile](deploy/node/Dockerfile). See [installation, secrets and operations](docs/09-self-hosting.md).

## Cloud deployments

Cloudflare uses `npm run build` and `npm run deploy:cloudflare`. Provision a D1 database, replace the local-only database placeholder, configure installation secrets, then deploy. The deployment command applies migrations before uploading and stops on migration failure. `--dry-run` never applies remote migrations.

Vercel uses the checked-in [vercel.json](vercel.json) and `npm run build:vercel`. Configure installation secrets plus `DINGBELL_GATEWAY_SECRET`; the adapter creates its own Drive and private business Sandbox. Native queues handle maintenance when no browser is connected. The Drive allows a single writer; this profile is a persistent Node backend and incurs Sandbox/Drive/queue usage. Preview deployments do not own the production business backend.

First-owner setup runs at `/setup`, requires the installation credential and configured verification email, and resumes the original claim after refresh. Remove `BOOTSTRAP_SECRET` after completing installation. Public registration and raw Agent endpoints stay closed.

Before upgrading an existing Flue installation, pause new execution and reconcile/drain legacy runs. Durable Object migrations v1–v5 and their stored data are preserved; v6 adds Pi storage. Legacy checkpoint formats and in-flight runs are not translated into Pi runs. See [upgrade and rollback](docs/10-upgrade-and-rollback.md).

## Verify

```sh
npm run check:platforms
npm test
npm run test:portable
node --test tests/integration/build.test.ts
npm run check:release
```

`npm run check` runs these checks from installed root dependencies and installs the isolated runtime toolchains. `npm run test:portable` verifies Pi tool termination, native Node business contracts, actual workerd Pi execution, the standalone compiled HTTP artifact and durable object transaction behavior. `npm run test:web` runs the existing Chromium UI suite; install its browser once with `npx playwright install chromium`. The repository has no separate Lint command; source-governance checks run in the test suite.

Cloud probes require explicit `--isolated-cloud`, create uniquely named synthetic-only resources and clean them up. Local logs, state and test credentials are ignored. Instructions and sanitized evidence are in [probes/deployment](probes/deployment/README.md), [Pi portability](probes/pi-portability/RESULTS.md), and [Vercel native storage](probes/vercel-native/README.md).

## License

DingBell is licensed under [MIT](LICENSE). Dependencies retain their own terms; see [third-party notices](THIRD_PARTY_NOTICES.md) and `npm run licenses:inventory` for every target's locked dependency inventory. [Contributing](CONTRIBUTING.md).
