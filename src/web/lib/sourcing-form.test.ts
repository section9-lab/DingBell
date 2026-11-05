import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';

const { sourcingInput, linkProblem } = await import('./sourcing-schema.ts');

const base = { supplySource: '1688 · 供应商', purchaseUrl: 'https://detail.1688.com/offer/1.html', purchasePrice: '38.50', purchaseCurrency: 'CNY' as const };

test('sourcing accepts a complete record and an entirely empty one', () => {
  assert.deepEqual(v.parse(sourcingInput, base), base);
  assert.equal(v.safeParse(sourcingInput, { supplySource: '', purchaseUrl: '', purchasePrice: '', purchaseCurrency: 'CNY' }).success, true);
  assert.equal(v.parse(sourcingInput, { ...base, supplySource: '  渠道  ' }).supplySource, '渠道', 'values are trimmed before persisting');
});

test('field messages stay specific instead of collapsing into one generic error', () => {
  const message = (patch: Record<string, unknown>) => {
    const result = v.safeParse(sourcingInput, { ...base, ...patch });
    assert.equal(result.success, false);
    return result.issues?.[0]?.message;
  };
  assert.equal(message({ supplySource: 'x'.repeat(201) }), '货源最多 200 个字符。');
  assert.equal(message({ purchaseUrl: 'detail.1688.com/offer/1.html' }), '请填写以 http:// 或 https:// 开头的完整链接。');
  assert.equal(message({ purchaseUrl: `https://user:pass@example.invalid/${'x'.repeat(2100)}` }), '链接不能超过 2048 个字符。');
  assert.equal(message({ purchasePrice: '0' }), '采购价需大于 0，最多 4 位小数。');
  assert.equal(message({ purchasePrice: '1.23456' }), '采购价需大于 0，最多 4 位小数。');
  assert.match(message({ purchaseCurrency: 'JPY' }) ?? '', /Expected .*CNY.*RUB.*USD.*EUR.*received "JPY"/);
});

test('link validation rejects credentials and unparseable URLs but accepts a plain https page', () => {
  assert.equal(linkProblem(''), null);
  assert.equal(linkProblem('https://detail.1688.com/offer/1.html'), null);
  assert.match(linkProblem('https://user:secret@example.invalid/x') ?? '', /去掉用户名、密码/);
  assert.match(linkProblem('not a url') ?? '', /http:\/\/ 或 https:\/\//);
  assert.match(linkProblem(`https://example.invalid/${'x'.repeat(2048)}`) ?? '', /2048/);
});
