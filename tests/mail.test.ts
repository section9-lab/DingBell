import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mailConfig, mailConfigured } from '../src/modules/mail/config.ts';
import { createMailer } from '../src/modules/mail/resend.ts';
import { MailDeliveryError } from '../src/modules/mail/types.ts';

const env = { RESEND_API_KEY: 'synthetic-resend-key', MAIL_FROM: 'support@example.invalid' };
const message = { to: 'receiver@example.invalid', subject: 'Synthetic message', text: 'Synthetic text', idempotencyKey: 'synthetic-mail-id' };

test('mail configuration needs both a credential and a single header-safe sender address', () => {
  assert.equal(mailConfigured(env), true);
  for (const config of [{}, { ...env, RESEND_API_KEY: '' }, { ...env, MAIL_FROM: '' }, { ...env, MAIL_FROM: 'A <a@example.invalid>' }, { ...env, MAIL_FROM: 'a@example.invalid\r\nBcc:evil@example.invalid' }]) {
    assert.equal(mailConfig(config), null);
    assert.equal(createMailer(config), null);
  }
  assert.equal(mailConfigured({}, { mailer: async () => ({ id: 'injected' }) }), true);
});

test('Resend adapter uses only the official endpoint, suppresses redirects, and waits for acceptance', async () => {
  let calls = 0;
  const mailer = createMailer(env, async (input, init) => {
    calls += 1;
    assert.equal(input, 'https://api.resend.com/emails');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${env.RESEND_API_KEY}`);
    assert.equal(headers.get('idempotency-key'), message.idempotencyKey);
    assert.deepEqual(JSON.parse(String(init?.body)), { from: env.MAIL_FROM, to: [message.to], subject: message.subject, text: message.text });
    return Response.json({ id: 'accepted-fixture' });
  });
  assert.ok(mailer);
  assert.deepEqual(await mailer(message), { id: 'accepted-fixture' });
  assert.equal(calls, 1);
});

test('provider failures, redirects, malformed responses and timeouts never pretend delivery succeeded', async () => {
  for (const failure of [
    async () => Response.json({ message: 'private provider details' }, { status: 403 }),
    async () => new Response(null, { status: 307, headers: { location: 'https://untrusted.example' } }),
    async () => Response.json({ success: true }),
    async () => { throw new Error('private network details'); },
  ]) {
    let calls = 0;
    const mailer = createMailer(env, async () => { calls += 1; return failure(); });
    assert.ok(mailer);
    await assert.rejects(mailer(message), error => error instanceof MailDeliveryError && !String(error).includes('private'));
    assert.equal(calls, 1, 'mail submission has no hidden retries');
  }
});
