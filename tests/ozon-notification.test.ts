import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OzonReadError } from '../src/modules/ozon/read.ts';
import { chatPushTypes, PushTypesInUse, registerOzonPushUrl } from '../src/modules/ozon/notification.ts';

const credentials = { clientId: '5476375', apiKey: 'synthetic-api-key' };
const callback = 'https://platform.example.invalid/api/ozon/push/6f1d1f7c-3f5e-4c47-9d6f-4c6f7d8e9a01/tokenABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abc';
const foreign = 'https://api.service.example.invalid/crontab/autopush?id=604887';

type Call = { path: string; body: unknown };

/** Mirrors the seller cabinet: URL entries carry `enable` and `types` as {type, description} objects. */
function ozonTypes(types: readonly string[]) {
  return types.map(type => ({ type, description: 'описание' }));
}

function provider(routes: Record<string, (body: any, call: Call) => unknown>) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? '{}'));
    const call = { path, body };
    calls.push(call);
    const handler = routes[`${init?.method ?? 'GET'} ${path}`];
    if (!handler) return new Response('{}', { status: 404 });
    const value = handler(body, call);
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch;
  return { calls, fetcher };
}

test('a fresh seller account registers, enables and reports the Ozon verdict', async () => {
  let registered = false;
  const { calls, fetcher } = provider({
    'POST /v1/notification/list': () => ({ urls: registered ? [{ id: 42, url: callback, enable: false, types: ozonTypes(chatPushTypes) }] : [] }),
    'POST /v1/notification/set': () => { registered = true; return {}; },
    'POST /v1/notification/enable': () => ({}),
    'POST /v1/notification/check': () => ({ is_active: true, errors: [] }),
  });
  const result = await registerOzonPushUrl(credentials, callback, fetcher);
  assert.deepEqual(calls.map(call => call.path), [
    '/v1/notification/list', '/v1/notification/set', '/v1/notification/list', '/v1/notification/enable', '/v1/notification/check',
  ]);
  assert.deepEqual(calls[1]!.body, { types: [...chatPushTypes], url: callback });
  assert.deepEqual(calls[3]!.body, { id: 42, enabled: true });
  assert.deepEqual(calls[4]!.body, { url: callback });
  assert.deepEqual(result, { registered: true, updated: false, enabled: true, isActive: true, errors: [], adopted: [] });
});

test('an existing enabled subscription for the same URL is reused and enabled again', async () => {
  const { calls, fetcher } = provider({
    'POST /v1/notification/list': () => ({ urls: [{ id: 7, url: callback, enable: true, types: ozonTypes(chatPushTypes) }] }),
    'POST /v1/notification/enable': () => ({}),
    'POST /v1/notification/check': () => ({ is_active: true, errors: [] }),
  });
  const result = await registerOzonPushUrl(credentials, callback, fetcher);
  assert.deepEqual(calls.map(call => call.path), ['/v1/notification/list', '/v1/notification/enable', '/v1/notification/check']);
  assert.equal(result.updated, false);
  assert.equal(result.enabled, true);
});

test('a subscription that misses one type is widened without dropping the others', async () => {
  const { calls, fetcher } = provider({
    'POST /v1/notification/list': () => ({ urls: [{ id: 9, url: callback, enable: true, types: [...ozonTypes(['TYPE_NEW_MESSAGE', 'TYPE_ORDER_STATUS'])] }] }),
    'POST /v1/notification/update': () => ({}),
    'POST /v1/notification/enable': () => ({}),
    'POST /v1/notification/check': () => ({ is_active: true, errors: [] }),
  });
  const result = await registerOzonPushUrl(credentials, callback, fetcher);
  const update = calls.find(call => call.path === '/v1/notification/update')!;
  assert.deepEqual(update.body, { id: 9, url: callback, types: [...new Set(['TYPE_NEW_MESSAGE', 'TYPE_ORDER_STATUS', ...chatPushTypes])] });
  assert.equal(result.updated, true);
});

test('another URL owning the chat types is reported as a conflict, not an outage', async () => {
  const { calls, fetcher } = provider({
    'POST /v1/notification/list': () => ({ urls: [{ id: 371935, url: foreign, enable: false, types: ozonTypes(chatPushTypes) }] }),
  });
  await assert.rejects(() => registerOzonPushUrl(credentials, callback, fetcher), (error: unknown) => {
    assert.ok(error instanceof PushTypesInUse);
    assert.deepEqual(error.conflicts.map(row => ({ id: row.id, url: row.url })), [{ id: 371935, url: foreign }]);
    return true;
  });
  assert.deepEqual(calls.map(call => call.path), ['/v1/notification/list']);
});

test('takeover moves only the chat types and keeps the previous destination for the rest', async () => {
  let freed = false;
  const { calls, fetcher } = provider({
    'POST /v1/notification/list': () => ({
      urls: freed
        ? [{ id: 371935, url: foreign, enable: false, types: ozonTypes(['TYPE_NEW_POSTING']) }, { id: 55, url: callback, enable: false, types: ozonTypes(chatPushTypes) }]
        : [{ id: 371935, url: foreign, enable: false, types: ozonTypes([...chatPushTypes, 'TYPE_NEW_POSTING']) }],
    }),
    'POST /v1/notification/update': () => { freed = true; return {}; },
    'POST /v1/notification/set': () => ({}),
    'POST /v1/notification/enable': () => ({}),
    'POST /v1/notification/check': () => ({ is_active: false, errors: [{ type: 'WRONG_RESULT_FIELD', description: 'шаблон' }] }),
  });
  const result = await registerOzonPushUrl(credentials, callback, fetcher, { takeOver: true });
  const update = calls.find(call => call.path === '/v1/notification/update')!;
  assert.deepEqual(update.body, { id: 371935, types: ['TYPE_NEW_POSTING'], url: foreign });
  assert.deepEqual(calls.find(call => call.path === '/v1/notification/set')!.body, { types: [...chatPushTypes], url: callback });
  assert.deepEqual(calls.find(call => call.path === '/v1/notification/enable')!.body, { id: 55, enabled: true });
  assert.deepEqual(result.adopted, [{ id: 371935, url: foreign, types: [...chatPushTypes] }]);
  assert.deepEqual(result.errors, ['шаблон']);
});

test('takeover deletes a subscription that would be left without any type', async () => {
  let freed = false;
  const { calls, fetcher } = provider({
    'POST /v1/notification/list': () => ({
      urls: freed ? [{ id: 88, url: callback, enable: false, types: ozonTypes(chatPushTypes) }] : [{ id: 371935, url: foreign, enable: false, types: ozonTypes(chatPushTypes) }],
    }),
    'POST /v1/notification/delete': () => { freed = true; return {}; },
    'POST /v1/notification/set': () => ({}),
    'POST /v1/notification/enable': () => ({}),
    'POST /v1/notification/check': () => ({ is_active: true, errors: [] }),
  });
  await registerOzonPushUrl(credentials, callback, fetcher, { takeOver: true });
  assert.deepEqual(calls.find(call => call.path === '/v1/notification/delete')!.body, { id: 371935 });
  assert.equal(calls.some(call => call.path === '/v1/notification/update'), false);
});

test('a type claimed between list and set is still reported as a conflict', async () => {
  const { fetcher } = provider({
    'POST /v1/notification/list': () => ({ urls: [] }),
    'POST /v1/notification/set': () => Response.json({ code: 3, message: 'Type already in use: TYPE_CHAT_CLOSED' }, { status: 400 }),
  });
  await assert.rejects(() => registerOzonPushUrl(credentials, callback, fetcher), (error: unknown) => {
    assert.ok(error instanceof PushTypesInUse);
    return true;
  });
});

test('a failed handshake surfaces Ozon errors instead of claiming success', async () => {
  let registered = false;
  const { fetcher } = provider({
    'POST /v1/notification/list': () => ({ urls: registered ? [{ id: 12, url: callback, enable: true, types: ozonTypes(chatPushTypes) }] : [] }),
    'POST /v1/notification/set': () => { registered = true; return {}; },
    'POST /v1/notification/enable': () => ({}),
    'POST /v1/notification/check': () => ({ is_active: false, errors: [{ type: 'REQUEST_ERROR', description: 'URL is not reachable' }] }),
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
