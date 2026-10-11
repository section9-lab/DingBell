import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditedChange } from '../src/modules/audit/operation.ts';

test('company changes do not execute when the audit intent cannot be stored', async () => {
  let executed = false;
  await assert.rejects(auditedChange(async () => { throw new Error('offline'); }, async () => {
    executed = true; return new Response('{}');
  }), /audit/i);
  assert.equal(executed, false);
});

test('post-operation audit failure preserves all response cookies and reports uncertainty', async () => {
  let count = 0;
  const response = new Response('{}', { headers: { 'set-cookie': 'synthetic=fixture; HttpOnly' } });
  const result = await auditedChange(async () => { if (++count === 2) throw new Error('offline'); }, async () => response);
  assert.equal(result.auditComplete, false);
  assert.equal(result.response, response);
  assert.equal(result.response.headers.getSetCookie().length, 1);
});

test('logout still revokes and preserves the clear-cookie response if audit storage fails', async () => {
  let revoked = false;
  const result = await auditedChange(async () => { throw new Error('offline'); }, async () => {
    revoked = true; return new Response('{}', { headers: { 'set-cookie': 'synthetic=; Max-Age=0' } });
  }, true);
  assert.equal(revoked, true);
  assert.equal(result.auditComplete, false);
  assert.match(result.response.headers.get('set-cookie')!, /Max-Age=0/);
});

test('audit distinguishes confirmed rejection from unknown operation failure', async () => {
  const events: string[] = [];
  await auditedChange(async outcome => { events.push(outcome); }, async () => new Response('{}', { status: 403 }));
  assert.deepEqual(events, ['started', 'rejected']);
  events.length = 0;
  await assert.rejects(auditedChange(async outcome => { events.push(outcome); }, async () => { throw new Error('unknown internal details'); }), /unconfirmed/i);
  assert.deepEqual(events, ['started', 'unknown']);
});
