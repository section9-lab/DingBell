import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OzonReadError } from '../src/modules/ozon/read.ts';
import { chatPushTypes, registerOzonPushUrl } from '../src/modules/ozon/notification.ts';

const credentials = { clientId: '5476375', apiKey: 'synthetic-api-key' };
const callback = 'https://platform.example.invalid/api/ozon/push/6f1d1f7c-3f5e-4c47-9d6f-4c6f7d8e9a01/tokenABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abc';

type Call = { path: string; body: unknown };

function provider(routes: Record<string, (body: unknown) => unknown>) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
    const handler = routes[`${init?.method ?? 'GET'} ${path}`];
    if (!handler) return new Response('{}', { status: 404 });
    const value = handler(calls.at(-1)!.body);
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch;
  return { calls, fetcher };
}

test('a fresh seller account registers the callback and reports the Ozon verdict', async () => {
  const { calls, fetcher } = provider({
    'POST /v1/notification/list': () => ({ urls: [] }),
    'POST /v1/notification/set': () => ({}),
    'POST /v1/notification/check': () => ({ is_active: true, errors: [] }),
  });
  const result = await registerOzonPushUrl(credentials, callback, fetcher);
  assert.deepEqual(calls.map(call => call.path), ['/v1/notification/list', '/v1/notification/set', '/v1/notification/check']);
  assert.deepEqual(calls[1]!.body, { types: [...chatPushTypes], url: callback });
  assert.deepEqual(calls[2]!.body, { url: callback });
  assert.deepEqual(result, { registered: true, updated: false, isActive: true, errors: [] });
});

test('an existing subscription for the same URL is reused instead of duplicated', async () => {
  const { calls, fetcher } = provider({
    'POST /v1/notification/list': () => ({ urls: [{ id: 7, url: callback, types: [...chatPushTypes] }] }),
    'POST /v1/notification/check': () => ({ is_active: true, errors: [] }),
  });
  const result = await registerOzonPushUrl(credentials, callback, fetcher);
  assert.deepEqual(calls.map(call => call.path), ['/v1/notification/list', '/v1/notification/check']);
  assert.equal(result.updated, false);
});

test('a subscription that misses one type is widened without dropping the others', async () => {
  const { calls, fetcher } = provider({
    'POST /v1/notification/list': () => ({ urls: [{ id: 9, url: callback, types: ['TYPE_NEW_MESSAGE', 'TYPE_ORDER_STATUS'] }] }),
    'POST /v1/notification/update': () => ({}),
    'POST /v1/notification/check': () => ({ is_active: true, errors: [] }),
  });
  const result = await registerOzonPushUrl(credentials, callback, fetcher);
  const update = calls.find(call => call.path === '/v1/notification/update')!;
  assert.deepEqual(update.body, { id: 9, url: callback, types: [...new Set(['TYPE_NEW_MESSAGE', 'TYPE_ORDER_STATUS', ...chatPushTypes])] });
  assert.equal(result.updated, true);
});

test('a failed handshake surfaces Ozon errors instead of claiming success', async () => {
  const { fetcher } = provider({
    'POST /v1/notification/list': () => ({ urls: [] }),
    'POST /v1/notification/set': () => ({}),
    'POST /v1/notification/check': () => ({ is_active: false, errors: [{ code: 'HTTP_404', message: 'URL is not reachable' }] }),
  });
  const result = await registerOzonPushUrl(credentials, callback, fetcher);
  assert.equal(result.isActive, false);
  assert.deepEqual(result.errors, ['URL is not reachable']);
});

test('seller-cabinet rejections keep their Ozon error classification', async () => {
  const { fetcher } = provider({ 'POST /v1/notification/list': () => new Response('{}', { status: 403 }) });
  await assert.rejects(() => registerOzonPushUrl(credentials, callback, fetcher), (error: unknown) => {
    assert.ok(error instanceof OzonReadError);
    assert.equal(error.code, 'permission_denied');
    return true;
  });
});

test('an incremental read path stays outside the configuration writer', async () => {
  const { writeOzonJSON } = await import('../src/modules/ozon/read.ts');
  await assert.rejects(() => writeOzonJSON(credentials, '/v3/chat/list' as never, '{}', fetch), (error: unknown) => {
    assert.ok(error instanceof OzonReadError);
    assert.equal(error.code, 'invalid_request');
    return true;
  });
});
