import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageImagePath, messageImageReference } from '../src/shared/message-images.ts';
import { encryptCredentials } from '../src/modules/stores/credentials.ts';
import { readMessageImage, MessageImageUnavailable } from '../src/modules/conversations/images.ts';
import { conversationsFixture } from './fixtures/conversations.ts';

const imageURL = 'https://api-seller.ozon.ru/v2/chat/file/messenger-rotated-3/synthetic-file.jpg';
const image = `![](${imageURL})`;
// A real, tiny PNG, not an upstream JSON or HTML error page masquerading as an image.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=', 'base64');
const response = () => new Response(png, { headers: { 'content-type': 'image/png', 'set-cookie': 'upstream=private', location: 'https://untrusted.invalid/' } });

async function fixture(fetcher: typeof fetch) {
  const f = await conversationsFixture({ storeFetch: fetcher });
  const bindings = { STORE_CREDENTIAL_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 7).toString('base64') }), STORE_CREDENTIAL_ACTIVE_KEY: 'v1' };
  const env = Object.assign(f.env, bindings);
  const envelope = await encryptCredentials(bindings, { orgId: 'company', storeId: 'store-a', platformStoreId: '1', credentialVersion: 1 }, { apiKey: 'synthetic-image-key' });
  try {
    await f.DB.batch([
      f.DB.prepare("UPDATE store SET credential_key_version=?,credential_nonce=?,credential_ciphertext=? WHERE id='store-a'").bind(envelope.keyVersion, envelope.nonce, envelope.ciphertext),
      f.DB.prepare(`INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode)
        VALUES('msg-image','company','store-a','conv-a','synthetic-image','Customer','inbound',?,1,0,500,500,'backfill')`).bind(JSON.stringify([image, 'https://cdn1.ozone.ru/synthetic.png', '图片说明'])),
      f.DB.prepare(`INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode)
        VALUES('msg-unsafe','company','store-a','conv-a','synthetic-unsafe','Customer','inbound','["https://untrusted.invalid/pixel.png"]',1,0,500,500,'backfill')`),
    ]);
    return { ...f, env };
  } catch (error) { await f.close(); throw error; }
}
const route = '/conv-a/messages/msg-image/images/0';

test('image references accept standalone Ozon Markdown and URLs, never arbitrary Markdown, HTML or endpoints', () => {
  assert.deepEqual(messageImageReference(image), { url: imageURL, authenticated: true });
  assert.deepEqual(messageImageReference(imageURL), { url: imageURL, authenticated: true });
  assert.deepEqual(messageImageReference(`  ![买家照片](${imageURL})  `), { url: imageURL, authenticated: true });
  assert.deepEqual(messageImageReference('https://cdn1.ozone.ru/synthetic.png'), { url: 'https://cdn1.ozone.ru/synthetic.png', authenticated: false });
  for (const unsafe of ['', 'javascript:alert(1)', 'data:image/svg+xml,test', '//api-seller.ozon.ru/v2/chat/file/a/b.jpg',
    'http://api-seller.ozon.ru/v2/chat/file/a/b.jpg', 'https://untrusted.invalid/image.jpg', 'https://api-seller.ozon.ru.evil.invalid/v2/chat/file/a/b.jpg',
    'https://cdn.ozone.ru.evil.invalid/image.png', 'https://127.0.0.1/image.jpg', 'https://user:password@api-seller.ozon.ru/v2/chat/file/a/b.jpg',
    'https://api-seller.ozon.ru/v2/chat/file/a/b.jpg?redirect=evil', 'https://api-seller.ozon.ru/v2/chat/file/a/b.jpg#hash',
    'https://api-seller.ozon.ru/v2/chat/file/a/../b/c.jpg', 'https://api-seller.ozon.ru/v2/chat/file/a/%2e%2e/c.jpg',
    'https://api-seller.ozon.ru/v2/chat/file/a/b.svg', 'https://api-seller.ozon.ru/v3/chat/list',
    `<img src="${imageURL}" onerror="alert(1)">`, `[打开](${imageURL})`, `${image} extra`, 'x'.repeat(4097)]) {
    assert.equal(messageImageReference(unsafe), null, unsafe);
  }
  assert.equal(messageImagePath('a/b', 'c?d', 'e#f', 2), '/api/companies/a%2Fb/conversations/c%3Fd/messages/e%23f/images/2');
});

test('image reads use server credentials only for the Seller API and return private bounded raster bytes', { timeout: 30000 }, async t => {
  const requests: { url: string; options: RequestInit }[] = [];
  const f = await fixture(async (url, options) => { requests.push({ url: String(url), options: options! }); return response(); }); t.after(f.close);
  const result = await f.request(route, 'staff');
  assert.equal(result.status, 200); assert.deepEqual(Buffer.from(await result.arrayBuffer()), png);
  assert.equal(result.headers.get('content-type'), 'image/png'); assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff'); assert.equal(result.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(result.headers.has('set-cookie'), false); assert.equal(result.headers.has('location'), false);
  assert.equal(requests[0].url, imageURL); assert.equal(requests[0].options.method, 'GET'); assert.equal(requests[0].options.redirect, 'manual');
  const headers = new Headers(requests[0].options.headers);
  assert.equal(headers.get('Client-Id'), '1'); assert.equal(headers.get('Api-Key'), 'synthetic-image-key'); assert.equal(headers.has('cookie'), false);
  assert.equal((await f.request('/conv-a/messages/msg-image/images/1')).status, 200);
  const cdnHeaders = new Headers(requests[1].options.headers); assert.equal(cdnHeaders.has('Api-Key'), false); assert.equal(cdnHeaders.has('Client-Id'), false);
});

test('image routes enforce company, conversation, message, index and current store grants before fetching', { timeout: 30000 }, async t => {
  let calls = 0; const f = await fixture(async () => { calls++; return response(); }); t.after(f.close);
  assert.equal((await f.request(route, 'anonymous')).status, 401);
  assert.equal((await f.request(route, 'other')).status, 404);
  for (const suffix of ['/conv-b/messages/msg-image/images/0', '/conv-a/messages/msg-b/images/0', '/conv-a/messages/missing/images/0',
    '/conv-a/messages/msg-a2/images/0', '/conv-a/messages/msg-image/images/2', '/conv-a/messages/msg-image/images/9',
    '/conv-a/messages/msg-image/images/-1', '/conv-a/messages/msg-image/images/01', '/conv-a/messages/msg-image/images/1000']) {
    assert.equal((await f.request(suffix)).status, 404, suffix);
  }
  assert.equal((await f.request(`${route}?url=https://untrusted.invalid`)).status, 400);
  await f.DB.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
  assert.equal((await f.request(route, 'staff')).status, 404);
  assert.equal((await f.request('/conv-a/messages/msg-unsafe/images/0')).status, 404); assert.equal(calls, 0);
});

test('provider failures, redirects, active documents, wrong signatures and oversized bodies never reach the browser', { timeout: 30000 }, async t => {
  let provider = response; const f = await fixture(async () => provider()); t.after(f.close);
  const cases = [
    () => new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/private' } }),
    () => new Response('secret upstream error', { status: 403 }),
    () => new Response('<svg onload="alert(1)"/>', { headers: { 'content-type': 'image/svg+xml' } }),
    () => new Response('<html>secret upstream error</html>', { headers: { 'content-type': 'image/png' } }),
    () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(4 * 1024 * 1024 + 1) } }),
    () => new Response(new Uint8Array(4 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }),
    () => { throw new Error('secret upstream error'); },
  ];
  for (const value of cases) {
    provider = value; const result = await f.request(route); assert.equal(result.status, 502);
    const text = await result.text(); assert.equal(JSON.parse(text).error.code, 'MESSAGE_IMAGE_UNAVAILABLE');
    assert.equal(text.includes('secret upstream error'), false); assert.equal(text.includes('synthetic-image-key'), false);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  await f.DB.prepare("UPDATE store SET status='disconnected' WHERE id='store-a'").run();
  provider = () => { assert.fail('disconnected stores cannot fetch files'); };
  assert.equal((await f.request(route)).status, 502);
});

test('image reads cancel on caller abort and bound stalled streams with an eight-second deadline', { timeout: 30000 }, async t => {
  const f = await fixture(async () => response()); t.after(f.close);
  const sessionId = (await f.DB.prepare("SELECT id FROM session WHERE user_id='owner'").first<string>('id'))!;
  const actor = { orgId: 'company', actorUserId: 'owner', sessionId };
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(readMessageImage(f.DB, f.env, actor, 'conv-a', 'msg-image', 0, async () => { assert.fail('Already aborted'); }, aborted.signal), MessageImageUnavailable);
  let cancelled = false;
  const controller = new AbortController();
  const pending = readMessageImage(f.DB, f.env, actor, 'conv-a', 'msg-image', 0, async () => {
    const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(png); queueMicrotask(() => controller.abort()); }, cancel() { cancelled = true; } });
    return new Response(body, { headers: { 'content-type': 'image/png' } });
  }, controller.signal);
  await assert.rejects(pending, MessageImageUnavailable); assert.equal(cancelled, true);
  let timedOut = false;
  await assert.rejects(readMessageImage(f.DB, f.env, actor, 'conv-a', 'msg-image', 0, async () =>
    new Response(new ReadableStream<Uint8Array>({ cancel() { timedOut = true; } }), { headers: { 'content-type': 'image/png' } })), MessageImageUnavailable);
  assert.equal(timedOut, true);
});

test('image delivery rechecks permissions and credential version after provider I/O', { timeout: 30000 }, async t => {
  let duringFetch = async () => {}; const f = await fixture(async () => { await duringFetch(); return response(); }); t.after(f.close);
  duringFetch = async () => { await f.DB.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run(); };
  assert.equal((await f.request(route, 'staff')).status, 404);
  duringFetch = async () => { await f.DB.prepare("UPDATE store SET credential_version=credential_version+1 WHERE id='store-a'").run(); };
  assert.equal((await f.request(route)).status, 404);
});
