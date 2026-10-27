import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { listOzonFbsPostings, readOzonFbsPosting, OzonReadError } from '../src/modules/orders/ozon.ts';

const credentials = { clientId: '123456', apiKey: 'synthetic-order-api-key' };
const window = { since: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z' };
const product = { sku: '9000000000817031941', offer_id: '0001-Артикул', name: 'Синтетический товар', quantity: 2, price: '1530.0000', currency_code: 'RUB' };
const posting = { posting_number: '12345-0001-1', order_id: '9000000000817031942', order_number: '12345-0001', status: 'awaiting_packaging', substatus: 'future_status_detail', products: [product], in_process_at: '2026-10-01T12:00:00Z', shipment_date: '2026-10-03T09:00:00Z', delivering_date: null, tracking_number: '' };
const expected = { postingNumber: posting.posting_number, orderId: posting.order_id, orderNumber: posting.order_number, status: posting.status, products: [{ sku: product.sku, offerId: product.offer_id, name: product.name, quantity: 2, price: '1530.0000', currency: 'RUB' }], inProcessAt: posting.in_process_at, shipmentDate: posting.shipment_date, deliveringDate: null, trackingNumber: null };
const response = (body: unknown): typeof fetch => (async () => Response.json(body)) as typeof fetch;
const fails = (code: string) => (error: unknown) => error instanceof OzonReadError && error.code === code && !JSON.stringify(error).includes(credentials.apiKey);

test('FBS listing uses the current cursor endpoint and freezes the supplied time window', async () => {
  let calls = 0;
  const result = await listOzonFbsPostings(credentials, { ...window, cursor: 'opaque-before', limit: 25 }, (async (input, init) => {
    calls++; assert.equal(String(input), 'https://api-seller.ozon.ru/v4/posting/fbs/list');
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'manual'); assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get('Api-Key'), credentials.apiKey);
    assert.deepEqual(JSON.parse(String(init?.body)), { filter: window, cursor: 'opaque-before', limit: 25 });
    return Response.json({ postings: [posting], has_next: true, cursor: 'opaque-after' });
  }) as typeof fetch);
  assert.equal(calls, 1); assert.deepEqual(result, { postings: [expected], cursor: 'opaque-after', hasNext: true });
});

test('FBS v4 listings accept the current nested money shape without weakening v3 detail parsing', async () => {
  const current = { ...posting, products: [{ ...product, price: { amount: product.price, currency: product.currency_code }, currency_code: undefined }] };
  const result = await listOzonFbsPostings(credentials, window, response({ postings: [current], has_next: false }));
  assert.deepEqual(result.postings, [expected]);
  for (const price of [{ amount: '1e5', currency: 'RUB' }, { amount: '1.00', currency: 643 }, { currency: 'RUB' }, []]) {
    await assert.rejects(listOzonFbsPostings(credentials, window, response({ postings: [{ ...current, products: [{ ...current.products[0], price }] }], has_next: false })), fails('invalid_response'));
  }
});

test('FBS terminal pages preserve observations without inventing a status version', async () => {
  let body: unknown;
  const result = await listOzonFbsPostings(credentials, window, (async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ postings: [{ ...posting, status: 'new_platform_enum', updated_at: 'unverified', status_changed_at: 'unverified', customer: { phone: 'not-retained' } }], has_next: false, cursor: 'ignored-terminal' });
  }) as typeof fetch);
  assert.deepEqual(body, { filter: window, limit: 50 });
  assert.deepEqual(result, { postings: [{ ...expected, status: 'new_platform_enum' }], cursor: null, hasNext: false });
  assert.deepEqual(await listOzonFbsPostings(credentials, window, response({ postings: [], has_next: false })), { postings: [], cursor: null, hasNext: false });
});

test('split postings share an order without losing packages or duplicate SKU lines', async () => {
  const second = { ...posting, posting_number: '12345-0001-2', products: [product, { ...product, quantity: 1 }] };
  const result = await listOzonFbsPostings(credentials, window, response({ postings: [posting, second], has_next: false }));
  assert.deepEqual(result.postings.map(row => row.postingNumber), ['12345-0001-1', '12345-0001-2']);
  assert.deepEqual(result.postings.map(row => row.orderId), [posting.order_id, posting.order_id]);
  assert.deepEqual(result.postings[1].products.map(item => item.quantity), [2, 1]);
});

test('FBS detail requests correlate the exact posting and retain decimal strings', async () => {
  let calls = 0;
  const result = await readOzonFbsPosting(credentials, { postingNumber: posting.posting_number }, (async (input, init) => {
    calls++; assert.equal(String(input), 'https://api-seller.ozon.ru/v3/posting/fbs/get');
    assert.deepEqual(JSON.parse(String(init?.body)), { posting_number: posting.posting_number });
    return Response.json({ result: { ...posting, products: [{ ...product, price: '99999999999999999999999.000000001' }], addressee: { phone: 'not-retained' }, financial_data: { unsupported: true } } });
  }) as typeof fetch);
  assert.equal(calls, 1);
  assert.deepEqual(result, { ...expected, products: [{ ...expected.products[0], price: '99999999999999999999999.000000001' }] });
  await assert.rejects(readOzonFbsPosting(credentials, { postingNumber: posting.posting_number }, response({ result: { ...posting, posting_number: 'another-package' } })), fails('invalid_response'));
});

test('optional business dates and product facts stay unknown instead of being synthesized', async () => {
  const minimal = { posting_number: posting.posting_number, order_id: posting.order_id, order_number: posting.order_number, status: 'new_state', products: [{ sku: product.sku, offer_id: product.offer_id, quantity: 1 }] };
  const result = await readOzonFbsPosting(credentials, { postingNumber: posting.posting_number }, response({ result: minimal }));
  assert.deepEqual(result, { postingNumber: posting.posting_number, orderId: posting.order_id, orderNumber: posting.order_number, status: 'new_state', products: [{ sku: product.sku, offerId: product.offer_id, quantity: 1, name: null, price: null, currency: null }], inProcessAt: null, shipmentDate: null, deliveringDate: null, trackingNumber: null });
});

test('invalid windows, cursor and local page budgets never reach Ozon', async () => {
  let calls = 0; const fetcher = (async () => { calls++; return Response.json({}); }) as typeof fetch;
  for (const options of [
    { ...window, since: window.to }, { ...window, since: '2026-10-09T00:00:00Z' }, { ...window, since: 'yesterday' },
    { since: '2026-02-30T00:00:00Z', to: '2026-03-02T00:00:00Z' }, { ...window, since: '2026-08-01T00:00:00Z' },
    ...[0, 101, 1.5, null].map(limit => ({ ...window, limit })), ...['', null, 'x'.repeat(4097)].map(cursor => ({ ...window, cursor })),
  ]) await assert.rejects(listOzonFbsPostings(credentials, options as Parameters<typeof listOzonFbsPostings>[1], fetcher), fails('invalid_request'));
  for (const postingNumber of ['', ' ', null, 123, 'x'.repeat(257)]) await assert.rejects(readOzonFbsPosting(credentials, { postingNumber } as { postingNumber: string }, fetcher), fails('invalid_request'));
  assert.equal(calls, 0);
  await listOzonFbsPostings(credentials, { since: '2026-09-01T00:00:00Z', to: '2026-10-02T00:00:00Z', limit: 100 }, response({ postings: [], has_next: false }));
});

test('FBS continuation requires bounded, nonempty and progressing provider metadata', async () => {
  for (const value of [
    { result: { postings: [], has_next: false } }, { postings: [], has_next: 'false' }, { postings: {} , has_next: false },
    { postings: [posting], has_next: true }, { postings: [posting], has_next: true, cursor: 'same' },
    { postings: [], has_next: true, cursor: 'next' }, { postings: [posting], has_next: true, cursor: 'x'.repeat(4097) },
    { postings: [posting], has_next: false, cursor: 123 }, { postings: [posting, posting], has_next: false },
  ]) await assert.rejects(listOzonFbsPostings(credentials, { ...window, cursor: 'same', limit: 1 }, response(value)), fails('invalid_response'));
});

test('malformed posting facts and numeric prices fail without pretending the order is absent', async () => {
  for (const value of [
    null, [], { ...posting, order_id: 1.5 }, { ...posting, order_number: {} }, { ...posting, status: '' },
    { ...posting, shipment_date: 'not-a-date' }, { ...posting, in_process_at: '2026-02-30T00:00:00Z' },
    { ...posting, products: null }, ...[
      { ...product, sku: 1.5 }, { ...product, quantity: -1 }, { ...product, quantity: 1.5 }, { ...product, quantity: Number.MAX_SAFE_INTEGER + 1 },
      { ...product, price: 1530 }, { ...product, price: '1e5' }, { ...product, price: '-1' }, { ...product, currency_code: 643 }, { ...product, name: 42 },
    ].map(item => ({ ...posting, products: [item] })),
  ]) await assert.rejects(readOzonFbsPosting(credentials, { postingNumber: posting.posting_number }, response({ result: value })), fails('invalid_response'));
});

test('FBS reads keep transport failures classified, sanitized and bounded without retries', async () => {
  for (const [status, code] of [[401, 'invalid_credentials'], [403, 'permission_denied'], [429, 'rate_limited'], [503, 'provider_unavailable'], [302, 'redirect_refused']] as const) {
    let calls = 0;
    await assert.rejects(listOzonFbsPostings(credentials, window, (async () => { calls++; return new Response(credentials.apiKey, { status, headers: { 'retry-after': '90000' } }); }) as typeof fetch), error => fails(code)(error) && (status !== 429 || (error as OzonReadError).retryAfterMs === 90_000_000));
    assert.equal(calls, 1);
  }
  let cancelled = false;
  await assert.rejects(readOzonFbsPosting(credentials, { postingNumber: posting.posting_number }, (async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': '1048577' } })) as typeof fetch), fails('invalid_response'));
  assert.equal(cancelled, true);
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(listOzonFbsPostings(credentials, window, (async () => { calls++; return Response.json({}); }) as typeof fetch, controller.signal), fails('aborted'));
  assert.equal(calls, 0);
  await assert.rejects(readOzonFbsPosting(credentials, { postingNumber: posting.posting_number }, (async () => new Response('{malformed')) as typeof fetch), fails('invalid_response'));
});

test('FBS order IDs and SKU numeric tokens remain lossless in Node and workerd', { timeout: 30_000 }, async context => {
  const body = JSON.stringify({ result: posting }).replaceAll('"9000000000817031942"', '9000000000817031942').replaceAll('"9000000000817031941"', '9000000000817031941');
  const result = await readOzonFbsPosting(credentials, { postingNumber: posting.posting_number }, (async () => new Response(body)) as typeof fetch);
  assert.deepEqual(result, expected);
  const listBody = JSON.stringify({ postings: [posting], has_next: false }).replaceAll('"9000000000817031942"', '9000000000817031942').replaceAll('"9000000000817031941"', '9000000000817031941');
  assert.deepEqual((await listOzonFbsPostings(credentials, window, (async () => new Response(listBody)) as typeof fetch)).postings, [expected]);
  const shared = stripTypeScriptTypes(readFileSync(new URL('../src/modules/ozon/read.ts', import.meta.url), 'utf8'));
  const source = stripTypeScriptTypes(readFileSync(new URL('../src/modules/orders/ozon.ts', import.meta.url), 'utf8')).replaceAll('../ozon/read.ts', './read.mjs');
  const mf = new Miniflare({ modules: [
    { type: 'ESModule', path: 'entry.mjs', contents: source + `\nexport default {async fetch(){const credentials=${JSON.stringify(credentials)};return Response.json({detail:await readOzonFbsPosting(credentials,{postingNumber:${JSON.stringify(posting.posting_number)}},async()=>new Response(${JSON.stringify(body)})),list:await listOzonFbsPostings(credentials,${JSON.stringify(window)},async()=>new Response(${JSON.stringify(listBody)}))})}}` },
    { type: 'ESModule', path: 'read.mjs', contents: shared },
  ], compatibilityDate: '2026-06-01' });
  context.after(() => mf.dispose());
  assert.deepEqual(await (await mf.dispatchFetch('https://fixture.invalid')).json(), { detail: expected, list: { postings: [expected], cursor: null, hasNext: false } });
});
