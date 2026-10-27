# Upgrade and rollback

## Before every upgrade

1. Read all release notes and migrations newer than the deployed version.
2. Freeze or disable optional external execution and outbound switches.
3. Export/backup D1 and separately retain Worker secrets, credential key versions, Durable Object/Workflow/R2 inventories and external reconciliation checkpoints. D1 Time Travel alone is not a complete system backup.
4. Record the deployed Worker version, D1 migration list, Durable Object migration tags, bindings, compatibility date and scheduled triggers.
5. Restore the backup into an isolated installation and run representative reads before touching production.
6. Build from the locked dependency graph with Node.js 24.14.0 and run `npm run check` plus affected integration tests.

Never place customer data, database exports or secrets in this repository or CI artifacts without an approved protected retention policy.

## Deployment order

DingBell migrations are forward, ordered files. Apply D1 migrations before a Worker that reads new schema. Then deploy the generated Worker containing append-only Durable Object migration tags. Finally verify read-only paths before selectively restoring external switches.

```sh
npx wrangler d1 migrations list DB --remote
npx wrangler d1 migrations apply DB --remote
npm run build
npx wrangler deploy --config dist/dingbell/wrangler.json
```

For each step, capture the command, UTC time, commit, target account/database, sanitized result and reviewer. Do not automatically retry an uncertain deployment or migration without rereading its state.

## Compatibility rules

- Do not edit or reorder an applied D1 migration.
- Do not reuse or remove a Durable Object migration tag/class.
- Additive columns/tables may be ignored by an older Worker only when the migration notes explicitly say so.
- New enum/state values, triggers or queue formats can make Worker-only rollback unsafe even if SQL was additive.
- Immutable audit, financial, message, intent and receipt records must not be rewritten to fit old code.
- Encryption key rotation is independent of schema upgrades; never remove an old key while any row or backup uses it.

## Rollback decision

Prefer forward-fixing a failed new path while external switches remain disabled. A Worker rollback is allowed only after proving the old Worker understands every persisted state produced by the new version. Database rollback is allowed only through a separately reviewed compensating migration or a full, tested system restore. Do not run ad-hoc `DROP`, truncate audit records, reset financial ledgers, replay unknown sends, or restore D1 while leaving newer Durable Object/Workflow/R2 state active.

If an outbound/model request may have started, rollback does not make it safe to retry. Preserve the original idempotency identity and reconcile the original provider/platform evidence.

## Post-upgrade checks

- `/api/health` and `/api/setup` return expected no-store responses.
- Current migration list and Worker/DO versions match the release.
- Login, company/store authorization and revocation work.
- Cron and repair scans do not dispatch disabled external work.
- Budget arithmetic has no new mismatch; unknown costs remain held.
- No optional feature became enabled because an absent variable was treated as true.
- Browser assets contain no server implementation, fixture marker or secret file.

Keep the previous artifact and restore evidence until the approved observation window ends.
