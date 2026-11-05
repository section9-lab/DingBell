# Upgrade and rollback

## Before every upgrade

1. Read all release notes and migrations newer than the deployed version.
2. Freeze or disable optional external execution and outbound switches.
3. Export/backup D1 and separately retain Worker secrets, credential key versions, Durable Object/Workflow/R2 inventories and external reconciliation checkpoints. D1 Time Travel alone is not a complete system backup.
4. Record the deployed Worker version, D1 migration list, Durable Object migration tags, bindings, compatibility date and scheduled triggers.
5. Restore the backup into an isolated installation and run representative reads before touching production.
6. Build from the locked dependency graph with the validated Node 24 line (currently 24.22.x) and run `npm run check` plus affected integration/browser tests.

Never place customer data, database exports or secrets in this repository or CI artifacts without an approved protected retention policy.

## Deployment order

DingBell migrations are forward, ordered files. Apply D1 migrations before a Worker that reads new schema. Then deploy the generated Worker containing append-only Durable Object migration tags. Finally verify read-only paths before selectively restoring external switches.

```sh
npm run build
npx wrangler d1 migrations list DB --remote --config dist/dingbell/wrangler.json
npm run deploy:cloudflare
# Only after quiescing legacy work, backing up and reviewing the inventory:
# npm run deploy:cloudflare -- --archive-retired
```

For each step, capture the command, UTC time, commit, target account/database, sanitized result and reviewer. Do not automatically retry an uncertain deployment or migration without rereading its state.

## Retired subsystem data (0065 / 0067 / 0069)

These historical SQL files are unchanged and contain destructive `DROP TABLE` operations. **Do not bypass the deployment helper with direct `wrangler d1 migrations apply` on an existing installation.** Before dropping known retired tables, the Node migration runner and Cloudflare deploy helper copy original rows to `dingbell_retired_<table>`, record the original table SQL/count in `dingbell_retirement_archive`, and compare counts and row contents in both directions. Read-only triggers reject archive insert/update/delete. Original IDs, financial values, receipts and source JSON are retained, not recreated as empty replacement ledgers.

Node performs preparation and each original migration in the same SQLite transaction under the installation's exclusive writer lock. Cloudflare requires `--archive-retired` when source tables contain rows. Remote preparation freezes source mutations before copying; stop the old deployment's admissions and jobs first. A failed/uncertain remote preparation can leave frozen sources and verified or partial archives even when no migration/upload ran. Preserve that state, inspect migration/archive inventories, and use the approved backup/recovery procedure; never automatically thaw sources, overwrite an archive, or replay pending external work. Archives are database-resident recovery copies, **not an independent backup**.

If 0069 was already applied without this safeguard, the removed financial rows are gone from that database. An additive migration cannot recover them. Retain the current installation, restore an eligible pre-0069 backup/Time Travel export into a separate isolated database, reconcile its original records against later activity, and authorize a recovery plan. Do not claim that creating empty tables or copying unrelated production budgets restores history.

Legacy knowledge revisions/chunks remain in the database. Previously published vector revisions are readable only when their original ready/indexed/tested/publication proofs agree; no new approval timestamp or profile is invented. Missing Markdown is reconstructed from validated `source_json`, not overlapping chunks. Publications without valid original proof require explicit review/republishing. Migration 0071 backfills the derived FTS5 trigram index; source revisions and citation identities remain authoritative.

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


## Portable runtime transition (2026-10-29)

The Pi deployment adds migration 0053 and Cloudflare Durable Object migration v6. Historical v1–v5 names and state are retained. Before upgrading an existing Flue installation, pause admission and reconcile/drain all legacy held reservations and unclosed executions with its original release. The Cloudflare deploy helper checks these records before remote migration/upload and refuses an unconfirmed drain. Do not reinterpret a Flue receipt as a Pi UID, discard a claimed permit, or refund uncertain external work. Native checkpoints are adapter-specific; business schema compatibility does not make live executions transferable across platforms.

For Node, stop the old process, preserve a complete data-volume backup and keys, then start the new release with the same private directory. Applied SQL checksums are immutable; changed historical migrations fail closed. Never run old and new writers together. Restore the complete prior volume and matching release for rollback rather than downgrading an already migrated file in place.

For Vercel, a new production release replaces the old business Sandbox through the same exclusively mounted Drive. Incarnations have unique names so a delayed cleanup cannot delete a replacement. Only the creator installs/starts an incarnation; other Functions await readiness. Old Functions cannot replace the active production release. World run IDs and business receipts remain original across releases. Full cross-service point-in-time restore is not established by this deployment check.
