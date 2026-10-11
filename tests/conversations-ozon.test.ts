import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { listOzonChats, OzonReadError, readOzonMessages } from '../src/modules/conversations/ozon.ts';

const credentials = { clientId: '123456', apiKey: 'synthetic-store-api-key' };
const chat = { chat: { chat_id: 'synthetic-chat', chat_type: 'BUYER_SELLER', chat_status: 'OPENED', created_at: '2026-10-09T10:00:00Z' }, last_message_id: '3000000000817031942', first_unread_message_id: '3000000000817031940', unread_count: 2 };
const message = { message_id: '3000000000817031942', created_at: '2026-10-09T10:00:00Z', user: { id: '3000000000817031941', type: 'Сustomer' }, data: ['Здравствуйте', '<script>untrusted</script>'], is_image: false, is_read: false, context: { order_number: '001-TEST', sku: '3000000000817031939' } };
const response = (value: unknown): typeof fetch => (async () => Response.json(value)) as typeof fetch;
const fails = (code: string) => (error: unknown) => error instanceof OzonReadError && error.code === code && !JSON.stringify(error).includes(credentials.apiKey);

test('chat pages use the fixed read endpoint and preserve provider identity, channel and cursor', async () => {
  let calls = 0;
  const result = await listOzonChats(credentials, { cursor: 'opaque-page' }, (async (input, init) => {
    calls++;
    assert.equal(String(input), 'https://api-seller.ozon.ru/v3/chat/list');
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'manual'); assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get('Api-Key'), credentials.apiKey);
    assert.deepEqual(JSON.parse(String(init?.body)), { limit: 50, cursor: 'opaque-page' });
    return Response.json({ chats: [chat, { ...chat, chat: { ...chat.chat, chat_id: 'support', chat_type: 'SELLER_SUPPORT' } }], cursor: 'opaque-next', has_next: true });
  }) as typeof fetch);
  assert.equal(calls, 1); assert.equal(result.cursor, 'opaque-next'); assert.equal(result.hasNext, true);
  assert.deepEqual(result.chats[0], { id: 'synthetic-chat', type: 'BUYER_SELLER', status: 'OPENED', createdAt: chat.chat.created_at, lastMessageId: chat.last_message_id, firstUnreadMessageId: chat.first_unread_message_id, unreadCount: 2 });
  assert.equal(result.chats[1].type, 'SELLER_SUPPORT');
});

test('history sends an exact large integer cursor and retains source data without fetching attachments', async () => {
  let calls = 0;
  const result = await readOzonMessages(credentials, { chatId: 'synthetic-chat', direction: 'Backward', fromMessageId: message.message_id }, (async (input, init) => {
    calls++;
    assert.equal(String(input), 'https://api-seller.ozon.ru/v3/chat/history');
    assert.match(String(init?.body), /"from_message_id":3000000000817031942(?:,|})/);
    assert.equal(JSON.parse(String(init?.body)).direction, 'Backward');
    return Response.json({ messages: [message, { ...message, message_id: '3000000000817031940', is_image: true, data: ['https://untrusted.invalid/image'] }], has_next: false });
  }) as typeof fetch);
  assert.equal(calls, 1); assert.equal(result.hasNext, false);
  assert.deepEqual(result.messages[0], { id: message.message_id, createdAt: message.created_at, senderId: message.user.id, senderType: 'Сustomer', content: message.data, isImage: false, isRead: false, orderNumber: '001-TEST', sku: message.context.sku });
  assert.equal(result.messages[1].isImage, true);
});

test('numeric ID tokens retain exact digits in both Node and the deployed workerd runtime', { timeout: 30_000 }, async context => {
  const body = JSON.stringify({ messages: [message], has_next: false }).replaceAll('"3000000000817031942"', '3000000000817031942').replaceAll('"3000000000817031941"', '3000000000817031941').replaceAll('"3000000000817031939"', '3000000000817031939');
  const fetcher = (async () => new Response(body)) as typeof fetch;
  const result = await readOzonMessages(credentials, { chatId: 'synthetic-chat', direction: 'Backward' }, fetcher);
  assert.equal(result.messages[0].id, message.message_id); assert.equal(result.messages[0].senderId, message.user.id); assert.equal(result.messages[0].sku, message.context.sku);
  const source = stripTypeScriptTypes(readFileSync(new URL('../src/modules/conversations/ozon.ts', import.meta.url), 'utf8')).replaceAll('../ozon/read.ts', './read.mjs');
  const shared = stripTypeScriptTypes(readFileSync(new URL('../src/modules/ozon/read.ts', import.meta.url), 'utf8'));
  const mf = new Miniflare({ modules: [{ type: 'ESModule', path: 'entry.mjs', contents: source + `\nexport default {async fetch(){return Response.json(await readOzonMessages(${JSON.stringify(credentials)}, {chatId:'synthetic-chat',direction:'Backward'}, async()=>new Response(${JSON.stringify(body)})))}}` }, { type: 'ESModule', path: 'read.mjs', contents: shared }], compatibilityDate: '2026-06-01' });
  context.after(() => mf.dispose());
  const remote = await (await mf.dispatchFetch('https://fixture.invalid')).json();
  assert.deepEqual(remote, result);
});

test('invalid paging requests fail before touching the provider', async () => {
  let calls = 0; const fetcher = (async () => { calls++; return Response.json({}); }) as typeof fetch;
  for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: 'x'.repeat(4097) }]) await assert.rejects(listOzonChats(credentials, options, fetcher), fails('invalid_request'));
  for (const options of [{ chatId: '', direction: 'Backward' }, { chatId: 'chat', direction: 'Forward' }, { chatId: 'chat', direction: 'Backward', fromMessageId: '1,"limit":1000' }, { chatId: 'chat', direction: 'Backward', fromMessageId: '1e20' }]) await assert.rejects(readOzonMessages(credentials, options as Parameters<typeof readOzonMessages>[1], fetcher), fails('invalid_request'));
  assert.equal(calls, 0);
});

test('malformed pages cannot be acknowledged as empty or have their cursor advanced', async () => {
  for (const body of [{ chats: [], has_next: 'false' }, { chats: [chat], has_next: true }, { chats: [], has_next: true, cursor: 'next' }, { chats: [{ ...chat, unread_count: -1 }], has_next: false }, { chats: [{ ...chat, chat: { ...chat.chat, created_at: 'not-a-date' } }], has_next: false }, { chats: [{ ...chat, chat: { ...chat.chat, created_at: '2026-10-09T10:00:00' } }], has_next: false }]) await assert.rejects(listOzonChats(credentials, {}, response(body)), fails('invalid_response'));
  for (const body of [{ messages: [], has_next: true }, { messages: [{ ...message, data: {} }], has_next: false }, { messages: [{ ...message, message_id: 'not-numeric' }], has_next: false }, { messages: [{ ...message, is_read: 'false' }], has_next: false }]) await assert.rejects(readOzonMessages(credentials, { chatId: 'chat', direction: 'Backward' }, response(body)), fails('invalid_response'));
  assert.deepEqual(await listOzonChats(credentials, {}, response({ chats: [], has_next: false })), { chats: [], cursor: null, hasNext: false });
});

test('provider errors are classified without raw bodies, redirects or automatic retries', async () => {
  for (const [status, code] of [[401, 'invalid_credentials'], [403, 'permission_denied'], [429, 'rate_limited'], [503, 'provider_unavailable'], [302, 'redirect_refused']] as const) {
    let calls = 0; let cancelled = false;
    await assert.rejects(listOzonChats(credentials, {}, (async () => { calls++; return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status }); }) as typeof fetch), fails(code));
    assert.equal(calls, 1); assert.equal(cancelled, true);
  }
  await assert.rejects(listOzonChats(credentials, {}, (async () => { throw new Error(credentials.apiKey); }) as typeof fetch), fails('network_error'));
});

test('rate limiting preserves Retry-After seconds and HTTP dates without shortening long provider delays', async () => {
  for (const [header, expected] of [['120', 120_000], ['999999999', 999_999_999_000], ['-1', undefined], ['garbage', undefined]] as const) {
    await assert.rejects(listOzonChats(credentials, {}, (async () => new Response('', { status: 429, headers: { 'retry-after': header } })) as typeof fetch), error => fails('rate_limited')(error) && (error as OzonReadError).retryAfterMs === expected);
  }
  const future = new Date(Date.now() + 120_000).toUTCString();
  await assert.rejects(listOzonChats(credentials, {}, (async () => new Response('', { status: 429, headers: { 'retry-after': future } })) as typeof fetch), error => fails('rate_limited')(error) && (error as OzonReadError).retryAfterMs! > 118_000 && (error as OzonReadError).retryAfterMs! <= 120_000);
});

test('oversized, malformed, or interrupted response bodies are bounded and cancelled', async () => {
  for (const declared of [false, true]) {
    let cancelled = false;
    const stream = new ReadableStream({ start(controller) { if (!declared) controller.enqueue(new Uint8Array(1_048_577)); }, cancel() { cancelled = true; } });
    await assert.rejects(listOzonChats(credentials, {}, (async () => new Response(stream, { headers: declared ? { 'content-length': '1048577' } : {} })) as typeof fetch), fails('invalid_response'));
    assert.equal(cancelled, true);
  }
  await assert.rejects(listOzonChats(credentials, {}, (async () => new Response('{')) as typeof fetch), fails('invalid_response'));
});

test('caller cancellation rejects an in-flight fetch and prevents an already-aborted request', async () => {
  const controller = new AbortController(); let calls = 0;
  const promise = listOzonChats(credentials, {}, (async (_input, init) => { calls++; assert.ok(init?.signal); return new Promise<Response>(() => {}); }) as typeof fetch, controller.signal);
  controller.abort(); await assert.rejects(promise, fails('aborted')); assert.equal(calls, 1);
  await assert.rejects(listOzonChats(credentials, {}, (async () => { calls++; return Response.json({}); }) as typeof fetch, controller.signal), fails('aborted')); assert.equal(calls, 1);
});

test('caller cancellation during a response body closes the stream without exposing partial data', async () => {
  const controller = new AbortController(); let cancelled = false;
  const promise = readOzonMessages(credentials, { chatId: 'chat', direction: 'Backward' }, (async () => new Response(new ReadableStream({ pull() { controller.abort(); }, cancel() { cancelled = true; } }))) as typeof fetch, controller.signal);
  await assert.rejects(promise, fails('aborted')); assert.equal(cancelled, true);
});

test('known chat IDs still reject fractional, negative and exponent tokens while unknown fields remain forward-compatible', async () => {
  for (const token of ['-1', '1.25', '1e20']) {
    const body = JSON.stringify({ messages: [message], has_next: false }).replace(`"message_id":"${message.message_id}"`, `"message_id":${token}`);
    await assert.rejects(readOzonMessages(credentials, { chatId: 'chat', direction: 'Backward' }, (async () => new Response(body)) as typeof fetch), fails('invalid_response'));
  }
  const page = await listOzonChats(credentials, {}, response({ chats: [{ ...chat, unknown: { id: 1.25 } }], has_next: false }));
  assert.equal(page.chats[0].id, chat.chat.chat_id);
});

test('the eight-second deadline also bounds a response whose stream never settles', { timeout: 12_000 }, async () => {
  let cancelled = false;
  const started = Date.now();
  await assert.rejects(listOzonChats(credentials, {}, (async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))) as typeof fetch), fails('timed_out'));
  assert.ok(Date.now() - started >= 7_500); assert.equal(cancelled, true);
});
