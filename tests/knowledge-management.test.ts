import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knowledgeFixture } from './fixtures/knowledge.ts';

test('knowledge catalog filters apply before pagination and text publication is discoverable', async t => {
  const f = await knowledgeFixture(); t.after(f.close);
  const create = async (extra = {}) => {
    const value = { id: crypto.randomUUID(), kind: 'faq', storeId: null, productRef: null, language: 'ru', title: 'Test policy', source: { format: 'text', content: 'Confirmed information.' }, ...extra };
    assert.equal((await f.request('', value)).status, 200); return value;
  };
  for (let i = 0; i < 21; i++) await create({ kind: 'guide', storeId: 'store-b' });
  const selected = await create({ kind: 'policy', storeId: 'store-a', language: 'en' });
  const response = await f.request('?kind=policy&storeId=store-a&language=en&publication=unpublished');
  assert.equal(response.status, 200);
  const data = await response.json() as any;
  assert.deepEqual(data.documents.map((row: any) => row.id), [selected.id]); assert.equal(data.nextAfter, null);
  assert.equal((await f.request(`/${selected.id}/text`, { expectedVersion: 1 })).status, 200);
  assert.deepEqual((await (await f.request('?publication=published')).json() as any).documents.map((row: any) => row.id), [selected.id]);
  assert.deepEqual((await (await f.request('?kind=policy&publication=unpublished')).json() as any).documents, []);
  assert.equal((await f.request('?storeId=store-other')).status, 200);
  assert.deepEqual((await (await f.request('?storeId=store-other')).json() as any).documents, []);
  assert.deepEqual((await (await f.request('?storeId=')).json() as any).documents, []);
  for (const query of ['?kind=invalid', '?publication=ready', '?language=fr', '?kind=faq&kind=guide', '?namespace=other'])
    assert.equal((await f.request(query)).status, 400);
});

test('text publication remains discoverable after withdrawal clears it', async t => {
  const f = await knowledgeFixture(); t.after(f.close);
  const value = { id: crypto.randomUUID(), kind: 'faq', storeId: null, productRef: null, language: 'ru', title: 'Test policy', source: { format: 'text', content: 'Confirmed information.' } };
  assert.equal((await f.request('', value)).status, 200);
  assert.equal((await f.request(`/${value.id}/text`, { expectedVersion: 1 })).status, 200);
  const published = await (await f.request(`/${value.id}`)).json() as any;
  assert.equal(published.document.activeRevision, 1);
  const withdrawn = await f.request(`/${value.id}/withdraw`, { expectedVersion: 2 }); assert.equal(withdrawn.status, 200);
  const data = await withdrawn.json() as any; assert.equal(data.active, null);
});
