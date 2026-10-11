import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { init, observe, useModel, useTool, type PromptUsage } from '@flue/runtime';
import { sqlite, start } from '@flue/runtime/node';
import { nvidiaProvider } from '@earendil-works/pi-ai/providers/nvidia';
import type { Provider } from '@earendil-works/pi-ai';
import * as v from 'valibot';

const endpoint = 'https://integrate.api.nvidia.com/v1';
const requestLimit = 6;
const requestTimeoutMs = 45_000;
const maxTokens = 512;

export function readConfig(env: Record<string, string | undefined>) {
  if (!env.NVAPI_KEY?.trim()) throw new Error('NVAPI_KEY is required.');
  if (!env.NVAPI_MODEL?.trim()) throw new Error('NVAPI_MODEL is required.');
  const baseUrl = (env.NVAPI_URL ?? endpoint).replace(/\/$/, '');
  if (baseUrl !== endpoint && baseUrl !== 'https://integrate.api.nvidia.com') {
    throw new Error('Only the official NVIDIA endpoint is allowed.');
  }
  return { apiKey: env.NVAPI_KEY.trim(), modelId: env.NVAPI_MODEL.trim(), baseUrl: endpoint };
}

// Guard the existing SDK's fetch; do not implement the model wire protocol.
export function guardedFetch(
  send: typeof fetch = globalThis.fetch,
  onResponse?: (response: { status: number; streaming: boolean }) => void,
): typeof fetch {
  let calls = 0;
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== `${endpoint}/chat/completions`) throw new Error('Only the official NVIDIA chat endpoint is allowed.');
    if (calls >= requestLimit) throw new Error('The model HTTP request budget is exhausted.');
    calls++;
    const parent = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const response = await send(input, {
      ...init, redirect: 'error', signal: parent ? AbortSignal.any([parent, timeout]) : timeout,
    });
    onResponse?.({ status: response.status, streaming: response.headers.get('content-type')?.split(';')[0].trim() === 'text/event-stream' });
    return response;
  };
}

export function createNvidiaProvider(modelId: string) {
  const provider = nvidiaProvider();
  const model = provider.getModels().find(model => model.id === modelId);
  if (!model) throw new Error('NVAPI_MODEL is absent from the pinned NVIDIA provider catalog.');
  assert.equal(model.baseUrl, endpoint);
  return { ...provider, getModels: () => [model] };
}

export const syntheticQuestion = 'Здравствуйте! Где мой тестовый заказ TEST-1001 и когда он придёт?';
const order = { orderId: 'TEST-1001', status: 'shipped', estimatedDelivery: '2026-10-12', synthetic: true } as const;

export async function runSyntheticProbe(provider: Provider, modelId: string, database: string, apiKey?: string) {
  const id = `synthetic-${randomUUID()}`;
  let modelCalls = 0;
  let httpRequests = 0;
  const toolCalls: { toolCallId: string; input: { orderId: string }; output: typeof order }[] = [];
  const usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }[] = [];
  const turnStatus: { isError: boolean; finishReason?: string }[] = [];
  const httpResponses: { status: number; streaming: boolean }[] = [];
  const network = guardedFetch((input, init) => {
    httpRequests++;
    return globalThis.fetch(input, init);
  }, response => httpResponses.push(response));
  const bounded: Provider = {
    ...provider,
    auth: apiKey ? {
      apiKey: {
        name: 'NVIDIA probe credential',
        async resolve({ signal }) {
          signal.throwIfAborted();
          return { auth: { apiKey }, source: 'explicit probe credential' };
        },
      },
    } : provider.auth,
    streamSimple(model, context, options) {
      if (modelCalls >= requestLimit) throw new Error('The model generation budget is exhausted.');
      modelCalls++;
      return provider.streamSimple(model, context, {
        ...options,
        maxTokens, maxRetries: 0, timeoutMs: requestTimeoutMs, fetch: network,
        temperature: 1,
        samplingParams: { top_p: 0.95, chat_template_kwargs: { enable_thinking: false } },
        signal: options?.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(requestTimeoutMs)])
          : AbortSignal.timeout(requestTimeoutMs),
      });
    },
  };
  function NvidiaSyntheticProbe() {
    useModel(`${provider.id}/${modelId}`, { thinkingLevel: 'off', compaction: false });
    useTool({
      name: 'lookup_test_order',
      description: 'Read the single synthetic order TEST-1001. This tool never accesses a real customer or Ozon.',
      input: v.object({ orderId: v.literal('TEST-1001') }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      timeoutMs: 1_000,
      run({ data, toolCallId }) {
        toolCalls.push({ toolCallId, input: data, output: order });
        return { output: order };
      },
    });
    return 'You are an ecommerce support test agent. All conversation data is synthetic. Answer in Russian. '
      + 'For order questions call lookup_test_order exactly once before answering. Use its factual status and expected delivery date, '
      + 'explain that the date is an estimate, and do not invent tracking locations or guarantees. Keep the final answer under 70 words.';
  }
  NvidiaSyntheticProbe.agentName = 'NvidiaSyntheticProbe';
  NvidiaSyntheticProbe.durability = { maxAttempts: 1, timeoutMs: 120_000 };
  const unsubscribe = observe(event => {
    if (event.instanceId !== id || event.type !== 'turn') return;
    turnStatus.push({ isError: event.isError, finishReason: event.response.finishReason });
    if (event.response.usage) {
      const u: PromptUsage = event.response.usage;
      usage.push({ input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, totalTokens: u.totalTokens });
    }
  });
  let runtime: Awaited<ReturnType<typeof start>> | undefined;
  try {
    runtime = await start({ agents: [NvidiaSyntheticProbe], db: sqlite(database), providers: [bounded], env: {} });
    const handle = init(NvidiaSyntheticProbe, { id });
    const payload = { message: syntheticQuestion, idempotencyKey: 'synthetic-order-1' };
    const receipt = await handle.dispatch(payload);
    const reply = await handle.read(receipt.submissionId, { signal: AbortSignal.timeout(125_000) });
    assert.equal(toolCalls.length, 1, 'Expected exactly one validated synthetic order lookup.');
    assert.ok(reply.text && /[А-Яа-яЁё]/.test(reply.text), 'Expected a non-empty Cyrillic answer.');
    const before = { modelCalls, tools: toolCalls.length };
    const replay = await handle.dispatch(payload);
    const replayReply = await handle.read(replay.submissionId, { signal: AbortSignal.timeout(5_000) });
    assert.equal(replay.submissionId, receipt.submissionId);
    assert.equal(replayReply.text, reply.text);
    assert.deepEqual({ modelCalls, tools: toolCalls.length }, before);
    return {
      synthetic: true, execution: 'local-node-sqlite', externalCustomerMessagesSent: 0,
      provider: provider.id, modelId, question: syntheticQuestion, reply: reply.text,
      toolCalls, modelCalls, httpRequests, httpResponses, usage, turnStatus, replaySameSubmission: true,
      limits: { maxHttpRequests: requestLimit, maxModelGenerations: requestLimit, maxOutputTokensPerRequest: maxTokens, requestTimeoutMs, sdkRetries: 0 },
      billing: 'not-verified; token counts only; provider catalog prices are not an invoice',
    };
  } finally {
    unsubscribe();
    await runtime?.stop();
  }
}
