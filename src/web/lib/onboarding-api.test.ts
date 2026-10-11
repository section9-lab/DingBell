/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeInvitation, createInvitation } from './onboarding-api.ts';

test('an HTTP 200 without an invitation and mail receipt never reports successful delivery', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('not-json', { status: 200 }));
  await assert.rejects(createInvitation('company', 'test@example.invalid', 'member'), { code: 'OPERATION_UNCONFIRMED' });
  await assert.rejects(changeInvitation('company', 'invitation', 'resend'), { code: 'OPERATION_UNCONFIRMED' });
});

test('revocation requires a canceled invitation in the response', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ invitation: {
    id: 'i', email: 'test@example.invalid', role: 'member', status: 'pending',
    createdAt: '2026-10-09T00:00:00.000Z', expiresAt: '2026-10-11T00:00:00.000Z',
  } }));
  await assert.rejects(changeInvitation('company', 'i', 'revoke'), { code: 'OPERATION_UNCONFIRMED' });
});
