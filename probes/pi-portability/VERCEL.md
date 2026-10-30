# Vercel Durable Harness execution adapter

The Vercel execution target uses the official `durable-harness/pi-durable` adapter on Vercel World, with the same Pi registry, faux model and tools used in the Node/Cloudflare probes. It requires no Sandbox, Drive, external database, model key or AI Gateway for this synthetic execution check. Business persistence remains a separate application adapter.

Status: **cloud execution checks passed**, 2026-10-29, 11:19:22–11:22:07 UTC. Vercel Functions ran Node 24.21.0; the local runner used Node 24.22.1 and Vercel CLI 65.7.0. The platform timed out the request after 10,348 ms, the native queue completed the original submission, and a second deployment preserved its result with zero additional model/tool calls. The synthetic run was cancelled and the temporary project deleted. See [sanitized evidence](vercel-evidence.json).

`vercel-adapter.ts` registers `resumeWith()`. `api/flow.ts` loads it and exports the official `flowHandler()`. `vercel.json` subscribes the function to `__harness_wkf_workflow_*` using the documented queue trigger. `api/session.ts` exposes token-protected session creation, passive inspection, terminal receipt reads and test cleanup. `api/crash.ts` has a ten-second maximum duration; its synthetic tool waits until thirty seconds after the session was created.

The test requires an actual HTTP 504 containing `FUNCTION_INVOCATION_TIMEOUT`. It then polls only `openWorldReader` after `refresh()`: it cannot reopen a Harness or submit a new input to finish the run. Actual model/tool invocations are recorded independently in a World stream. Assertions require one completed-tool call, two invocations of the interrupted safe tool with the same task ID, different Harness openers, exactly three synthetic model calls and one original user entry. It reads the original submission receipt, redeploys, then reads that same receipt again without another model/tool call.

The probe uses a private trace audience and a randomly generated API token uploaded through CLI stdin. It checks that unauthenticated application requests are rejected. It exercises only synthetic tools, and is not a tenant/session-ownership implementation for DingBell. Production integration must retain scoped authorization, frozen payload fingerprints, budget permits, takeover versions and unknown-send handling.

Run from this directory with a previously authenticated Vercel CLI:

```sh
npm ci --ignore-scripts
npm run check:types
npm run test:vercel -- --isolated-cloud \
  --cli /absolute/path/to/vercel/dist/vc.js \
  --scope your-team-slug
```

Use the CLI JavaScript entry installed by `vercel@65.7.0`. The runner creates a new `dingbell-harness-check-*` project and removes it after cancelling its synthetic run. It refuses to overwrite an existing `.vercel/project.json`. Detailed evidence and redacted logs are written under ignored `test-results/pi-portability/`. A cancelled run/project deletion is not a claim of physical log erasure beyond the platform's retention policy. Inspect cleanup evidence after an interruption; remove only the test project named by that run.

Deployment inputs are checked before uploading: all three API functions must be present, and local environment/credential files must be excluded. API checks use the production alias; unique deployment URLs retain the account's existing Vercel Authentication. A lost CLI deployment-status response is resolved by inspecting that same deployment, rather than submitting another one.

Both cloud deployments became Ready, but the Node builder emitted TS2688 diagnostics for missing `node` and `@cloudflare/workers-types` type declarations. The independent local strict type check passes. The probe establishes runtime behavior; its cloud build configuration still needs a clean production release gate before reuse as a deployment template.

Earlier attempts were retained as failures: omitted API upload inputs, deployment-URL authentication, a reader missing `refresh()`, and an uncertain redeployment status after a network error. All temporary projects were removed; the network-error attempt required a later explicit deletion. No failed attempt is counted as the completed timeout/redeployment contract.

This is execution-layer verification. It does not establish a full Vercel DingBell installation, Flue history migration, business-database portability, cancellation semantics, real-provider behavior, production load or side-effect safety.

Official setup: [Running Pi Durably on Vercel](https://vercel.com/docs/agent-harnesses/pi).
