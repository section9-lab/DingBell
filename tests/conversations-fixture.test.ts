import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { conversationsFixture } from './fixtures/conversations.ts';

test('conversation fixture initialization failure releases the runtime without hiding the original error', { timeout: 30_000 }, async t => {
  const failure = Object.assign(new Error('synthetic initialization failure'), { code: 'EADDRNOTAVAIL' });
  const originalDispose = Miniflare.prototype.dispose;
  let instance: Miniflare | undefined, closed = false;
  t.mock.method(Miniflare.prototype, 'getD1Database', async function (this: Miniflare) { instance = this; throw failure; });
  const disposal = t.mock.method(Miniflare.prototype, 'dispose', async function (this: Miniflare) {
    await originalDispose.call(this); closed = true; throw new Error('synthetic cleanup failure');
  });
  try {
    await assert.rejects(conversationsFixture, error => error === failure);
    assert.equal(disposal.mock.calls.length, 1); assert.equal(closed, true);
  } finally { if (instance && !closed) await originalDispose.call(instance); }
});
