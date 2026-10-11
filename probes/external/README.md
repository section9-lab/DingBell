# Isolated Cloudflare external-service probe

This is a separate test Worker, `dingbell-external-probe`. Its single Flue-generated SQLite Durable Object is `FlueExternalProbeAgent`, migration `v1`. It does not replace existing probes or enter the production `src` agent scan. There is no customer messaging, general prompt endpoint, arbitrary URL proxy, browser UI, or model fallback.

## Verification and build

Run from the repository root:

```sh
node --test probes/external/*.test.ts probes/ozon/*.test.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build --config probes/external/vite.config.ts
```

The generated deployment config is under `probes/external/dist/dingbell_external_probe/wrangler.json` (confirm the generated directory name after build). Use that generated config for deployment so Flue's generated binding and class export are retained. Configure `NVAPI_KEY` and `PROBE_TOKEN` through Cloudflare secrets, never `vars`, frontend code, or command-line literal values. The root integration may also require `OZON_API_KEY` and `OZON_CLIENT_ID` secrets for its separate read-only Ozon hook.

Builds set the official Cloudflare config `secrets.required` to an empty array solely during `build`, preventing the plugin from copying local credential files into output for preview. Local `serve` behavior is unchanged. No `.env` file is read by the probe code. Remote bindings and the inspector are disabled in its Vite configuration.

Offline tests cover real SQLite claim/counter persistence across new ledger objects, immutable receipt binding, closed/unclaimed budget denial, redirect/host rejection, durable HTTP caps across new transport closures, and authenticated HTTP routing. They do not prove the Cloudflare runtime or external NVIDIA service works; those require the deployed checks below.

## Fixed model run

`GET /api/health` is public. All `/__probe/*` routes require `Authorization: Bearer <PROBE_TOKEN>` and respond with `Cache-Control: no-store`.

- `POST /__probe/model/dispatch`: no body (or `{}`), no query parameters. Returns a Flue dispatch receipt with HTTP 202. Every request uses the same instance ID, question, and `idempotencyKey`. After a receipt is stored, repeated requests return it without dispatching again. Concurrent admissions or recovery after a lost receipt converge through Flue's native idempotency contract.
- `GET /__probe/model/result`: does not dispatch or create a new run. Returns 404 before admission, 202 while pending, 200 with the synthetic reply and evidence when complete, or 409 for a failed read/run. Reading may wake already admitted Flue work; this is not a claim that reads never wake Durable Objects.
- No native `createAgentRouter` is exposed. `/agents/*` has no route. There is no reset/retry-with-new-key or destroy endpoint.

The fixed instance is `synthetic-one-run-v1`, with key `synthetic-order-once-v1`. It asks in Russian for test order `TEST-1001`. The only mounted application tool is `lookup_test_order`, with a Valibot literal argument. It returns the fixed synthetic `shipped` status and `2026-10-12` estimated date. Flue/Pi own tool serialization, protocol streaming, dispatch, persistence, and reads. The already locked transitive Valibot dependency is used for Flue's public schema API; an independently packaged production module would declare it directly.

The provider is Pi's native `nvidiaProvider()`, limited to `nvidia/nemotron-3-super-120b-a12b`. Its public API-key resolver reads only `NVAPI_KEY` through `getCloudflareContext().env`. The only permitted model endpoint is `https://integrate.api.nvidia.com/v1/chat/completions`. Redirects are not followed. SDK retries are zero, output is capped at 512 tokens, and `chat_template_kwargs.enable_thinking` is false. Request/stream abort signals are 45 seconds; Flue durability is `maxAttempts: 1`, timeout 120 seconds. Cancellation does not establish that the remote service stopped already accepted work.

Application-owned `dingbell_external_probe_control` and `dingbell_external_probe_evidence` tables live in this same Flue DO. They are accessed via public Cloudflare SQL storage and the public Flue `extend()` surface; no Flue internal table is queried. Both generation and HTTP counters are claimed atomically before execution and capped at 6 across isolate restarts. A terminal event closes the model budget. A crash before the request can conservatively consume budget without a remote call. Never add a reset endpoint to bypass this bound.

Evidence records only synthetic tool arguments/results, HTTP status and SSE booleans, finish status, and token counts. It never stores request headers, environment objects, secrets, complete provider errors, or provider billing estimates. Flue tracing is disabled. A successful small Russian response is not a language-quality benchmark; Russian is absent from this model's published supported-language list. Token counts do not prove an actual zero-dollar invoice.

## Separate Ozon hooks

`createExternalApp()` accepts optional `ozon.run(env)` and `ozon.result(env)` hooks, protected by the same bearer middleware. The POST accepts no body or query. The hook implementation must use fixed read-only operations and return only sanitized metadata.

`externalStub(env)` is exported from `src/app.ts`; its public extension offers `externalClaim('ozon')`, `externalInspect('ozon')`, and `externalRecordOzon(sanitizedResult)`. The Ozon claim/evidence occupies a separate ledger row from the model run. `externalRecordOzon` allows one write only after claiming, then closes that row. `runOzonOnce` claims before reading `/v1/roles`, `/v3/product/list`, `/v3/chat/list` and `/v4/posting/fbs/list` on the fixed official Seller API host. It returns only status/count/pagination metadata, with a 15-second timeout per request, no redirects or retries. Failure of the initial authorization check stops further requests. A crash after claim remains pending instead of repeating store reads automatically. Ozon request evidence is in `checks`; the shared ledger's model/HTTP budget counters count NVIDIA operations only. Real customer content is never substituted into the model run.

## Acceptance to perform after deployment

Verify unauthenticated controls fail, then dispatch exactly once. Poll only the result route until terminal. Confirm a real SSE response, one correct synthetic tool call, factual Russian reply, token usage, and expected model/HTTP counts. Repeat the same POST and GET and confirm receipt and counts are unchanged. Redeploy the same class/binding identity and confirm the evidence and budgets persist. Independently verify Ozon connectivity without calling any send/write endpoint. Retain sanitized evidence and explicitly record unverified items.
