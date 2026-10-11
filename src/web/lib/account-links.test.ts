/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invitationReturnTo, linkToken } from './account-links.ts';

test('mail tokens are accepted only from a bounded, single fragment parameter', () => {
  assert.equal(linkToken('#token=synthetic-token'), 'synthetic-token');
  assert.equal(linkToken('?token=synthetic-token'), null);
  assert.equal(linkToken('#token=first&token=second'), null);
  assert.equal(linkToken('#token='), null);
  assert.equal(linkToken('#token=' + 'x'.repeat(8193)), null);
});

test('login return locations are limited to local invitation pages', () => {
  assert.equal(invitationReturnTo({ returnTo: '/invite/aB_12-xyz' }), '/invite/aB_12-xyz');
  for (const returnTo of ['https://evil.invalid', '//evil.invalid', '/invite/../setup', '/workspace', '/invite/id?token=secret']) {
    assert.equal(invitationReturnTo({ returnTo }), '/workspace');
  }
  assert.equal(invitationReturnTo(null), '/workspace');
});
