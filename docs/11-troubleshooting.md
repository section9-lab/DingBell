# Troubleshooting

Start with the failing request's `X-Request-ID`, UTC time, route class, deployment version and a content-minimized error code. Do not copy customer messages, prompts, provider payloads, cookies, authorization headers or raw secrets into tickets.

## Installation and build

| Symptom | Safe checks | Do not do |
| --- | --- | --- |
| `npm ci` rejects Node | Confirm `node --version` is 24.14.0 and the lock file is unchanged | Do not regenerate the lock file under another major Node version |
| Type/build failure | Run `npm run check:types`, then `npm run build`; inspect the first error | Do not disable strict schemas or production artifact checks |
| D1 table/column missing | Run local/remote `wrangler d1 migrations list`; verify the selected binding | Do not edit an applied migration or manually mark it applied |
| Browser shows setup unavailable | Check `APP_BASE_URL`, `BETTER_AUTH_SECRET`, D1 binding and `/api/setup` | Do not expose secret values through a diagnostic endpoint |

## Authentication and authorization

A 404 on company/store resources may intentionally hide an unauthorized scope. Recheck the current verified user, session expiry, membership ID/role and store grant. Do not distinguish “exists but forbidden” for hidden tenant resources. After membership or grant changes, reread instead of reusing cached cursors, member IDs or mutations.

For uncertain identity writes, reread the authoritative membership/invitation record. Never automatically resend password reset, invitation acceptance or owner changes after a lost response.

## Database and migration failures

1. Stop optional writes/external execution.
2. Capture the migration filename and sanitized SQLite error.
3. Run `PRAGMA foreign_key_check` on an isolated copy.
4. Compare schema/migration journal with the release, then restore or forward-fix according to `10-upgrade-and-rollback.md`.

Constraint and trigger errors usually indicate stale scope, an illegal state transition or inconsistent fixture/data—not a reason to remove the guard.

## Sending and provider execution

- `failed`: only an explicit persisted failure. Follow the feature's explicit retry workflow if one exists.
- `unknown`: do not resend. Reconcile the original platform request/message ID or send attempt.
- queued/sending past deadline: run the bounded existing repair path; do not invent a second intent.
- model/Gateway usage missing: retain the reservation. Gateway logs are not supplier invoices.
- AI disabled/unavailable: manual handling and bounded export must remain available.

Never use message-body similarity as proof that an unknown send succeeded.

## Budgets and reconciliation

Manager settings show independent reception, reply-test and translation ledgers. A mismatch alert is observational and cannot release, refund or mutate balances. Check original run/generation/query records, frozen pricing, durable receipt and provider evidence. Zero cost requires positive no-request or verified zero-cost evidence; absence of a record is not enough.

## Sync and store connections

Check store status, credential version, capability expiry, source enablement, cursor due time and current lease/fence. Credential rotation, pause or disconnect intentionally fences old workers. Do not reset a cursor or delete an ingest event to force progress. Real API capability acceptance must use authorized synthetic/non-customer-safe probes and preserve platform limits.

## Analytics and exports

Analytics dates are company-local and `[from,to)`; a zero denominator displays no data, not 0%. Current backlog is a stock and must not be added to period-created counts. Unknown sends and unknown AI costs remain separate.

Synchronous CSV is limited to 5,000 rows and 8 MiB. R2 is intentionally unbound in the default configuration, so 100,000-row asynchronous export is unavailable rather than silently stored in D1/KV. Reduce the range; do not raise limits without bounded tests.

## Escalation bundle

Include commit/artifact hash, environment type, UTC window, sanitized request IDs, migration/DO versions, feature flags, affected scope counts, exact commands, and whether any external request could have started. Exclude customer content and credentials. State unknown evidence as unknown.
