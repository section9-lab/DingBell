import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OzonReadError } from '../src/modules/products/ozon.ts';
import {
  descriptionText, readOzonCategoryAttributes, readOzonProductAttributes, readOzonProductDescription,
} from '../src/modules/products/profile.ts';

const credentials = { clientId: '123456', apiKey: 'synthetic-profile-api-key' };
const productId = '9000000000817031942';
const image = 'https://ir-20.ozone.ru/s3/profile.jpg';
const response = (body: unknown): typeof fetch => (async () => Response.json(body)) as typeof fetch;
const fails = (code: string) => (error: unknown) =>
  error instanceof OzonReadError && error.code === code && !JSON.stringify(error).includes(credentials.apiKey);

test('attribute reads preserve public specs and never mix cost fields', async () => {
  let calls = 0;
  const result = await readOzonProductAttributes(credentials, { productIds: [productId] }, (async (input, init) => {
    calls++;
    assert.equal(String(input), 'https://api-seller.ozon.ru/v4/product/info/attributes');
    assert.deepEqual(JSON.parse(String(init?.body)), { filter: { product_id: [productId] }, limit: 1 });
    return Response.json({
      result: [{
        id: productId, description_category_id: '17028922', type_id: '91565',
        name: 'Повязка', offer_id: 'offer-1', sku: '9000000000817031941',
        height: 10, width: 20, depth: 30, dimension_unit: 'mm', weight: 50, weight_unit: 'g',
        primary_image: image, images: [image, 'https://ir-20.ozone.ru/s3/side.jpg'],
        attributes: [
          { id: '85', values: [{ value: 'Samsung' }, { value: '  ' }] },
          { id: '9048', values: [{ value: 'Название' }] },
          { id: '999', values: [] },
        ],
        commissions: [{ percent: 0.2 }],
        purchase_price: 'hidden',
      }],
    });
  }) as typeof fetch);
  assert.equal(calls, 1);
  assert.deepEqual(result.items, [{
    id: productId, descriptionCategoryId: '17028922', typeId: '91565', name: 'Повязка', offerId: 'offer-1', sku: '9000000000817031941',
    attributes: [{ attributeId: '85', values: ['Samsung'] }, { attributeId: '9048', values: ['Название'] }],
    height: 10, width: 20, depth: 30, dimensionUnit: 'mm', weight: 50, weightUnit: 'g',
    primaryImage: image, images: [image, 'https://ir-20.ozone.ru/s3/side.jpg'],
  }]);
  assert.equal(JSON.stringify(result).includes('commissions'), false);
  assert.equal(JSON.stringify(result).includes('purchase_price'), false);
});

test('attribute reads reject duplicate, unrequested, malformed and unbounded entries', async () => {
  for (const result of [
    [{ id: '1', attributes: [] }],
    [{ id: productId, attributes: [] }, { id: productId, attributes: [] }],
    [{ id: productId, attributes: [{ id: '1.5', values: [{ value: 'x' }] }] }],
    [{ id: productId, height: -1 }],
    [{ id: productId, attributes: Array.from({ length: 501 }, (_, i) => ({ id: String(i), values: [{ value: 'x' }] })) }],
  ]) await assert.rejects(readOzonProductAttributes(credentials, { productIds: [productId] }, response({ result })), fails('invalid_response'));
  await assert.rejects(readOzonProductAttributes(credentials, { productIds: [] }, response({ result: [] })), fails('invalid_request'));
});

test('description reads are scoped to the requested product and convert HTML to bounded text', async () => {
  const result = await readOzonProductDescription(credentials, { productId }, response({
    result: { id: productId, offer_id: 'offer-1', name: 'Повязка', description: '<p>Мягкая<br/>повязка &amp; резинка</p><script>alert(1)</script>' },
  }));
  assert.deepEqual(result, { id: productId, description: '<p>Мягкая<br/>повязка &amp; резинка</p><script>alert(1)</script>' });
  assert.equal(descriptionText(result!.description), 'Мягкая\nповязка & резинка');
  assert.equal(descriptionText(`<style>x</style>${'a'.repeat(9000)}`).length, 4000);
  await assert.rejects(readOzonProductDescription(credentials, { productId }, response({ result: { id: '1', description: 'x' } })), fails('invalid_response'));
  await assert.rejects(readOzonProductDescription(credentials, { productId: '1.5' }, response({ result: null })), fails('invalid_request'));
});

test('category attribute reads resolve labels without accepting duplicate ids', async () => {
  const result = await readOzonCategoryAttributes(credentials, { descriptionCategoryId: '17028922', typeId: '91565', language: 'RU' }, response({
    result: [{ id: '85', name: 'Бренд' }, { id: '9048', name: 'Название' }],
  }));
  assert.deepEqual(result.items, [{ id: '85', name: 'Бренд' }, { id: '9048', name: 'Название' }]);
  await assert.rejects(readOzonCategoryAttributes(credentials, { descriptionCategoryId: '17028922', typeId: '91565', language: 'RU' }, response({
    result: [{ id: '85', name: 'Бренд' }, { id: '85', name: 'Бренд' }],
  })), fails('invalid_response'));
});
