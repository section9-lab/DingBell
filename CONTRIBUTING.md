# Contributing to DingBell

DingBell is licensed under [MIT](LICENSE). Contributions are provided under the same license. Only submit code you are entitled to contribute.

## Development setup

Use the validated Node.js 24 line (currently 24.22.x; the minimum is recorded in `package.json`). From a clean checkout:

```sh
npm ci
npm run setup:runtimes
cp .dev.vars.example .dev.vars
# Set a new BETTER_AUTH_SECRET and APP_BASE_URL only in .dev.vars.
npm run db:migrate:local
npm run check
npm run dev
```

Never commit `.dev`, `.dev.vars`, provider keys, Cloudflare credentials, customer exports, production D1 data, screenshots containing customer content, or `test-results` from non-synthetic environments.

## Change requirements

1. Add deterministic tests for changed behavior. Use synthetic accounts, messages and provider responses.
2. Preserve tenant/store authorization at the final database write and after asynchronous I/O.
3. Do not infer success from an HTTP attempt, queue delivery, model completion, Gateway record, or missing error. Unknown outcomes remain unknown.
4. Migrations are additive by default. Do not edit an already released migration. Preserve foreign keys, immutable records and rollback/failure tests.
5. Customer text, prompts, provider payloads and raw errors must not enter operational logs, analytics or audit projections unless the documented feature explicitly requires the original business record.
6. New paid/external behavior must be opt-in and fail closed when configuration is absent. No DingBell commercial account or license server may become a core dependency.
7. Update architecture, acceptance and implementation-progress documentation with evidence boundaries.

## Required checks

```sh
npm run check
npx playwright install chromium
npm run test:web:portable
```

`check` includes platform typechecks, full unit/module tests, native portable builds/execution tests, build-isolation checks and release/license checks. Run additional affected native suites when changing their contracts. Historical `test:web` scenarios must be migrated to current contracts, not silently deleted or represented as passing portable release checks. See [hardening boundaries](docs/16-production-hardening.md). Local synthetic tests do not establish real Ozon delivery, model quality, supplier billing or cloud capacity.

## Pull requests

Keep changes focused. State migrations, environment variables, security/privacy effects, rollback constraints, tests run and unverified external conditions. Never weaken a constraint merely to make historical or synthetic fixtures pass.
