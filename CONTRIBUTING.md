# Contributing to DingBell

DingBell is not yet published under a project license. Until the repository owner selects and adds one, viewing the source does not grant redistribution rights. Do not submit code you are not entitled to contribute.

## Development setup

Use Node.js 24.14.0 (see `.node-version`). From a clean checkout:

```sh
npm ci
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
npm run check:types
npm test
npm run build
node --test tests/integration/build.test.ts
npm run db:check
npm run check:release
```

Run affected native integration suites and `npm run test:web` when changing Cloudflare runtime or browser behavior. Local synthetic tests do not establish real Ozon delivery, model quality, supplier billing or cloud capacity.

## Pull requests

Keep changes focused. State migrations, environment variables, security/privacy effects, rollback constraints, tests run and unverified external conditions. Never weaken a constraint merely to make historical or synthetic fixtures pass.
