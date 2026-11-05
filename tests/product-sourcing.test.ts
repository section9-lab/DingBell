import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knowledgeFixture } from './fixtures/knowledge.ts';
import type { SourcingInput } from '../src/modules/commerce/sourcing.ts';

const base = '/api/companies/company/commerce/products/100';
const input = {
  storeId: 'store-a', supplySource: 'Supplier', purchaseUrl: null,
  purchasePrice: '12.50', purchaseCurrency: 'CNY',
};

async function fixture() {
  const f = await knowledgeFixture();
  f.sqlite.prepare(`INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,
    detail_epoch,detail_generation,detail_due_at)
    VALUES('100','company','store-a',?,1,1,1,9999999999999)`)
    .run(JSON.stringify({ id: '100', offerId: 'offer-100', sku: null, archived: false, hasFboStocks: null, hasFbsStocks: null }));
  return {
    ...f,
    write: (body: SourcingInput & { storeId: string }, who = 'admin') => f.app.request(f.env.APP_BASE_URL + base + '/sourcing', {
      method: 'POST', headers: { origin: f.env.APP_BASE_URL, cookie: f.cookies[who]!, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, f.env),
    read: () => f.app.request(f.env.APP_BASE_URL + base + '?storeId=store-a', { headers: { cookie: f.cookies.owner! } }, f.env),
  };
}

test('a sourcing write loses authority when its administrator is removed before the final write', async t => {
  const f = await fixture();
  t.after(f.close);
  let revoked = false;
  f.before(sql => {
    if (!revoked && sql.includes('INSERT INTO product_sourcing')) {
      revoked = true;
      f.sqlite.prepare("DELETE FROM member WHERE id='admin'").run();
    }
  });
  const response = await f.write(input);
  assert.equal(response.status, 404);
  assert.equal(revoked, true);
  const product = await (await f.read()).json() as { product: { sourcing: unknown } };
  assert.equal(product.product.sourcing, null);
});

for (const action of ['save', 'clear'] as const) {
  for (const revoke of ['demote', 'revoke-session', 'unverify-email'] as const) {
    test(`sourcing ${action} rejects a ${revoke} race at the final mutation`, async t => {
      const f = await fixture(); t.after(f.close);
      assert.equal((await f.write(input, 'owner')).status, 200);
      let revoked = false;
      f.before(sql => {
        if (!revoked && sql.includes(action === 'save' ? 'INSERT INTO product_sourcing' : 'DELETE FROM product_sourcing')) {
          revoked = true;
          if (revoke === 'demote') {
            f.sqlite.exec("UPDATE member SET role='member' WHERE id='admin'; INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES('company','store-a','admin',1)");
          } else if (revoke === 'revoke-session') f.sqlite.exec("DELETE FROM session WHERE user_id='admin'");
          else f.sqlite.exec("UPDATE user SET email_verified=0 WHERE id='admin'");
        }
      });
      const body = action === 'save' ? { ...input, purchasePrice: '99.00' }
        : { storeId: 'store-a', supplySource: null, purchaseUrl: null, purchasePrice: null, purchaseCurrency: null };
      assert.equal((await f.write(body)).status, 404);
      assert.equal(revoked, true);
      const product = await (await f.read()).json() as { product: { sourcing: { purchasePrice: string } } };
      assert.equal(product.product.sourcing.purchasePrice, '12.50');
    });
  }
}

test('an authorized sourcing clear is repeatable even when the record is already absent', async t => {
  const f = await fixture(); t.after(f.close);
  const empty = { storeId: 'store-a', supplySource: null, purchaseUrl: null, purchasePrice: null, purchaseCurrency: null };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await f.write(empty);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { sourcing: unknown }).sourcing, null);
  }
});
