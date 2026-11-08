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
  assert.equal(direct.product?.skuSource, 'both');
  assert.equal(direct.canSend, false);
  assert.equal(JSON.stringify(direct).includes('org'), false);
  assert.equal(JSON.stringify(direct).includes('conversationId'), false);
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
