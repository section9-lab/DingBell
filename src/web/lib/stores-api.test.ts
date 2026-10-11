/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStore, updateStore, setStoreGrant } from './stores-api.ts';

test('store mutations require the requested store or grant receipt instead of a generic success', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true }));
  await assert.rejects(createStore('company', { id: 'store', name: 'Test', clientId: '123', apiKey: 'synthetic-key' }), { code: 'OPERATION_UNCONFIRMED' });
  await assert.rejects(updateStore('company', 'store', 'state', { expectedRevision: 1, state: 'paused' }), { code: 'OPERATION_UNCONFIRMED' });
  await assert.rejects(setStoreGrant('company', 'store', 'member', false, true), { code: 'OPERATION_UNCONFIRMED' });
});

test('grant responses must match the member and intended permission', async t => {
  for (const receipt of [{ memberId: 'other', granted: true }, { memberId: 'member', granted: false }]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(receipt));
    await assert.rejects(setStoreGrant('company', 'store', 'member', false, true), { code: 'OPERATION_UNCONFIRMED' });
    mock.mock.restore();
  }
});

test('uncertain credential updates preserve the displayed revision and never automatically retry', async t => {
  const calls: { path: string; body: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    calls.push({ path, body: JSON.parse(String(init.body)) });
    throw new Error('connection interrupted after commit');
  });
  await assert.rejects(updateStore('c/1', 's/1', 'credentials', { expectedRevision: 4, apiKey: 'synthetic-key' }), { code: 'OPERATION_UNCONFIRMED' });
  assert.deepEqual(calls, [{ path: '/api/companies/c%2F1/stores/s%2F1/credentials', body: { expectedRevision: 4, apiKey: 'synthetic-key' } }]);
});
