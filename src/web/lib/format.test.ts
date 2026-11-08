import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatCny,
  formatCompactCny,
  formatDuration,
  formatInteger,
  formatPercent,
} from './format.ts';

test('formatInteger uses grouped zh-CN digits', () => {
  assert.equal(formatInteger(1234567), '1,234,567');
});

test('formatCny renders integer cents as CNY and keeps the empty marker', () => {
  assert.match(formatCny(123456), /1,234\.56/);
  assert.equal(formatCny(null), '—');
});

test('formatCompactCny shortens large amounts', () => {
  assert.match(formatCompactCny(100_000_000), /万|亿/);
});

test('formatPercent keeps a null marker instead of a fake zero', () => {
  assert.equal(formatPercent(0.1234), '12.3%');
  assert.equal(formatPercent(0.1234, 2), '12.34%');
  assert.equal(formatPercent(null), '—');
});

test('formatDuration switches from seconds to minutes', () => {
  assert.equal(formatDuration(1500), '1.5 秒');
  assert.equal(formatDuration(90_000), '1.5 分钟');
  assert.equal(formatDuration(null), '—');
});
