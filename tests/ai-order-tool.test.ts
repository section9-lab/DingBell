import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiAnswerFixture as fixture } from './fixtures/ai-answer.ts';

test('order context resolves only the admitted conversation order and stays inside the store', { timeout: 30_000 }, async t => {
  const x = await fixture('support-reply-v2'); t.after(x.f.close);
  const m = await import('../src/modules/ai-runs/order.ts'), id = x.run.request.runId, read = () => m.readAiOrderContext(x.env, x.scope, id);
  assert.equal((await read()).status, 'not_provided');

  await x.f.db.prepare("UPDATE message SET order_number='001-TEST' WHERE id='question'").run();
  assert.equal((await read()).status, 'not_imported');

  await x.f.db.prepare(`INSERT INTO fbs_posting(posting_number,organization_id,store_id,order_id,order_number,
      list_facts,list_observed_at,detail_epoch,detail_generation,detail_due_at)
      VALUES('P-1', 'org','store','900','001-TEST',?,1000,1,1,0)`).bind(JSON.stringify({ status: 'delivered', trackingNumber: 'TRACK-1', products: [{ sku: '1' }, { sku: '2' }] })).run();

  const matched = await read();
  assert.equal(matched.status, 'matched');
  assert.equal(matched.resolvedFrom, 'message');
  assert.equal(matched.orderNumber, '001-TEST');
  assert.equal(matched.order?.orderId, '900');
  assert.deepEqual(matched.order?.postings, [{
    postingNumber: 'P-1', fulfillment: 'fbs', statusLabel: '已送达', substatusLabel: null,
    trackingNumber: 'TRACK-1', productCount: 2, observedAt: new Date(1000).toISOString(),
  }]);
  assert.equal(matched.canSend, false);
  assert.equal(JSON.stringify(matched).includes('org'), false);

  await x.f.db.prepare(`INSERT INTO fbs_posting(posting_number,organization_id,store_id,order_id,order_number,
    list_facts,list_observed_at,detail_epoch,detail_generation,detail_due_at) VALUES('P-2','org','store','901','001-TEST','{}',1000,1,1,0)`).run();
  assert.equal((await read()).status, 'ambiguous');

  assert.equal((await m.readAiOrderContext(x.env, { ...x.scope, storeId: 'foreign' }, id)).status, 'unavailable');
  assert.equal((await m.readAiOrderContext(x.env, x.scope, crypto.randomUUID())).status, 'unavailable');
  assert.equal((await m.readAiOrderContext({ DB: undefined }, x.scope, id)).status, 'unavailable');
});

test('a version without order authority cannot read postings', { timeout: 30_000 }, async t => {
  const x = await fixture('support-v1'); t.after(x.f.close);
  const m = await import('../src/modules/ai-runs/order.ts');
  assert.equal((await m.readAiOrderContext(x.env, x.scope, x.run.request.runId)).status, 'unavailable');
});
