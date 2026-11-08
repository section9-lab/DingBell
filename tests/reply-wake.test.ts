import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replyWakeDelay } from '../src/modules/conversations/reply-wake.ts';

test('the reply observer starts responsive and backs off for slow runs', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(replyWakeDelay), [1_000, 2_000, 3_000, 5_000, 8_000]);
});

test('backoff stays bounded instead of growing with the deadline', () => {
  for (const attempts of [5, 50, 1000]) assert.equal(replyWakeDelay(attempts), 8_000);
});

test('negative or fractional attempt counts cannot produce an undefined delay', () => {
  assert.equal(replyWakeDelay(-1), 1_000);
  assert.equal(replyWakeDelay(Number.MIN_SAFE_INTEGER), 1_000);
  assert.equal(replyWakeDelay(2.7), 3_000);
  assert.throws(() => replyWakeDelay(Number.NaN), /INVALID_REPLY_WAKE_ATTEMPTS/);
});

test('a sixty second deadline costs far fewer wakes than one poll per second', () => {
  let elapsed = 0, observations = 0;
  while (elapsed < 60_000) { elapsed += replyWakeDelay(observations); observations++; }
  assert.ok(observations <= 15, `expected at most 15 observations in 60s, got ${observations}`);
  assert.ok(observations >= 5, `expected the observer to keep checking, got ${observations}`);
});
