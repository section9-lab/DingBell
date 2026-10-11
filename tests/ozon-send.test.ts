import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendOzonMessage } from '../src/modules/ozon/send.ts';

const credentials = { clientId: '123456', apiKey: 'synthetic-send-key' };
const input = { chatId: '3000000000817031942', body: '  Здравствуйте!\n商品说明\t<b>作为纯文本</b>  ' };
const response = (value: unknown, status = 200): typeof fetch => (async () => Response.json(value, { status })) as typeof fetch;

test('sending uses the single fixed host, plaintext body and credentials without inventing a message receipt', async () => {
  let calls = 0;
  const result = await sendOzonMessage(credentials, input, (async (url, init) => {
    calls++;
    assert.equal(url, 'https://api-seller.ozon.ru/v1/chat/send/message');
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'manual'); assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get('Client-Id'), credentials.clientId);
    assert.equal(new Headers(init?.headers).get('Api-Key'), credentials.apiKey);
    assert.deepEqual(JSON.parse(String(init?.body)), { chat_id: input.chatId, text: input.body });
    return Response.json({ result: 'success', message_id: 123, ignored: true });
  }) as typeof fetch);
  assert.equal(calls, 1);
  assert.deepEqual(result, { outcome: 'sent', httpStatus: 200, providerResult: 'success', errorCode: null });
});

test('invalid credentials, identifiers and plaintext are rejected before dispatch without trimming or rounding', async () => {
  let calls = 0; const fetcher = (async () => { calls++; return Response.json({ result: 'success' }); }) as typeof fetch;
  for (const body of ['', ' \n\t ', 'a'.repeat(1001), '😀'.repeat(501), '\ud800', 'a\u0000b', 'a\u000bb', 'a\u007fb']) {
    const result = await sendOzonMessage(credentials, { ...input, body }, fetcher);
    assert.deepEqual(result, { outcome: 'failed', httpStatus: null, providerResult: null, errorCode: 'invalid_request' });
  }
  for (const chatId of ['', 'x'.repeat(257), 9007199254740992 as unknown as string]) assert.equal((await sendOzonMessage(credentials, { ...input, chatId }, fetcher)).errorCode, 'invalid_request');
  for (const value of [{ ...credentials, clientId: 'not-an-id' }, { ...credentials, apiKey: 'bad\nheader' }, { ...credentials, clientId: 123456 as unknown as string }, { ...credentials, apiKey: 123456 as unknown as string }]) assert.equal((await sendOzonMessage(value, input, fetcher)).errorCode, 'invalid_request');
  assert.equal(calls, 0);
  assert.equal((await sendOzonMessage(credentials, { ...input, body: 'a'.repeat(1000) }, fetcher)).outcome, 'sent');
  assert.equal(calls, 1);
});

test('only HTTP 200 with the documented success value is a confirmed platform acceptance', async () => {
  for (const body of [{}, { result: true }, { result: 'SUCCESS' }, { result: 'failed' }, { result: { success: true } }, [], null]) {
    const result = await sendOzonMessage(credentials, input, response(body));
    assert.deepEqual(result, { outcome: 'unknown', httpStatus: 200, providerResult: null, errorCode: 'invalid_response' });
  }
  for (const status of [201, 202]) assert.equal((await sendOzonMessage(credentials, input, response({ result: 'success' }, status))).outcome, 'unknown');
  assert.equal((await sendOzonMessage(credentials, input, (async () => new Response(null, { status: 204 })) as typeof fetch)).outcome, 'unknown');
});

test('explicit HTTP rejection is terminal for this attempt while other statuses remain unknown and all calls happen once', async () => {
  for (const [status, code] of [[400, 'invalid_request'], [401, 'invalid_credentials'], [403, 'permission_denied'], [404, 'not_found'], [422, 'rejected'], [429, 'rate_limited']] as const) {
    let calls = 0, cancelled = false;
    const result = await sendOzonMessage(credentials, input, (async () => { calls++; return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status }); }) as typeof fetch);
    assert.deepEqual(result, { outcome: 'failed', httpStatus: status, providerResult: null, errorCode: code });
    assert.equal(calls, 1); assert.equal(cancelled, true);
  }
  for (const status of [301, 302, 307, 308, 409, 500, 503]) {
    let calls = 0;
    const result = await sendOzonMessage(credentials, input, (async () => { calls++; return new Response('Do not expose response body', { status }); }) as typeof fetch);
    assert.equal(result.outcome, 'unknown'); assert.equal(result.httpStatus, status); assert.equal(result.providerResult, null); assert.equal(calls, 1);
  }
});

test('manual redirects never follow another location and every 3xx remains unknown after one request', async () => {
  for (const status of [300, 301, 302, 303, 304, 305, 306, 307, 308, 399]) {
    let calls = 0;
    const result = await sendOzonMessage(credentials, input, (async (url, init) => {
      calls++;
      assert.equal(url, 'https://api-seller.ozon.ru/v1/chat/send/message');
      assert.equal(init?.redirect, 'manual');
      return new Response(null, { status, headers: { Location: 'https://other.invalid/do-not-follow' } });
    }) as typeof fetch);
    assert.deepEqual(result, { outcome: 'unknown', httpStatus: status, providerResult: null, errorCode: 'redirect_refused' });
    assert.equal(calls, 1);
  }
});

test('Retry-After seconds and HTTP dates preserve the full cooldown without retrying the intent', async () => {
  for (const [header, expected] of [['120', 120000], ['999999999', 999999999000], ['-1', undefined], ['1.5', undefined], ['bad', undefined]] as const) {
    const result = await sendOzonMessage(credentials, input, (async () => new Response('', { status: 429, headers: { 'retry-after': header } })) as typeof fetch);
    assert.equal(result.retryAfterMs, expected);
  }
  const future = new Date(Date.now() + 120000).toUTCString();
  const result = await sendOzonMessage(credentials, input, (async () => new Response('', { status: 429, headers: { 'retry-after': future } })) as typeof fetch);
  assert.ok(result.retryAfterMs! > 118000 && result.retryAfterMs! <= 120000);
});

test('malformed, oversized and invalid UTF-8 responses remain unknown and streams are cancelled', async () => {
  for (const body of ['{', new Uint8Array([0xff]), 'x'.repeat(65537)]) {
    const result = await sendOzonMessage(credentials, input, (async () => new Response(body)) as typeof fetch);
    assert.deepEqual(result, { outcome: 'unknown', httpStatus: 200, providerResult: null, errorCode: 'invalid_response' });
  }
  for (const declared of [false, true]) {
    let cancelled = false;
    const stream = new ReadableStream({ start(controller) { if (!declared) controller.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; } });
    const result = await sendOzonMessage(credentials, input, (async () => new Response(stream, { headers: declared ? { 'content-length': '65537' } : {} })) as typeof fetch);
    assert.equal(result.outcome, 'unknown'); assert.equal(cancelled, true);
  }
});

test('fetch errors and in-flight aborts are unknown without exposing the key or message body', async () => {
  let calls = 0;
  const result = await sendOzonMessage(credentials, input, (async () => { calls++; throw new Error(credentials.apiKey + input.body); }) as typeof fetch);
  assert.deepEqual(result, { outcome: 'unknown', httpStatus: null, providerResult: null, errorCode: 'network_error' });
  assert.equal(JSON.stringify(result).includes(credentials.apiKey), false); assert.equal(JSON.stringify(result).includes(input.body), false); assert.equal(calls, 1);
  const controller = new AbortController();
  const pending = sendOzonMessage(credentials, input, (async () => { calls++; return new Promise<Response>(() => {}); }) as typeof fetch, controller.signal);
  controller.abort();
  assert.deepEqual(await pending, { outcome: 'unknown', httpStatus: null, providerResult: null, errorCode: 'aborted' });
  assert.equal(calls, 2);
  const before = await sendOzonMessage(credentials, input, (async () => { calls++; return Response.json({ result: 'success' }); }) as typeof fetch, controller.signal);
  assert.deepEqual(before, { outcome: 'failed', httpStatus: null, providerResult: null, errorCode: 'aborted_before_request' }); assert.equal(calls, 2);
});

test('timeout covers the entire response body and never retries or leaves its stream open', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0, cancelled = false;
  const pending = sendOzonMessage(credentials, input, (async () => { calls++; return new Response(new ReadableStream({ cancel() { cancelled = true; } })); }) as typeof fetch);
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(8000);
  assert.deepEqual(await pending, { outcome: 'unknown', httpStatus: 200, providerResult: null, errorCode: 'timed_out' });
  assert.equal(calls, 1); assert.equal(cancelled, true);
});
