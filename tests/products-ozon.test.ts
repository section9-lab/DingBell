import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { listOzonProducts, readOzonProductDetails, OzonReadError } from '../src/modules/products/ozon.ts';
import { readOzonJSON } from '../src/modules/ozon/read.ts';

const credentials = { clientId: '123456', apiKey: 'synthetic-product-api-key' };
const listing = { product_id: '9000000000817031942', offer_id: '0001-Артикул', sku: '9000000000817031941', archived: false, has_fbo_stocks: false, has_fbs_stocks: true };
const detail = { id: listing.product_id, offer_id: listing.offer_id, name: 'Синтетический товар', sku: listing.sku, sources: [{ sku: listing.sku, source: 'fbs', unknown_detail: 'ignored' }], price: '1530.0000', currency_code: 'RUB', is_archived: false };
const response = (body: unknown): typeof fetch => (async () => Response.json(body)) as typeof fetch;
const fails = (code: string) => (error: unknown) => error instanceof OzonReadError && error.code === code && !JSON.stringify(error).includes(credentials.apiKey);

test('catalog reads retain provider IDs and flags using only the current read-only endpoint', async () => {
  let calls = 0;
  const page = await listOzonProducts(credentials, { lastId: 'opaque-old', limit: 25 }, (async (input, init) => {
    calls++; assert.equal(String(input), 'https://api-seller.ozon.ru/v3/product/list');
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'manual'); assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get('Api-Key'), credentials.apiKey);
    assert.deepEqual(JSON.parse(String(init?.body)), { filter: { visibility: 'ALL' }, last_id: 'opaque-old', limit: 25 });
    return Response.json({ result: { items: [listing], last_id: 'opaque-new', total: 1, unknown: { id: 1.5 } } });
  }) as typeof fetch);
  assert.equal(calls, 1);
  assert.deepEqual(page, { items: [{ id: listing.product_id, offerId: listing.offer_id, sku: listing.sku, archived: false, hasFboStocks: false, hasFbsStocks: true }], lastId: 'opaque-new', reportedTotal: 1 });
});

test('short pages and changing totals never fabricate a terminal flag or delete missing products', async () => {
  for (const total of [0, 1, 999]) {
    const page = await listOzonProducts(credentials, {}, response({ result: { items: [listing], last_id: 'next', total } }));
    assert.equal(page.items.length, 1); assert.equal(page.lastId, 'next'); assert.equal(page.reportedTotal, total);
    assert.equal('hasNext' in page, false);
  }
  assert.deepEqual(await listOzonProducts(credentials, { lastId: 'previous' }, response({ result: { items: [], last_id: 'previous', total: 12 } })), { items: [], lastId: 'previous', reportedTotal: 12 });
});

test('nonempty catalog pages must make explicit cursor progress and contain valid bounded metadata', async () => {
  for (const result of [
    { items: [listing], last_id: 'same', total: 1 }, { items: [listing], last_id: '', total: 1 },
    { items: [listing], total: 1 }, { items: [], last_id: '', total: '0' },
    { items: [listing], last_id: 'next', total: -1 },
    { items: [{ ...listing, archived: 'false' }], last_id: 'next', total: 1 },
    { items: [{ ...listing, product_id: 1.5 }], last_id: 'next', total: 1 },
  ]) await assert.rejects(listOzonProducts(credentials, { lastId: 'same' }, response({ result })), fails('invalid_response'));
  await assert.rejects(listOzonProducts(credentials, { limit: 1 }, response({ result: { items: [listing, listing], last_id: 'next', total: 2 } })), fails('invalid_response'));
});

test('detail reads correlate requested IDs and preserve raw decimal prices and source SKU relationships', async () => {
  let calls = 0;
  const result = await readOzonProductDetails(credentials, { productIds: [listing.product_id] }, (async (input, init) => {
    calls++; assert.equal(String(input), 'https://api-seller.ozon.ru/v3/product/info/list');
    assert.deepEqual(JSON.parse(String(init?.body)), { product_id: [listing.product_id] });
    return Response.json({ items: [{ ...detail, images: ['https://not-fetched.invalid/picture'], unknown: { id: 1.5 }, updated_at: 'not-a-source-version' }] });
  }) as typeof fetch);
  assert.equal(calls, 1);
  assert.deepEqual(result.items, [{ id: listing.product_id, offerId: listing.offer_id, name: detail.name, sku: listing.sku, sources: [{ sku: listing.sku, source: 'fbs' }], price: '1530.0000', currency: 'RUB', archived: false }]);
  for (const price of ['0', '00012.3400', '999999999999999999999999.000000001']) {
    assert.equal((await readOzonProductDetails(credentials, { productIds: [listing.product_id] }, response({ items: [{ ...detail, price }] }))).items[0].price, price);
  }
});

test('optional product facts remain unknown and absent details do not become deletions', async () => {
  const result = await readOzonProductDetails(credentials, { productIds: [listing.product_id] }, response({ items: [{ id: listing.product_id, offer_id: listing.offer_id, name: detail.name }] }));
  assert.deepEqual(result.items[0], { id: listing.product_id, offerId: listing.offer_id, name: detail.name, sku: null, sources: [], price: null, currency: null, archived: null });
  assert.deepEqual(await readOzonProductDetails(credentials, { productIds: [listing.product_id] }, response({ items: [] })), { items: [] });
});

test('product and source IDs retain every numeric token digit in Node and the deployed workerd runtime', { timeout: 30_000 }, async context => {
  const body = JSON.stringify({ items: [detail] }).replaceAll('"9000000000817031942"', '9000000000817031942').replaceAll('"9000000000817031941"', '9000000000817031941');
  const result = await readOzonProductDetails(credentials, { productIds: [listing.product_id] }, (async () => new Response(body)) as typeof fetch);
  assert.equal(result.items[0].id, listing.product_id); assert.equal(result.items[0].sku, listing.sku); assert.equal(result.items[0].sources[0].sku, listing.sku);
  const shared = stripTypeScriptTypes(readFileSync(new URL('../src/modules/ozon/read.ts', import.meta.url), 'utf8'));
  const source = stripTypeScriptTypes(readFileSync(new URL('../src/modules/products/ozon.ts', import.meta.url), 'utf8')).replaceAll('../ozon/read.ts', './read.mjs');
  const mf = new Miniflare({ modules: [{ type: 'ESModule', path: 'entry.mjs', contents: source + `\nexport default {async fetch(){return Response.json(await readOzonProductDetails(${JSON.stringify(credentials)}, {productIds:[${JSON.stringify(listing.product_id)}]}, async()=>new Response(${JSON.stringify(body)})))}}` }, { type: 'ESModule', path: 'read.mjs', contents: shared }], compatibilityDate: '2026-06-01' });
  context.after(() => mf.dispose());
  assert.deepEqual(await (await mf.dispatchFetch('https://fixture.invalid')).json(), result);
  const listBody = JSON.stringify({ result: { items: [listing], last_id: 'next', total: 1 } }).replaceAll('"9000000000817031942"', '9000000000817031942').replaceAll('"9000000000817031941"', '9000000000817031941');
  assert.equal((await listOzonProducts(credentials, {}, (async () => new Response(listBody)) as typeof fetch)).items[0].id, listing.product_id);
});

test('invalid or unbounded requests fail without reaching the provider', async () => {
  let calls = 0; const fetcher = (async () => { calls++; return Response.json({}); }) as typeof fetch;
  for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: null }, { lastId: null }, { lastId: 'x'.repeat(4097) }]) await assert.rejects(listOzonProducts(credentials, options as Parameters<typeof listOzonProducts>[1], fetcher), fails('invalid_request'));
  for (const productIds of [[], [listing.product_id, listing.product_id], Array.from({ length: 101 }, (_, index) => String(index)), ['1e20'], ['-1'], ['1.2'], [123]]) await assert.rejects(readOzonProductDetails(credentials, { productIds } as { productIds: string[] }, fetcher), fails('invalid_request'));
  assert.equal(calls, 0);
});

test('detail responses reject unrelated IDs, duplicates, malformed facts and numeric prices', async () => {
  for (const items of [[{ ...detail, id: '7' }], [detail, detail], [{ ...detail, name: 42 }], [{ ...detail, sources: {} }], [{ ...detail, sources: [{ sku: listing.sku, source: false }] }], [{ ...detail, price: 1530.00001 }], [{ ...detail, price: '1e3' }], [{ ...detail, price: '-3' }], [{ ...detail, currency_code: 643 }], [{ ...detail, is_archived: 'false' }]]) {
    await assert.rejects(readOzonProductDetails(credentials, { productIds: [listing.product_id] }, response({ items })), fails('invalid_response'));
  }
});

test('product responses share bounded transport, safe errors and preserved platform retry delays', async () => {
  let calls = 0;
  await assert.rejects(listOzonProducts(credentials, {}, (async () => { calls++; return new Response(credentials.apiKey, { status: 429, headers: { 'retry-after': '90000' } }); }) as typeof fetch), error => fails('rate_limited')(error) && (error as OzonReadError).retryAfterMs === 90_000_000);
  assert.equal(calls, 1);
  let cancelled = false;
  await assert.rejects(readOzonProductDetails(credentials, { productIds: [listing.product_id] }, (async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': '1048577' } })) as typeof fetch), fails('invalid_response'));
  assert.equal(cancelled, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(listOzonProducts(credentials, {}, (async () => { calls++; return Response.json({}); }) as typeof fetch, controller.signal), fails('aborted'));
  assert.equal(calls, 1);
});

test('the shared transport refuses write methods and arbitrary paths even if a caller bypasses static types', async () => {
  let calls = 0;
  for (const path of ['/v1/product/import/prices', '@other.invalid/path', 'https://not-ozon.invalid/data', '/v3/product/list?extra=true']) {
    await assert.rejects(readOzonJSON(credentials, path as Parameters<typeof readOzonJSON>[1], '{}', (async () => { calls++; return Response.json({}); }) as typeof fetch), fails('invalid_request'));
  }
  assert.equal(calls, 0);
});
