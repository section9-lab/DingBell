# Isolated NVIDIA model probe

This probe uses the pinned `@flue/runtime@2.2.2` Node/SQLite runtime and the existing Pi `nvidiaProvider()`. It is not part of the production Worker and adds no dependency or lockfile changes. The probe imports the already locked transitive `valibot` package used by Flue for its public tool-input schema; promoting this probe into an independently packaged application would require declaring that direct dependency.

The conversation and order are synthetic. There is one read-only `lookup_test_order` tool with a validated `TEST-1001` argument. It returns a fixed shipped status and estimated delivery date. The agent answers in Russian. No Ozon credentials, customer text, product data, or external messaging API enter this probe.

## Offline verification

```sh
node --test probes/nvidia/probe.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

The tests run the real local Flue runtime with Pi's faux provider. They verify the tool input/result, Russian fixture reply, and duplicate `idempotencyKey` returning the same submission and answer without new model or tool work. They also verify endpoint rejection, HTTP budget, SDK timeout/retry/token options, disabled thinking parameters, SSE metadata, and native NVIDIA authentication with a fixture key and a locally mocked HTTP transport. Faux success does not establish hosted-model quality or availability.

## Hosted model run

Supply `NVAPI_KEY`, `NVAPI_MODEL`, and optionally `NVAPI_URL` in the process environment. The script does not itself read `.env`. The caller may use Node's native env-file loader with the existing ignored `.env`:

```sh
NVAPI_MODEL=nvidia/nemotron-3-super-120b-a12b node --env-file=.env probes/nvidia/run.ts test-results/nvidia-local-review
```

The destination must not already exist; its parent must exist. The key is passed through Pi's public `Provider.auth.apiKey.resolve` contract, scoped to this provider object. It is not written to `process.env`, the Flue runtime environment, SQLite, or output. In this pinned Node runtime, passing `NVIDIA_API_KEY` only to `start({ env })` does not configure Pi authentication; an offline native-provider regression test covers the explicit resolver. Do not place a literal API key in shell commands. Only the official `https://integrate.api.nvidia.com` root or `/v1` is accepted as `NVAPI_URL`; it is normalized to `/v1`. The model must exist in the pinned native provider catalog. There is no automatic model/provider fallback.

The model's existing metadata and Pi adapter handle the NVIDIA protocol. The probe sets `chat_template_kwargs: { enable_thinking: false }` through Pi's public `samplingParams` option, together with `temperature: 1` and `top_p: 0.95`. This parameter is intended for the selected Nemotron model; do not assume it works for arbitrary models.

## Bounds and evidence

- At most 6 HTTP requests and 6 provider generations for the whole process; the normal tool round trip needs 2.
- Exactly `/v1/chat/completions` is allowed; redirects are refused.
- SDK retries are disabled. The Flue agent has `maxAttempts: 1`.
- Each request/stream has a 45-second abort signal and a 512-output-token cap.
- The submission has a 120-second Flue durability timeout; `read` has a 125-second observer deadline. The CLI has a separate 150-second process kill backstop. Cancellation does not establish that a remote provider stopped already accepted work.
- `result.json` records only synthetic question/answer/tool arguments, tool result, model/HTTP counts, HTTP status and SSE-response booleans (no response headers/body), token usage, finish statuses, and replay checks. SQLite contains the synthetic conversation. Both are written under the ignored `test-results` directory in the example.
- Provider catalog cost fields are deliberately excluded: they do not prove the account's actual billing or free allowance. The output marks billing as unverified.
- A successful answer must include Cyrillic characters and exactly one valid lookup. This is a narrow integration check, not a Russian fluency, factual-quality, or safety benchmark. Manually compare the answer to `TEST-1001`, `shipped`, and `2026-10-12`; flag invented promises.
- The selected model's published supported-language list does not include Russian. A successful Russian sample is not a production support guarantee.
- This does not test Cloudflare execution, browser UI, model-provider recovery, paid-service setup, Ozon creation/replies, or delivery to real customers.

Official model information (review before a hosted run): [Nemotron 3 Super](https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b).
