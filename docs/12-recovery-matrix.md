# Upgrade and recovery evidence matrix

This matrix separates reproducible local evidence from cloud or operator evidence. A green row does not complete disaster recovery for the whole product.

| Resource / boundary | Current evidence | Status | Missing before production recovery acceptance |
| --- | --- | --- | --- |
| D1 schema and business rows | `tests/d1-backup-upgrade.test.ts` creates a real pre-0045 SQLite database, copies an immutable backup, applies 0045 through the current migration, verifies message/credential bytes and foreign keys, opens the untouched backup under the old schema, and restores/upgrades a second copy | Locally verified | Real D1 export/Time Travel restore, production-size duration, account/region and approved RPO/RTO |
| Failed D1 migration | Per-migration rollback tests plus selected `test:upgrade-local` guards | Locally verified by migration scope | Whole release migration failure against a sanitized production-shaped copy |
| Store credential encryption | `tests/stores-credentials.test.ts` reads retained v1 ciphertext after v2 becomes active and refuses decryption when the old key is removed | Locally verified | Operator secret backup/restore, production rotation ceremony and proof every retained row/backup has migrated before key retirement |
| Flue schema 8 → current | Authentic official old runtime local and isolated cloud evidence recorded by the Flue compatibility probe; old runtime rejects upgraded copy and original backup hash remains unchanged | Historical local/cloud probe | Current target account rerun when release/runtime changes; this is not a Cloudflare DO snapshot restore |
| Conversation control DO | Restart, projection repair, alarm and idempotency tests | Locally bounded | Account-level DO backup/export strategy, enumerate/restore all company objects and reconcile platform side effects |
| Flue current DO instances | Restart, receipt recovery and bounded instance deletion tests | Locally bounded | Enumerate all company instances, restore or intentionally rebuild after preserving unknown cost/send evidence |
| Workflows / queues | Local restart/retry/DLQ probes | Locally bounded | Cloud delivery backlog capture/restore and in-flight release procedure |
| Vectorize | Versioned D1 source allows reindex design; visibility probes and a fenced stale-revision deletion state machine exist | Local adapter/state evidence only | Complete namespace inventory, cloud delete/rebuild, final query invisibility/visibility and capacity timing |
| R2 exports | Default deployment has no R2 binding | Not applicable to default | Reclassify if an operator enables object storage; include object inventory, expiry and authorized downloads |
| SEARCH_DB | Not implemented | Not applicable | Add rebuild and deletion evidence if enabled |
| Secrets and bindings | Self-hosting inventory and ignored local examples | Procedure only | Protected secret backup, account binding inventory, dual-control restore and post-restore rotation |
| External Ozon/model/email facts | Idempotency and unknown-result contracts | Reconciliation only | Provider/platform evidence; never infer remote rollback from local restore |
| Backups containing deleted data | Governance status identifies the boundary | Blocked by D-06 | Approved retention/expiry and proof a restore cannot silently reactivate deleted access or background work |

## Local command

```sh
npm run test:upgrade-local
```

The command uses only synthetic data and does not log in to Cloudflare or call Ozon/models. Its D1 backup is created under the OS temporary directory and removed even after failure. Node's built-in SQLite API is experimental in Node 24, so the validated Node version is mandatory.

## Restore order

1. Keep all outbound/model execution disabled.
2. Restore secrets/key versions and bindings without enabling external work.
3. Restore D1 and check migration/schema/foreign keys.
4. Restore or rebuild DO/Flue/Workflow/Vectorize state according to the exact release matrix.
5. Reconcile every sent/unknown platform action and every held/unknown supplier cost.
6. Verify membership/store authorization and deletion tombstones before reopening reads.
7. Enable read-only/manual paths first; external automation requires separate approval.

A D1-only restore is never a complete DingBell restore.
