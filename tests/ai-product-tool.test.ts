import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiAnswerFixture as fixture } from './fixtures/ai-answer.ts';

test('product context resolves only the admitted item, from the message or the conversation, and gates by version and scope', { timeout: 30000 }, async t => {
  const x = await fixture('support-reply-v2'); t.after(x.f.close);
  const m = await import('../src/modules/ai-runs/product.ts'), id = x.run.request.runId, read = () => m.readAiProductContext(x.env, x.scope, id);
  assert.equal((await read()).status, 'not_provided');
  await x.f.db.prepare("UPDATE message SET sku='5787036301' WHERE id='question'").run();
  assert.equal((await read()).status, 'not_imported');
  const insertProduct = (productId: string, sku: string) => x.f.db.batch([
    x.f.db.prepare("INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,detail_epoch,detail_generation,detail_due_at,detail_state,facts,facts_observed_at) VALUES(?, 'org','store',?,1,1,1,0,'complete',?,2)")
      .bind(productId, JSON.stringify({ offerId: `offer-${productId}`, sku }), JSON.stringify({ offerId: `offer-${productId}`, sku, name: 'Повязка', price: '26.80', currency: 'CNY', archived: false, primaryImage: 'https://ir-20.ozone.ru/s3/multimedia-1-1/150064764' })),
  ]);
  await insertProduct('p1', '5787036301');
  const direct = await read();
  assert.equal(direct.status, 'matched');
  assert.equal(direct.resolvedFrom, 'message');
  assert.equal(direct.sku, '5787036301');
  assert.equal(direct.product?.name, 'Повязка');
  assert.ok(direct.product && 'skuSource' in direct.product);
  assert.equal(direct.product.skuSource, 'both');
  assert.equal(direct.canSend, false);
  assert.equal(JSON.stringify(direct).includes('org'), false);
  assert.equal(JSON.stringify(direct).includes('conversationId'), false);
  // Merchant cost/sourcing and stock stay out of the model surface even though the catalog now
  // stores model grouping and quantities: the projection is a closed key set, not a passthrough.
  assert.deepEqual(Object.keys(direct.product!).sort(), ['archived', 'currency', 'name', 'observedAt', 'offerId', 'price', 'primaryImage', 'productId', 'skuSource']);
  for (const hidden of ['stock', 'modelId', 'present', 'reserved', 'supplySource', 'purchasePrice', 'costing']) {
    assert.equal(JSON.stringify(direct).includes(hidden), false, `${hidden} must not reach the model`);
  }
  await x.f.db.prepare("UPDATE message SET sku=NULL WHERE id='question'").run();
  await x.f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,sku,event_at,received_at,ingest_mode) VALUES('later','org','store','conv','later','Customer','inbound','[\"Какой цвет?\"]',0,0,'5787036301',10,10,'incremental')").run();
  const fallback = await read();
  assert.equal(fallback.status, 'matched');
  assert.equal(fallback.resolvedFrom, 'conversation');
  await insertProduct('p2', '5787036301');
  assert.equal((await read()).status, 'ambiguous');
  assert.equal((await m.readAiProductContext(x.env, { ...x.scope, storeId: 'foreign' }, id)).status, 'unavailable');
  assert.equal((await m.readAiProductContext(x.env, x.scope, crypto.randomUUID())).status, 'unavailable');
  assert.equal((await m.readAiProductContext({ DB: undefined }, x.scope, id)).status, 'unavailable');
});

test('a version without product authority cannot read the catalog', { timeout: 30000 }, async t => {
  const x = await fixture('support-v1'); t.after(x.f.close);
  const m = await import('../src/modules/ai-runs/product.ts');
  assert.equal((await m.readAiProductContext(x.env, x.scope, x.run.request.runId)).status, 'unavailable');
});

test('v3 exposes a customer-safe product profile and still excludes cost, sources and exact stock', { timeout: 30000 }, async t => {
  const x = await fixture('support-reply-v3'); t.after(x.f.close);
  const m = await import('../src/modules/ai-runs/product.ts'), id = x.run.request.runId;
  await x.f.db.prepare("UPDATE message SET sku='5787036301' WHERE id='question'").run();
  const productId = 'p3';
  await x.f.db.prepare(`INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,detail_epoch,detail_generation,detail_due_at,detail_state,facts,facts_observed_at,stock_has_stock,stock_observed_at)
    VALUES(?, 'org','store',?,1,1,1,0,'complete',?,2,1,2)`)
    .bind(productId, JSON.stringify({ offerId: 'offer-p3', sku: '5787036301' }), JSON.stringify({
      offerId: 'offer-p3', sku: '5787036301', name: 'Повязка', price: '26.80', currency: 'CNY', archived: false,
      createdAt: '2026-09-15T10:00:00Z',
      primaryImage: 'https://ir-20.ozone.ru/s3/main.jpg',
      images: ['https://ir-20.ozone.ru/s3/main.jpg', 'https://ir-20.ozone.ru/s3/side.jpg'],
    })).run();
  await x.f.db.prepare(`INSERT INTO product_service_profile(organization_id,store_id,product_id,description,description_state,attributes_json,attributes_state,
    length_mm,width_mm,height_mm,dimension_unit,weight_g,weight_unit,observed_at,updated_at)
    VALUES('org','store',?,?, 'complete', ?, 'complete', 100,50,10,'mm',20,'g',3,3)`)
    .bind(productId, 'Мягкая повязка для волос.', JSON.stringify([{ name: 'Материал', value: 'хлопок' }, { name: 'Цвет', value: 'чёрный' }])).run();
  // Cost data exists in the catalog; the model projection must still never see it.
  await x.f.db.batch([
    x.f.db.prepare(`INSERT INTO product_sourcing(organization_id,store_id,product_id,supply_source,purchase_price,purchase_currency,updated_at,updated_by)
      VALUES('org','store',?,'1688','12.34','CNY',3,'owner')`).bind(productId),
    x.f.db.prepare(`INSERT INTO product_costing(id,organization_id,store_id,product_id,purchase_price,purchase_currency,label_fee,commission_rate,weight_grams,valid_from,updated_at,updated_by)
      VALUES('cost-p3','org','store',?,'12.34','CNY','1','0.2',100,1,3,'owner')`).bind(productId),
  ]);
  const context = await m.readAiProductContext(x.env, x.scope, id);
  assert.equal(context.status, 'matched');
  assert.equal(context.sku, '5787036301');
  assert.ok(context.product && 'availability' in context.product);
  assert.deepEqual(Object.keys(context.product).sort(), ['archived', 'attributes', 'availability', 'createdAt', 'currency', 'description', 'dimensions', 'images', 'missingFields', 'name', 'observedAt', 'price', 'profileStatus', 'stockObservedAt', 'weight']);
  assert.equal(context.product.availability, 'in_stock');
  assert.equal(context.product.stockObservedAt, new Date(2).toISOString());
  assert.equal(context.product.description, 'Мягкая повязка для волос.');
  assert.deepEqual(context.product.attributes, [{ name: 'Материал', value: 'хлопок' }, { name: 'Цвет', value: 'чёрный' }]);
  assert.deepEqual(context.product.dimensions, { length: 100, width: 50, height: 10, unit: 'mm' });
  assert.deepEqual(context.product.weight, { value: 20, unit: 'g' });
  assert.equal(context.product.images.length, 2);
  assert.equal(context.product.createdAt, '2026-09-15T10:00:00Z');
  assert.equal(context.product.profileStatus, 'complete');
  assert.deepEqual(context.product.missingFields, []);
  const serialized = JSON.stringify(context);
  for (const hidden of ['productId', 'offerId', 'skuSource', 'modelId', 'present', 'reserved', 'supplySource', 'purchasePrice', 'commissionRate', 'costing', 'sourcing']) {
    assert.equal(serialized.includes(hidden), false, `${hidden} must not reach the model`);
  }
});
