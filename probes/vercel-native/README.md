# Vercel native SQLite storage probe

Status: **native storage checks passed on Vercel Hobby**, 2026-10-29, using Node 24.22.1 (Linux) and SDK 3.9.1. Both Sandboxes and the Drive were removed; a subsequent list returned zero remaining resources, and the dedicated test project was deleted. See [sanitized evidence](evidence.json). This is not evidence that the full DingBell application deploys on Vercel.

This isolated package uses `@vercel/sandbox@3.9.1` (Apache-2.0). Its lockfile contains 43 packages, with complete version/integrity/license metadata (Apache-2.0, ISC or MIT). It adds no dependency to the main application and introduces no external database. It uses only synthetic SQLite rows, never real customer data or model calls.

The probe checks SQLite WAL transaction rollback after a killed Node process, original receipt preservation, rejection of a second read-write mount, and data/integrity after stopping the first Sandbox and mounting the same Drive in a replacement Sandbox. It removes its Sandboxes and Drive afterward. Sandboxes are non-persistent so they do not create automatic filesystem snapshots; persistence comes from the separate Drive.

After `vercel login`, create/link a dedicated project named `dingbell-native-check-*` in this directory. Never link a production project. Then:

```sh
npm ci --ignore-scripts
npm run check:types
npm run test:cloud
```

The type check uses the repository's existing TypeScript/Node types, so install root dependencies first. `.vercel/` is ignored. Credentials are read through the SDK's CLI-auth helper, held in memory and never printed. The cloud run creates real resources and consumes the account's Sandbox/Drive quota. It writes secret-free evidence under ignored `test-results/vercel-native/`. Delete the dedicated empty test project after verifying resource cleanup. An interrupted cloud call can leave a partially created resource: use the unique names in the run/evidence to inspect cleanup before rerunning.

Passing this probe only establishes these storage primitives. It does not verify Pi, the full application, VM crash durability, long-lived scheduling, proxy security, business concurrency, backup/restore or deployment-button installation. Pi execution is verified separately by the [World/queue execution probe](../pi-portability/VERCEL.md).

The first attempt established that the cloud API requires a minimum 1 GiB Drive, although the documented SDK accepts smaller numbers. A second run passed the contracts but initially failed Drive cleanup; it was removed after detachment. The final run (10:32:36–10:32:53 UTC) passed all checks and cleanup. The source now waits for detached mount metadata before deletion. These are synthetic storage checks; full DingBell application integration remains unverified.
