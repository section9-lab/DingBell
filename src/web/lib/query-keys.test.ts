import assert from 'node:assert/strict';
import { test } from 'node:test';
import { companyQueryKey, storeQueryKey, storesInfiniteQueryKey, storesQueryKey } from './query-keys.ts';
import { isCompanyQuery } from './realtime.ts';

const companyId = 'company-1';

test('company keys keep the company id at a stable position for structural invalidation', () => {
  for (const key of [companyQueryKey(companyId, 'x'), storesQueryKey(companyId), storesQueryKey(companyId, 20), storesInfiniteQueryKey(companyId), storeQueryKey(companyId, 'store-1')]) {
    assert.equal(key[0], 'company');
    assert.equal(key[1], companyId);
    assert.equal(isCompanyQuery(key, companyId), true);
    assert.equal(isCompanyQuery(key, 'other-company'), false);
  }
});

test('store list pages of the same offset share one key and different offsets do not collide', () => {
  assert.deepEqual(storesQueryKey(companyId), storesQueryKey(companyId, 0));
  assert.notDeepEqual(storesQueryKey(companyId), storesQueryKey(companyId, 20));
  assert.notDeepEqual(storesQueryKey(companyId), storesInfiniteQueryKey(companyId));
  assert.notDeepEqual(storeQueryKey(companyId, 'a'), storeQueryKey(companyId, 'b'));
});

test('an empty company id is rejected instead of producing a cross-tenant key', () => {
  assert.throws(() => companyQueryKey(''), /requires a company id/);
  assert.throws(() => storesQueryKey(''), /requires a company id/);
});
