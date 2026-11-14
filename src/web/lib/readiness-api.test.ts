import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readReadiness } from './readiness-api.ts';

const sync = (source: 'chat' | 'products' | 'fbs_postings' | 'fbo_postings' | 'fbp_postings') => ({
  source, enabled: false, epoch: 2, failures: 4, lastError: 'invalid_response',
  lastSuccessAt: '2026-10-31T07:58:49.000Z', blockedUntil: null, running: false, canEnable: true,
});
const readiness = {
  companyId: 'a/b', role: 'owner',
  deployment: {
    sync: true, outbound: false,
    ai: { enabled: false, modelConfigured: false, pricesConfigured: false },
    aiOutbound: false,
    knowledge: { text: true },
  },
  stores: [{
    id: '30000000-0000-4000-8000-000000000001', name: 'Mirava', platformStoreId: '5476375', status: 'verified',
    hasCredentials: true, checkedAt: null,
    sync: [sync('chat'), sync('products'), sync('fbs_postings'), sync('fbo_postings'),sync('fbp_postings')],
  }],
  knowledge: { total: 0, published: 0 },
  policies: { total: 0, enabled: 0 },
  limits: { stores: 1, truncated: false },
};

test('readiness keeps the tenant path encoded and returns deployment and sync state', async t => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => { calls.push({ url, init }); return Response.json(readiness); });
  const value = await readReadiness('a/b');
  assert.equal(calls[0]!.url, '/api/companies/a%2Fb/readiness');
  assert.equal(calls[0]!.init.method, undefined);
  assert.equal(value.stores[0]!.sync.length, 5);
  assert.equal(value.deployment.outbound, false);
});

test('readiness rejects another company, a missing sync source and duplicated sources', async t => {
  for (const value of [
    { ...readiness, companyId: 'other' },
    { ...readiness, stores: [{ ...readiness.stores[0], sync: readiness.stores[0]!.sync.slice(0, 3) }] },
    { ...readiness, stores: [{ ...readiness.stores[0], sync: readiness.stores[0]!.sync.map(item => ({ ...item, source: 'chat' })) }] },
    { ...readiness, stores: [{ ...readiness.stores[0], sync: readiness.stores[0]!.sync.map(item => ({ ...item, epoch: -1 })) }] },
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(value));
    await assert.rejects(() => readReadiness('a/b'), { code: 'INVALID_RESPONSE' });
    mock.mock.restore();
  }
});
