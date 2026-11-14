import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { Miniflare } from 'miniflare';
import type { ApplicationEnv } from '../src/http.ts';
import { registerIdentityRoutes } from '../src/modules/identity/http.ts';
import { bootstrapServices, services } from '../src/modules/identity/services.ts';
import type { MailMessage } from '../src/modules/mail/types.ts';
import { applyMigrations } from './fixtures/migrations.ts';

test(
  'email OTP and password sign-in share the same account and never remove company data',
  { timeout: 60_000 },
  async (context) => {
    const mf = new Miniflare({
      modules: true,
      script: 'export default {fetch(){return new Response("fixture")}}',
      compatibilityDate: '2026-06-01',
      d1Databases: { DB: crypto.randomUUID() },
    });
    context.after(() => mf.dispose());
    const db = await mf.getD1Database('DB');
    await applyMigrations(db);
    const env = {
      DB: db as unknown as D1Database,
      APP_BASE_URL: 'https://dingbell.example',
      BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
    };
    const messages: MailMessage[] = [];
    const deps = {
      mailer: async (message: MailMessage) => {
        messages.push(message);
        return { id: 'synthetic-otp-mail' };
      },
    };
    const app = new Hono<ApplicationEnv>();
    app.use('*', async (c, next) => {
      c.set('requestId', crypto.randomUUID());
      await next();
    });
    app.onError(() => new Response('unexpected', { status: 500 }));
    registerIdentityRoutes(app, undefined, deps);

    const tasks: Promise<unknown>[] = [];
    const execution = {
      waitUntil: (promise: Promise<unknown>) => {
        tasks.push(promise);
      },
      passThroughOnException() {},
      props: {},
    } as ExecutionContext;
    let client = 0;
    function post(path: string, body: unknown, target = app, withExecution = true) {
      const headers = {
        origin: env.APP_BASE_URL,
        'content-type': 'application/json',
        'cf-connecting-ip': `192.0.2.${++client}`,
      };
      return target.fetch(
        new Request(`${env.APP_BASE_URL}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }),
        env,
        withExecution ? execution : undefined,
      );
    }
    async function drain() {
      while (tasks.length) await Promise.all(tasks.splice(0));
    }
    function otpFor(email: string) {
      const message = messages.findLast(
        (item) => item.to === email && item.subject.includes('验证码'),
      );
      assert.ok(message, 'a synthetic OTP mail was captured');
      const otp = message.text.match(/\b(\d{6})\b/)?.[1];
      assert.ok(otp, 'the OTP mail contains a six-digit code');
      return otp;
    }

    async function seed(email: string, password: string, verified: boolean) {
      const ids = {
        userId: crypto.randomUUID(),
        organizationId: crypto.randomUUID(),
        memberId: crypto.randomUUID(),
      };
      const trusted = bootstrapServices(env, ids, deps)!;
      const created = await trusted.auth.api.signUpEmail({
        body: { name: 'Fixture', email, password },
      });
      assert.equal(created.user.id, ids.userId);
      if (verified)
        await db.prepare('UPDATE user SET email_verified = 1 WHERE id = ?').bind(ids.userId).run();
      return { ids, password };
    }

    // A real company membership, so the test can prove OTP never touches business rows.
    const owner = await seed('owner@example.invalid', crypto.randomUUID() + '!Aa1', true);
    const companyId = crypto.randomUUID();
    await db
      .prepare('INSERT INTO organization (id, name, slug, created_at) VALUES (?, ?, ?, ?)')
      .bind(companyId, 'Fixture Company', `fixture-${companyId}`, Date.now())
      .run();
    await db
      .prepare(
        'INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(owner.ids.memberId, companyId, owner.ids.userId, 'owner', Date.now())
      .run();

    await context.test('OTP signs in the same user and keeps password + membership', async () => {
      const sent = await post('/api/auth/email-otp/send-verification-otp', {
        email: 'owner@example.invalid',
        type: 'sign-in',
      });
      assert.equal(sent.status, 202);
      assert.deepEqual(await sent.json(), { accepted: true });
      await drain();

      const wrong = await post('/api/auth/sign-in/email-otp', {
        email: 'owner@example.invalid',
        otp: '000000',
      });
      assert.equal(wrong.status, 400);
      assert.equal(((await wrong.json()) as { error: { code: string } }).error.code, 'INVALID_OTP');

      const signedIn = await post('/api/auth/sign-in/email-otp', {
        email: 'owner@example.invalid',
        otp: otpFor('owner@example.invalid'),
      });
      assert.equal(signedIn.status, 200);
      const body = (await signedIn.json()) as { user: { id: string; emailVerified: boolean } };
      assert.equal(body.user.id, owner.ids.userId);
      assert.equal(body.user.emailVerified, true);
      assert.ok(signedIn.headers.getSetCookie().length > 0, 'OTP sign-in establishes a session');

      const credential = await db
        .prepare("SELECT id FROM account WHERE user_id = ? AND provider_id = 'credential'")
        .bind(owner.ids.userId)
        .first();
      assert.ok(credential, 'the existing password credential is preserved');
      const member = await db
        .prepare('SELECT id FROM member WHERE user_id = ?')
        .bind(owner.ids.userId)
        .first();
      assert.ok(member, 'the company membership is preserved');

      const passwordSignIn = await services(env, deps)!.auth.api.signInEmail({
        body: { email: 'owner@example.invalid', password: owner.password },
        asResponse: true,
      });
      assert.equal(passwordSignIn.status, 200, 'password sign-in still works after OTP sign-in');
    });

    await context.test('unknown emails cannot create accounts or receive mail', async () => {
      const before = await db
        .prepare('SELECT COUNT(*) AS count FROM user')
        .first<{ count: number }>();
      const sent = await post('/api/auth/email-otp/send-verification-otp', {
        email: 'absent@example.invalid',
        type: 'sign-in',
      });
      assert.equal(sent.status, 202);
      assert.deepEqual(await sent.json(), { accepted: true });
      await drain();
      assert.equal(
        messages.some((message) => message.to === 'absent@example.invalid'),
        false,
      );
      const signedIn = await post('/api/auth/sign-in/email-otp', {
        email: 'absent@example.invalid',
        otp: '123456',
      });
      assert.equal(signedIn.status, 400);
      const after = await db
        .prepare('SELECT COUNT(*) AS count FROM user')
        .first<{ count: number }>();
      assert.equal(after?.count, before?.count);
    });

    await context.test(
      'a legacy unverified account keeps its password when OTP verifies it',
      async () => {
        const legacy = await seed('legacy@example.invalid', crypto.randomUUID() + '!Aa2', false);
        const sent = await post('/api/auth/email-otp/send-verification-otp', {
          email: 'legacy@example.invalid',
          type: 'sign-in',
        });
        assert.equal(sent.status, 202);
        await drain();
        const signedIn = await post('/api/auth/sign-in/email-otp', {
          email: 'legacy@example.invalid',
          otp: otpFor('legacy@example.invalid'),
        });
        assert.equal(signedIn.status, 200);
        const user = await db
          .prepare('SELECT email_verified FROM user WHERE id = ?')
          .bind(legacy.ids.userId)
          .first<{ email_verified: number }>();
        assert.equal(user?.email_verified, 1);
        const credential = await db
          .prepare("SELECT id FROM account WHERE user_id = ? AND provider_id = 'credential'")
          .bind(legacy.ids.userId)
          .first();
        assert.ok(credential, 'promotion must not delete the credential account');
        const passwordSignIn = await services(env, deps)!.auth.api.signInEmail({
          body: { email: 'legacy@example.invalid', password: legacy.password },
          asResponse: true,
        });
        assert.equal(passwordSignIn.status, 200);
      },
    );

    await context.test('the send route fails closed without a mailer', async () => {
      const withoutMail = new Hono<ApplicationEnv>();
      withoutMail.use('*', async (c, next) => {
        c.set('requestId', crypto.randomUUID());
        await next();
      });
      registerIdentityRoutes(withoutMail);
      const response = await post(
        '/api/auth/email-otp/send-verification-otp',
        {
          email: 'owner@example.invalid',
          type: 'sign-in',
        },
        withoutMail,
      );
      assert.equal(response.status, 503);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        'MAIL_NOT_CONFIGURED',
      );
    });
  },
);
