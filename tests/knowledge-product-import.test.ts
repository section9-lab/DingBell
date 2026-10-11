import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knowledgeFixture } from './fixtures/knowledge.ts';

async function fixture() {
  const f = await knowledgeFixture();
  function source(id = '1001', store = 'store-a', name = 'Органайзер', company = 'company') {
    const facts = JSON.stringify({ id, offerId: 'SAME-OFFER', name, sku: '2001', sources: [], price: '123.45', currency: 'RUB', archived: false });
    const snapshotId = crypto.randomUUID(), observedAt = Date.now();
    f.sqlite.prepare(`INSERT INTO product (id,organization_id,store_id,listing,list_observed_at,facts,facts_observed_at,detail_epoch,detail_generation,detail_revision,detail_state,detail_due_at)
      VALUES(?,?,?,?,?,?,?,1,1,1,'complete',0) ON CONFLICT(store_id,id) DO UPDATE SET facts=excluded.facts,facts_observed_at=excluded.facts_observed_at,detail_revision=product.detail_revision+1`)
      .run(id, company, store, JSON.stringify({ id, offerId: 'SAME-OFFER', sku: '2001', archived: false }), observedAt, facts, observedAt);
    f.sqlite.prepare('INSERT INTO product_source_snapshot(id,organization_id,store_id,product_id,facts,observed_at) VALUES(?,?,?,?,?,?)')
      .run(snapshotId, company, store, id, facts, observedAt);
    return snapshotId;
  }
  const preview = (productId = '1001', storeId = 'store-a', language = 'ru') => f.request(`/product-import?${new URLSearchParams({ storeId, productId, language })}`);
  const command = (data: any) => ({ storeId: data.source.storeId, productId: data.source.productId, language: data.scope.language,
    snapshotId: data.source.snapshotId, expectedVersion: data.expectedVersion });
  return { ...f, source, preview, command };
}

test('product import preview is scoped to the canonical product and contains only confirmed stable facts', async t => {
  const f = await fixture(); t.after(f.close);
  f.source(); f.source('1002'); f.source('1001', 'store-b'); f.source('1001', 'store-other', 'Other private item', 'other');
  const response = await f.preview(); assert.equal(response.status, 200);
  const data = await response.json() as any;
  assert.equal(data.expectedVersion, 0); assert.equal(data.importedRevision, null);
  assert.equal(data.currentDraft, null); assert.equal(data.activeRevision, null);
  assert.deepEqual(data.scope, { kind: 'product', storeId: 'store-a', productRef: '1001', language: 'ru' });
  assert.equal(data.draft.source.format, 'product'); assert.match(data.documentId, /^[a-f0-9-]{36}$/);
  assert.ok(data.draft.source.facts.some((fact: any) => fact.value === 'Органайзер'));
  assert.doesNotMatch(JSON.stringify(data.draft), /123\.45|RUB|price|archived|stock/i);
  for (const parameters of [['1002','store-a','ru'], ['1001','store-b','ru'], ['1001','store-a','en']]) {
    assert.notEqual((await (await f.preview(...parameters as [string,string,string])).json() as any).documentId, data.documentId);
  }
  const list = await (await f.request('/product-sources?storeId=store-a')).json() as any;
  assert.deepEqual(list.products.map((item: any) => item.productId), ['1001', '1002']); assert.equal(list.nextAfter, null);
  assert.equal((await f.preview('1001', 'store-other')).status, 404);
  assert.equal((await f.request('/product-import?storeId=store-a&productId=1001&language=ru', undefined, 'staff')).status, 403);
  for (const suffix of ['&language=en', '&source=forged', '&snapshotId=forged'])
    assert.equal((await f.request('/product-import?storeId=store-a&productId=1001&language=ru' + suffix)).status, 400);
});

test('exact and concurrent product imports create one draft and preserve later manual edits', async t => {
  const f = await fixture(); t.after(f.close); f.source();
  const response = await f.preview(); assert.equal(response.status, 200);
  const preview = await response.json() as any, command = f.command(preview);
  const replies = await Promise.all([f.request('/product-import', command), f.request('/product-import', command)]);
  for (const reply of replies) assert.equal(reply.status, 200, await reply.clone().text());
  const id = preview.documentId;
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_revision WHERE document_id=?').get(id)!.count, 1);
  const saved = await (await f.request(`/${id}`)).json() as any;
  assert.equal(saved.document.activeRevision, null); assert.equal(saved.draft.status, 'draft'); assert.equal(saved.document.productRef, '1001');
  const draft = { title: '人工补充', source: { format: 'product', facts: [{ label: '宽度', value: '26 cm' }] } };
  assert.equal((await f.request(`/${id}/draft`, { expectedVersion: 1, ...draft })).status, 200);
  const repeat = await f.request('/product-import', command); assert.equal(repeat.status, 200);
  assert.equal((await repeat.json() as any).status, 'already_imported');
  const latest = await (await f.request(`/${id}`)).json() as any;
  assert.equal(latest.document.version, 2); assert.equal(latest.draft.title, draft.title);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_product_source').get()!.count, 1);
});

test('a new product snapshot requires an explicit current draft version and never changes the published revision', async t => {
  const f = await fixture(); t.after(f.close); f.source();
  const response = await f.preview(); assert.equal(response.status, 200); let preview = await response.json() as any;
  assert.equal((await f.request('/product-import', f.command(preview))).status, 200); const id = preview.documentId;
  f.sqlite.prepare("UPDATE knowledge_revision SET status='ready',index_profile='synthetic',mutation_id='visible',tested_at=1,published_profile='synthetic',published_mutation_id='copy',published_at=2 WHERE document_id=?").run(id);
  assert.equal((await f.request(`/${id}/publish`, { expectedVersion: 1 })).status, 200);
  const previous = f.command(preview); f.source('1001', 'store-a', 'Другая модель');
  assert.equal((await f.request('/product-import', previous)).status, 409);
  preview = await (await f.preview()).json() as any; assert.equal(preview.expectedVersion, 2);
  assert.equal(preview.currentDraft.title, 'Органайзер'); assert.equal(preview.currentDraft.revision, 1); assert.equal(preview.activeRevision, 1);
  assert.equal((await f.request('/product-import', { ...f.command(preview), expectedVersion: 1 })).status, 409);
  assert.equal((await f.request('/product-import', f.command(preview))).status, 200);
  const latest = await (await f.request(`/${id}`)).json() as any;
  assert.equal(latest.document.activeRevision, 1); assert.equal(latest.document.draftRevision, 2);
  assert.equal(latest.active.title, 'Органайзер'); assert.equal(latest.draft.title, 'Другая модель');
  assert.equal(latest.draft.status, 'draft'); assert.equal(latest.draft.testedAt, null);
});

test('product changes at the write boundary cannot commit the previously previewed snapshot', async t => {
  const f = await fixture(); t.after(f.close); f.source();
  const response = await f.preview(); assert.equal(response.status, 200); const preview = await response.json() as any;
  f.before(sql => { if (sql.startsWith('INSERT INTO knowledge_document')) { f.before(undefined); f.source('1001','store-a','Changed while confirming'); } });
  assert.equal((await f.request('/product-import', f.command(preview))).status, 409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_document').get()!.count, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_product_source').get()!.count, 0);
});

test('missing, incomplete, archived, mismatched and oversized product sources never masquerade as imported knowledge', async t => {
  const f = await fixture(); t.after(f.close); f.source();
  assert.equal((await f.preview()).status, 200);
  assert.equal((await f.preview('9999')).status, 404);
  f.sqlite.exec("UPDATE product SET detail_state='pending'"); assert.equal((await f.preview()).status, 409);
  f.sqlite.exec("UPDATE product SET detail_state='complete',listing=json_set(listing,'$.archived',json('true'))"); assert.equal((await f.preview()).status, 409);
  f.sqlite.exec("UPDATE product SET listing=json_set(listing,'$.archived',json('false'))");
  f.source('1001','store-a','x'.repeat(1001)); assert.equal((await f.preview()).status, 409);
  f.source(); f.sqlite.exec("UPDATE product SET facts=json_set(facts,'$.id','another-product')"); assert.equal((await f.preview()).status, 409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_document').get()!.count, 0);
});

test('revocation or a provenance write failure cannot leave a partial product draft', async t => {
  const f = await fixture(); t.after(f.close); f.source();
  const preview = await (await f.preview()).json() as any, command = f.command(preview);
  f.before(sql => { if (sql.startsWith('INSERT INTO knowledge_product_source')) throw new Error('synthetic provenance interruption'); });
  assert.equal((await f.request('/product-import', command)).status, 503);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_document').get()!.count, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_chunk').get()!.count, 0);
  f.before(sql => { if (sql.startsWith('INSERT INTO knowledge_document')) { f.before(undefined); f.sqlite.exec("DELETE FROM member WHERE user_id='admin'"); } });
  assert.equal((await f.request('/product-import', command, 'admin')).status, 404);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_document').get()!.count, 0);
});

test('an audit acknowledgement failure is recoverable from durable provenance without repeating the import', async t => {
  const f = await fixture(); t.after(f.close); f.source();
  const preview = await (await f.preview()).json() as any, command = f.command(preview); let audits = 0;
  f.before(sql => { if (sql.startsWith('INSERT INTO knowledge_audit_event') && ++audits === 2) throw new Error('synthetic audit acknowledgement loss'); });
  assert.equal((await f.request('/product-import', command)).status, 503); f.before(undefined);
  assert.equal((await (await f.preview()).json() as any).importedRevision, 1);
  assert.equal((await (await f.request('/product-import', command)).json() as any).status, 'already_imported');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_revision').get()!.count, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_product_source').get()!.count, 1);
  assert.throws(() => f.sqlite.exec('UPDATE knowledge_product_source SET revision=2'), /immutable/);
  assert.throws(() => f.sqlite.exec("UPDATE product_source_snapshot SET facts='{}'"), /immutable/);
  assert.throws(() => f.sqlite.exec('DELETE FROM product_source_snapshot'), /immutable/);
  assert.equal((await f.request(`/${preview.documentId}/draft`, { expectedVersion: 1, title: 'Edited', source: { format: 'product', facts: [{ label: 'Width', value: '26 cm' }] } })).status, 200);
  assert.throws(() => f.sqlite.exec(`INSERT OR REPLACE INTO knowledge_product_source
    SELECT organization_id,document_id,2,store_id,product_id,snapshot_id FROM knowledge_product_source`), /immutable/);
  f.sqlite.prepare('DELETE FROM knowledge_document WHERE id=?').run(preview.documentId);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_product_source').get()!.count, 0);
});

test('a price-only snapshot does not create a duplicate revision and catalog pagination never mixes stores', async t => {
  const f = await fixture(); t.after(f.close); f.source();
  const preview = await (await f.preview()).json() as any;
  assert.equal((await f.request('/product-import', f.command(preview))).status, 200);
  const updated = JSON.stringify({ id:'1001',offerId:'SAME-OFFER',name:'Органайзер',sku:'2001',sources:[],price:'200',currency:'RUB',archived:false });
  f.sqlite.prepare('UPDATE product SET facts=?').run(updated);
  f.sqlite.prepare("INSERT INTO product_source_snapshot(id,organization_id,store_id,product_id,facts,observed_at) VALUES(?,'company','store-a','1001',?,?)")
    .run(crypto.randomUUID(), updated, Date.now()+1);
  const next = await (await f.preview()).json() as any; assert.notEqual(next.source.snapshotId,preview.source.snapshotId);
  assert.equal((await (await f.request('/product-import', f.command(next))).json() as any).status,'unchanged');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_revision').get()!.count,1);
  for(let i=2;i<=22;i++)f.source(String(1000+i));f.source('1001','store-b');
  const first=await (await f.request('/product-sources?storeId=store-a')).json() as any;
  assert.equal(first.products.length,20);assert.equal(first.nextAfter,'1020');
  const second=await (await f.request('/product-sources?storeId=store-a&after=1020')).json() as any;
  assert.deepEqual(second.products.map((item:any)=>item.productId),['1021','1022']);assert.equal(second.nextAfter,null);
});
