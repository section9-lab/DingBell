import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Hono } from 'hono';
import { Miniflare } from 'miniflare';
import { apiError, type ApplicationEnv } from '../src/http.ts';
import { bootstrapServices, services } from '../src/modules/identity/services.ts';
import { registerVerificationRoutes } from '../src/modules/identity/verification-http.ts';
import { MailDeliveryError, type MailMessage } from '../src/modules/mail/types.ts';

test('public verification and recovery use the real Better Auth SDK and isolated D1', { timeout: 60_000 }, async context => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}',
    compatibilityDate: '2026-06-01', d1Databases: { DB: crypto.randomUUID() } });
  context.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map(part => part.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  const env = { DB: db as unknown as D1Database, APP_BASE_URL: 'https://dingbell.example', BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID() };
  const password = crypto.randomUUID() + '!Aa1';
  const messages: MailMessage[] = [];
  let delivery: 'success' | 'fail' | 'pending' = 'success';
  let release = () => {};
  let gate = Promise.resolve();
  const deps = { mailer: async (message: MailMessage) => {
    messages.push(message);
    if (delivery === 'pending') await gate;
    if (delivery === 'fail') throw new MailDeliveryError();
    return { id: 'synthetic-provider-acceptance' };
  } };
  const app = new Hono<ApplicationEnv>();
  app.use('*', async (c, next) => { c.set('requestId', crypto.randomUUID()); await next(); });
  app.onError((_error, c) => apiError(c, 'IDENTITY_UNAVAILABLE', 'Identity service is temporarily unavailable.', 503));
  registerVerificationRoutes(app, deps);
  const withoutMail = new Hono<ApplicationEnv>();
  withoutMail.use('*', async (c, next) => { c.set('requestId', crypto.randomUUID()); await next(); });
  registerVerificationRoutes(withoutMail);
  const tasks: Promise<unknown>[] = [];
  const execution = { waitUntil: (promise: Promise<unknown>) => { tasks.push(promise); }, passThroughOnException() {}, props: {} } as ExecutionContext;
  const ids = { userId: crypto.randomUUID(), organizationId: crypto.randomUUID(), memberId: crypto.randomUUID() };
  const trusted = bootstrapServices(env, ids, deps)!;
  const created = await trusted.auth.api.signUpEmail({ body: { name: 'Fixture', email: 'owner@example.invalid', password } });
  assert.equal(created.user.id, ids.userId, 'trusted factory reserves only the intended identity');
  assert.equal(messages.length, 0, 'account creation does not claim that a mail was sent');
  let client = 1;
  const headers = () => ({ origin: env.APP_BASE_URL, 'content-type': 'application/json', 'cf-connecting-ip': `192.0.2.${client}` });
  function post(path: string, body: unknown, target = app, origin = env.APP_BASE_URL, withExecution = true) {
    return target.fetch(new Request(`${env.APP_BASE_URL}${path}`, { method: 'POST', headers: { ...headers(), origin }, body: JSON.stringify(body) }), env, withExecution ? execution : undefined);
  }
  async function drain() { while (tasks.length) await Promise.all(tasks.splice(0)); }
  function token(kind: 'verify-email' | 'reset-password') {
    const message = messages.findLast(item => item.text.includes(`/${kind}#`));
    assert.ok(message, 'a synthetic mail was captured');
    const link = message.text.split('\n').find(line => line.startsWith('https://'))!;
    const url = new URL(link);
    assert.equal(url.origin, env.APP_BASE_URL);
    assert.equal(url.pathname, `/${kind}`);
    assert.equal(url.search, '');
    return new URLSearchParams(url.hash.slice(1)).get('token')!;
  }

  await context.test('public requests accept neutrally before slow mail delivery and preserve native rate limits', async () => {
    gate = new Promise<void>(resolve => { release = resolve; });
    delivery = 'pending';
    try {
      const response = await Promise.race([post('/api/auth/send-verification-email', { email: 'owner@example.invalid' }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Public acceptance waited for the provider')), 2_500))]);
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { accepted: true });
      const unknown = await post('/api/auth/send-verification-email', { email: 'absent@example.invalid' });
      assert.equal(unknown.status, 202);
      assert.deepEqual(await unknown.json(), { accepted: true });
      assert.equal(messages.length, 1);
      await post('/api/auth/send-verification-email', { email: 'absent@example.invalid' });
      assert.equal((await post('/api/auth/send-verification-email', { email: 'absent@example.invalid' })).status, 429);
    } finally { release(); delivery = 'success'; await drain(); }
  });
  await context.test('mail/configuration failures do not reveal email existence or invent delivery success', async () => {
    client += 1; delivery = 'fail';
    for (const email of ['owner@example.invalid', 'absent@example.invalid']) {
      const response = await post('/api/auth/send-verification-email', { email });
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { accepted: true });
      const disabled = await post('/api/auth/send-verification-email', { email }, withoutMail);
      assert.equal(disabled.status, 503);
      assert.equal((await disabled.json() as { error: { code: string } }).error.code, 'MAIL_NOT_CONFIGURED');
    }
    await drain(); delivery = 'success';
    const events = await db.prepare("SELECT outcome FROM identity_audit_event WHERE action = 'mail.verification.submit'").all<{ outcome: string }>();
    assert.ok(events.results.some(event => event.outcome === 'rejected'));
    assert.equal((await post('/api/auth/request-password-reset', { email: 'owner@example.invalid' }, app, env.APP_BASE_URL, false)).status, 503);
  });
  await context.test('only same-origin POST confirms a token and it never creates a session', async () => {
    client += 1;
    const verification = token('verify-email');
    assert.equal((await post('/api/auth/verify-email', { token: verification }, app, 'https://untrusted.example')).status, 403);
    assert.equal((await post('/api/auth/verify-email', { token: verification, callbackURL: 'https://untrusted.example' })).status, 400);
    const response = await post('/api/auth/verify-email', { token: verification });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { verified: true });
    assert.equal(response.headers.getSetCookie().length, 0);
    const audits = await db.prepare('SELECT action,outcome FROM identity_audit_event WHERE request_id = ? ORDER BY created_at,rowid').bind(response.headers.get('x-request-id')).all<{ action: string; outcome: string }>();
    assert.deepEqual(audits.results.map(row => [row.action, row.outcome]), [['auth.email.verify', 'started'], ['auth.email.verify', 'succeeded']]);
    assert.equal((await app.fetch(new Request(`${env.APP_BASE_URL}/api/auth/verify-email?token=${verification}`), env, execution)).status, 404);
    const invalid = await post('/api/auth/verify-email', { token: 'invalid' });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json() as { error: { code: string } }).error.code, 'INVALID_LINK');
  });
  await context.test('reset consumes the token, replaces the password and revokes previous sessions', async () => {
    client += 1;
    const auth = services(env, deps)!.auth;
    const before = await auth.api.signInEmail({ body: { email: 'owner@example.invalid', password }, headers: new Headers(headers()), asResponse: true });
    assert.equal(before.status, 200);
    const cookie = before.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
    const response = await post('/api/auth/request-password-reset', { email: 'owner@example.invalid' });
    assert.equal(response.status, 202); await drain();
    const resetToken = token('reset-password');
    const nextPassword = crypto.randomUUID() + '!Aa2';
    const reset = await post('/api/auth/reset-password', { token: resetToken, newPassword: nextPassword });
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), { success: true });
    assert.equal(await auth.api.getSession({ headers: new Headers({ cookie }) }), null);
    assert.equal((await post('/api/auth/reset-password', { token: resetToken, newPassword: nextPassword })).status, 400);
    assert.equal((await auth.api.signInEmail({ body: { email: 'owner@example.invalid', password: nextPassword }, headers: new Headers(headers()), asResponse: true })).status, 200);
    await post('/api/auth/request-password-reset', { email: 'owner@example.invalid' }); await drain();
    await db.prepare('UPDATE verification SET expires_at = 0').run();
    assert.equal((await post('/api/auth/reset-password', { token: token('reset-password'), newPassword: nextPassword })).status, 400);
  });
  await context.test('recovery can repair an unfinished credential while retaining the verification gate', async () => {
    client += 1;
    const now = Date.now();
    await db.prepare('INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('partial-user', 'Partial', 'partial@example.invalid', 0, now, now).run();
    assert.equal((await post('/api/auth/request-password-reset', { email: 'partial@example.invalid' })).status, 202); await drain();
    assert.equal((await post('/api/auth/reset-password', { token: token('reset-password'), newPassword: password })).status, 200);
    const account = await db.prepare("SELECT provider_id FROM account WHERE user_id = 'partial-user'").first<{ provider_id: string }>();
    assert.equal(account?.provider_id, 'credential');
    assert.equal((await services(env, deps)!.auth.api.signInEmail({ body: { email: 'partial@example.invalid', password }, asResponse: true })).status, 403);
  });
  await context.test('reset audit intent failure prevents consuming the token and completion failure reports uncertainty', async () => {
    client += 1;
    await post('/api/auth/request-password-reset', { email: 'owner@example.invalid' }); await drain();
    const resetToken = token('reset-password');
    await db.exec("CREATE TRIGGER fixture_audit_fault BEFORE INSERT ON identity_audit_event WHEN NEW.action = 'auth.password.reset' AND NEW.outcome = 'started' BEGIN SELECT RAISE(FAIL, 'synthetic audit failure'); END;");
    const logging = context.mock.method(console, 'error', () => {});
    try {
      const response = await post('/api/auth/reset-password', { token: resetToken, newPassword: password });
      assert.equal(response.status, 503);
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'AUDIT_UNAVAILABLE');
      assert.ok(await db.prepare('SELECT id FROM verification WHERE identifier = ?').bind(`reset-password:${resetToken}`).first());
      assert.equal(logging.mock.callCount(), 0, 'expected audit outages do not write SDK error stacks');
    } finally { logging.mock.restore(); await db.exec('DROP TRIGGER fixture_audit_fault;'); }
    await db.exec("CREATE TRIGGER fixture_audit_fault BEFORE INSERT ON identity_audit_event WHEN NEW.action = 'auth.password.reset' AND NEW.outcome = 'succeeded' BEGIN SELECT RAISE(FAIL, 'synthetic audit failure'); END;");
    try {
      const response = await post('/api/auth/reset-password', { token: resetToken, newPassword: password });
      assert.equal(response.status, 503);
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'OPERATION_UNCONFIRMED');
      assert.equal(await db.prepare('SELECT id FROM verification WHERE identifier = ?').bind(`reset-password:${resetToken}`).first(), null);
    } finally { await db.exec('DROP TRIGGER fixture_audit_fault;'); }
  });
  await context.test('confirmation limiter rejects excess attempts before writing any audit event', async () => {
    client += 1;
    for (let index = 0; index < 10; index += 1) {
      assert.equal((await post('/api/auth/verify-email', { token: 'invalid' })).status, 400);
    }
    const response = await post('/api/auth/verify-email', { token: 'invalid' });
    assert.equal(response.status, 429);
    const events = await db.prepare('SELECT id FROM identity_audit_event WHERE request_id = ?').bind(response.headers.get('x-request-id')).all();
    assert.equal(events.results.length, 0);
  });
});
