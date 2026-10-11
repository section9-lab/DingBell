import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authOptions } from '../src/modules/identity/config.ts';
import { MailDeliveryError, type MailMessage } from '../src/modules/mail/types.ts';

const config = { baseURL: 'https://dingbell.example', secret: 'synthetic-mail-auth-secret-for-tests' };
const user = { id: 'user-fixture', email: 'owner@example.invalid', name: 'Fixture', emailVerified: false, createdAt: new Date(), updatedAt: new Date() };

test('official callbacks use fixed fragment links and do not send automatically during sign-up or sign-in', async () => {
  const messages: MailMessage[] = [];
  const options = authOptions(config, { mailer: async message => { messages.push(message); return { id: 'accepted' }; } });
  assert.equal(options.emailVerification?.sendOnSignUp, false);
  assert.equal(options.emailVerification?.sendOnSignIn, false);
  assert.equal(options.emailVerification?.autoSignInAfterVerification, false);
  assert.equal(options.emailAndPassword.revokeSessionsOnPasswordReset, true);
  assert.ok(options.emailVerification?.sendVerificationEmail);
  await options.emailVerification.sendVerificationEmail({ user, url: 'https://untrusted.example', token: 'verify-fixture' });
  assert.ok(options.emailAndPassword.sendResetPassword);
  await options.emailAndPassword.sendResetPassword({ user, url: 'https://untrusted.example', token: 'reset-fixture' });
  assert.match(messages[0]!.text, /https:\/\/dingbell\.example\/verify-email#token=verify-fixture/);
  assert.match(messages[1]!.text, /https:\/\/dingbell\.example\/reset-password#token=reset-fixture/);
  assert.equal(JSON.stringify(messages).includes('untrusted'), false);
  assert.equal(options.emailAndPassword.disableSignUp, true);
  const organization = options.plugins.find(plugin => plugin.id === 'organization')!.options;
  await organization.sendInvitationEmail!({ email: user.email, id: 'invitation-fixture', organization: { name: 'Fixture' } } as never);
  assert.match(messages[2]!.text, /https:\/\/dingbell\.example\/invite\/invitation-fixture/);
});

test('default internal callback awaits failures instead of claiming that mail was sent', async () => {
  const options = authOptions(config, { mailer: async () => { throw new MailDeliveryError(); } });
  assert.ok(options.emailVerification?.sendVerificationEmail);
  await assert.rejects(options.emailVerification.sendVerificationEmail({ user, url: '', token: 'fixture' }), MailDeliveryError);
});

test('public-request scheduling separates acceptance from eventual provider completion', async () => {
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  const scheduled: Promise<void>[] = [];
  const options = authOptions(config, {
    mailer: async () => { await pending; return { id: 'accepted-later' }; },
    schedule: delivery => { scheduled.push(delivery); },
  });
  assert.ok(options.emailVerification?.sendVerificationEmail);
  await options.emailVerification.sendVerificationEmail({ user, url: '', token: 'fixture' });
  assert.equal(scheduled.length, 1);
  release();
  await scheduled[0];
});
