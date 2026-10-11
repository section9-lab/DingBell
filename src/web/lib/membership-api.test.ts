/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeMember } from './membership-api.ts';

test('member changes bind the receipt to the requested member and final role', async t => {
  for (const receipt of [{ memberId: 'other', role: 'admin' }, { memberId: 'member', role: 'owner' }, { success: true }]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(receipt));
    await assert.rejects(changeMember('company', 'member', 'member', 'admin'), { code: 'OPERATION_UNCONFIRMED' });
    mock.mock.restore();
  }
});

test('member removal and role edits send the displayed role and never repeat an uncertain write', async t => {
  const calls: { path: string; body: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    calls.push({ path, body: JSON.parse(String(init.body)) });
    if (path.endsWith('/remove')) return Response.json({ memberId: 'm/1', role: null });
    throw new Error('connection closed after commit');
  });
  await changeMember('c/1', 'm/1', 'owner', null, 'confirmation-only');
  await assert.rejects(changeMember('c/1', 'm/1', 'member', 'admin'), { code: 'OPERATION_UNCONFIRMED' });
  assert.deepEqual(calls, [
    { path: '/api/companies/c%2F1/members/m%2F1/remove', body: { expectedRole: 'owner', password: 'confirmation-only' } },
    { path: '/api/companies/c%2F1/members/m%2F1/role', body: { expectedRole: 'member', role: 'admin' } },
  ]);
});
