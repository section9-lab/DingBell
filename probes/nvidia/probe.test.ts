import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';

import * as subject from './probe.ts';

test('NVIDIA probe rejects missing model and unofficial endpoint before invoking a provider', () => {
  assert.ok(subject, 'the isolated NVIDIA probe is not implemented');
  assert.throws(() => subject.readConfig({ NVAPI_KEY: 'fixture-only' }), /NVAPI_MODEL/);
  assert.throws(() => subject.readConfig({ NVAPI_KEY: 'fixture-only', NVAPI_MODEL: 'model', NVAPI_URL: 'https://example.invalid' }), /official/);
  assert.deepEqual(subject.readConfig({ NVAPI_KEY: 'fixture-only', NVAPI_MODEL: 'model', NVAPI_URL: 'https://integrate.api.nvidia.com' }), {
    apiKey: 'fixture-only', modelId: 'model', baseUrl: 'https://integrate.api.nvidia.com/v1',
  });
});

test('request guard limits calls and refuses redirect or a different endpoint', async () => {
  assert.ok(subject, 'the isolated NVIDIA probe is not implemented');
  let actualCalls = 0;
  const guard = subject.guardedFetch(async (_url, init) => {
    actualCalls++;
    assert.equal(init?.redirect, 'error');
    return new Response('{}', { status: 200 });
  });
  await assert.rejects(guard('https://example.invalid/v1/chat/completions'), /official/);
  assert.equal(actualCalls, 0);
  for (let index = 0; index < 6; index++) await guard('https://integrate.api.nvidia.com/v1/chat/completions');
  await assert.rejects(guard('https://integrate.api.nvidia.com/v1/chat/completions'), /budget/);
  assert.equal(actualCalls, 6);
});

test('real local Flue executes the synthetic lookup and replays one receipt without new model or tool work', async () => {
  assert.ok(subject, 'the isolated NVIDIA probe is not implemented');
  let generations = 0;
  const faux = fauxProvider({ api: 'nvidia-probe-fixture', provider: 'nvidia-probe-fixture', models: [{ id: 'reply' }] });
  faux.setResponses([
    (_context, options) => {
      assert.equal(options?.maxTokens, 512);
      assert.equal(options?.maxRetries, 0);
      assert.equal(options?.timeoutMs, 45_000);
      assert.deepEqual(options?.samplingParams, { top_p: 0.95, chat_template_kwargs: { enable_thinking: false } });
      generations++;
      return fauxAssistantMessage(fauxToolCall('lookup_test_order', { orderId: 'TEST-1001' }), { stopReason: 'toolUse' });
    },
    () => {
      generations++;
      return fauxAssistantMessage(fauxText('Заказ TEST-1001 отправлен. Ожидаемая доставка — 12 октября. Дата может измениться.'));
    },
  ]);
  const result = await subject.runSyntheticProbe(faux.provider, 'reply', ':memory:');
  assert.equal(result.synthetic, true);
  assert.equal(result.externalCustomerMessagesSent, 0);
  assert.equal(result.replaySameSubmission, true);
  assert.equal(result.modelCalls, 2);
  assert.equal(generations, 2);
  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(result.toolCalls[0].input, { orderId: 'TEST-1001' });
  assert.equal(result.toolCalls[0].output.status, 'shipped');
  assert.match(result.reply, /Заказ TEST-1001 отправлен/);
});

test('HTTP evidence records only status and whether the response is SSE', async () => {
  const evidence: { status: number; streaming: boolean }[] = [];
  const guard = subject.guardedFetch(async () => new Response('synthetic body', {
    status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-private': 'must-not-record' },
  }), response => evidence.push(response));
  await guard('https://integrate.api.nvidia.com/v1/chat/completions');
  assert.deepEqual(evidence, [{ status: 200, streaming: true }]);
});

test('native NVIDIA authentication reaches the injected transport with only the explicit fixture key', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests++;
    const request = new Request(input, init);
    assert.equal(request.headers.get('authorization'), 'Bearer fixture-explicit-key');
    return new Response(JSON.stringify({ error: { message: 'Synthetic 400 stops the offline auth test.', type: 'invalid_request_error' } }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await assert.rejects(subject.runSyntheticProbe(
      subject.createNvidiaProvider('nvidia/nemotron-3-super-120b-a12b'),
      'nvidia/nemotron-3-super-120b-a12b', ':memory:', 'fixture-explicit-key',
    ));
    assert.equal(requests, 1, 'The explicit provider key must reach the transport without process.env mutation.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
