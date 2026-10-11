import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectOzonCapabilities } from '../src/modules/stores/ozon.ts';

const credentials = { clientId: '123456', apiKey: 'synthetic-store-api-key' };
const responses: Record<string, unknown> = {
  '/v1/roles': { roles: [{ name: 'Admin', methods: ['/v1/chat/send/message'] }] },
  '/v3/product/list': { result: { items: [] } },
  '/v3/chat/list': { chats: [], has_next: false },
  '/v4/posting/fbs/list': { postings: [], has_next: false },
};

test('only the four bounded read operations are called and roles never enable replies', async () => {
  const paths: string[] = [];
  const result = await inspectOzonCapabilities(credentials, (async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    assert.equal(url.origin, 'https://api-seller.ozon.ru');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get('Api-Key'), credentials.apiKey);
    return Response.json(responses[url.pathname]);
  }) as typeof fetch);
  assert.deepEqual(paths, Object.keys(responses));
  assert.deepEqual(result.map(item => [item.code, item.status]), [
    ['auth', 'available'], ['products_read', 'available'], ['chats_read', 'available'],
    ['orders_fbs_read', 'available'], ['reply', 'unknown'], ['proactive_chat', 'unknown'],
  ]);
  assert.equal(JSON.stringify(result).includes(credentials.apiKey), false);
});

test('a rejected authorization stops secondary probes and distinguishes temporary or invalid responses', async () => {
  for (const [status, expected, reason] of [[401, 'denied', 'invalid_credentials'], [403, 'denied', 'permission_denied'], [429, 'unknown', 'rate_limited'], [503, 'unknown', 'provider_unavailable'], [302, 'unknown', 'redirect_refused']] as const) {
    let calls = 0;
    const result = await inspectOzonCapabilities(credentials, (async () => {
      calls++;
      return new Response('synthetic-secret-upstream-body', { status });
    }) as typeof fetch);
    assert.equal(calls, 1);
    assert.deepEqual(result[0], { code: 'auth', status: expected, reason });
    assert.equal(result[1].status, 'unknown');
    assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
  }
});

test('malformed, excessive and interrupted response bodies never become available or expose upstream details', async () => {
  for (const response of [Response.json({ roles: 'wrong' }), new Response('x'.repeat(65_537)), new Response('{')]) {
    const result = await inspectOzonCapabilities(credentials, (async () => response) as typeof fetch);
    assert.equal(result[0].status, 'unknown');
    assert.equal(result[0].reason, 'invalid_response');
  }
  const result = await inspectOzonCapabilities(credentials, (async () => { throw new Error(credentials.apiKey); }) as typeof fetch);
  assert.equal(result[0].reason, 'network_error');
  assert.equal(JSON.stringify(result).includes(credentials.apiKey), false);
});

test('each endpoint is assessed independently without promoting an unreadable chat API or FBS sample to broad order access', async () => {
  const result = await inspectOzonCapabilities(credentials, (async input => {
    const path = new URL(String(input)).pathname;
    return path === '/v3/chat/list' ? new Response('', { status: 403 }) : Response.json(responses[path]);
  }) as typeof fetch);
  assert.equal(result.find(item => item.code === 'chats_read')?.status, 'denied');
  assert.equal(result.find(item => item.code === 'orders_fbs_read')?.status, 'available');
  assert.equal(result.find(item => item.code === 'reply')?.status, 'unknown');
});

test('an oversized declared response is cancelled before returning without draining an unbounded body', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const result = await inspectOzonCapabilities(credentials, (async () => new Response(stream, { headers: { 'content-length': '65537' } })) as typeof fetch);
  assert.equal(result[0].reason, 'invalid_response');
  assert.equal(cancelled, true);
});
