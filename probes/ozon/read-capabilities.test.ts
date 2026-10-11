import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOzonCapabilities } from './read-capabilities.ts';

const credentials = { clientId: 'synthetic-client', apiKey: 'synthetic-key' };
const now = new Date('2026-10-09T00:00:00Z');

test('the cloud read probe uses only fixed read endpoints and returns no merchant or customer data', async () => {
  const requests: string[] = [];
  const responses = [
    { roles: [{ name: 'fixture', methods: ['/v3/chat/list'] }] },
    { result: { items: [{ product_id: 'private-product', offer_id: 'private-offer' }], total: 1 } },
    { chats: [{ chat: { chat_id: 'private-chat', chat_type: 'BUYER_SELLER' }, last_message: 'private-text' }], has_next: true },
    { postings: [{ posting_number: 'private-posting', customer: { name: 'private-buyer' } }], has_next: false },
  ];
  const result = await readOzonCapabilities(credentials, async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api-seller.ozon.ru');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Client-Id'), credentials.clientId);
    assert.equal(headers.get('Api-Key'), credentials.apiKey);
    requests.push(url.pathname);
    return Response.json(responses[requests.length - 1]);
  }, now);
  assert.deepEqual(requests, ['/v1/roles', '/v3/product/list', '/v3/chat/list', '/v4/posting/fbs/list']);
  assert.deepEqual(result.checks.map(check => check.available), [true, true, true, true]);
  assert.deepEqual(result.checks.slice(1).map(check => check.sampleCount), [1, 1, 1]);
  for (const secret of [...Object.values(credentials), 'private-']) assert.equal(JSON.stringify(result).includes(secret), false);
});

test('missing credentials and rejected authentication never trigger further store requests', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json({ message: credentials.apiKey }, { status: 403 }); };
  await assert.rejects(readOzonCapabilities({ clientId: '', apiKey: '' }, fetcher, now), /configuration/);
  assert.equal(calls, 0);
  const result = await readOzonCapabilities(credentials, fetcher, now);
  assert.equal(calls, 1);
  assert.equal(result.checks[0].httpStatus, 403);
  assert.equal(result.checks[0].available, false);
  assert.equal(JSON.stringify(result).includes(credentials.apiKey), false);
});

test('redirects and malformed success responses are not reported as available', async () => {
  for (const response of [new Response(null, { status: 302, headers: { location: 'https://example.invalid' } }), Response.json({ roles: 'invalid' })]) {
    let calls = 0;
    const result = await readOzonCapabilities(credentials, async () => { calls++; return response; }, now);
    assert.equal(calls, 1);
    assert.equal(result.checks[0].available, false);
  }
});
