import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Hono } from 'hono';
import type { ApplicationEnv } from '../src/http.ts';
import { registerBootstrapRoutes } from '../src/modules/bootstrap/http.ts';
import type { MailMessage, Mailer } from '../src/modules/mail/types.ts';
import { services } from '../src/modules/identity/services.ts';

function fixture(mailer?: Mailer) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter(file => file.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  }
  let failure: ((query: string, values: SQLInputValue[]) => boolean) | undefined;
  const database = {
    prepare(query: string) {
      let values: SQLInputValue[] = [];
      const execute = (arrays = false) => {
        if (failure?.(query, values)) { failure = undefined; throw new Error('Synthetic database interruption'); }
        const statement = sqlite.prepare(query);
        statement.setReturnArrays(arrays);
        return statement.all(...values);
      };
      const prepared = {
        bind(...parameters: SQLInputValue[]) { values = parameters; return prepared; },
        async raw() { return execute(true); },
        async all() { return { success: true, results: execute(), meta: {} }; },
        async first(column?: string) { const row = execute()[0]; return column ? row?.[column] ?? null : row ?? null; },
        async run() { const result = sqlite.prepare(query).run(...values); return { success: true, results: [], meta: { changes: Number(result.changes) } }; },
      };
      return prepared;
    },
  } as unknown as D1Database;
  const env = { DB: database, APP_BASE_URL: 'https://app.example.invalid',
    BETTER_AUTH_SECRET: 'synthetic-bootstrap-auth-secret-long-enough',
    BOOTSTRAP_SECRET: 'synthetic-bootstrap-install-secret-long-enough' };
  const app = new Hono<ApplicationEnv>();
  app.use('*', async (c, next) => { c.set('requestId', crypto.randomUUID()); await next(); });
  app.onError(() => Response.json({ error: { code: 'UNEXPECTED_ERROR' } }, { status: 503 }));
  registerBootstrapRoutes(app, { mailer });
  const claim = { claimId: crypto.randomUUID(), email: 'owner@example.invalid', name: 'Owner', organizationName: 'Example company' };
  const request = (path: string, body?: unknown, secret = env.BOOTSTRAP_SECRET, origin = env.APP_BASE_URL) => app.request(`https://app.example.invalid${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, ...(secret ? { authorization: `Bearer ${secret}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  return { sqlite, env, app, claim, request, close: () => sqlite.close(),
    failOnce: (check: NonNullable<typeof failure>) => { failure = check; } };
}

const acceptingMailer: Mailer = async () => ({ id: 'synthetic-mail' });

async function verifyEmail(f: ReturnType<typeof fixture>, message: MailMessage) {
  const link = message.text.match(/https:\/\/\S+/)?.[0];
  assert.ok(link, 'synthetic mail contains the verification link');
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get('token');
  assert.ok(token);
  const response = await services(f.env, { mailer: acceptingMailer })!.auth.api.verifyEmail({ query: { token }, asResponse: true });
  assert.equal(response.status, 200, 'verification uses the public Better Auth API');
}

test('public bootstrap status reports unavailable configuration without disclosing credentials', async () => {
  const app = new Hono<ApplicationEnv>();
  app.use('*', async (c, next) => { c.set('requestId', crypto.randomUUID()); await next(); });
  registerBootstrapRoutes(app);
  const response = await app.request('/api/bootstrap');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state: 'unavailable', configured: false, emailConfigured: false });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('bootstrap migration enforces one installation slot and valid states', () => {
  const migration = new URL('../migrations/0002_bootstrap.sql', import.meta.url);
  assert.ok(existsSync(migration), 'the production bootstrap migration exists');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(migration, 'utf8'));
    const insert = db.prepare(`INSERT INTO bootstrap_installation
      (id, claim_id, expected_user_id, expected_organization_id, expected_member_id,
       email, name, organization_name, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', 1, 1)`);
    insert.run(1, 'claim-a', 'user-a', 'org-a', 'member-a', 'owner@example.invalid', 'Owner', 'Company');
    assert.throws(() => insert.run(1, 'claim-b', 'user-b', 'org-b', 'member-b', 'other@example.invalid', 'Other', 'Other company'), /UNIQUE constraint failed/);
    assert.throws(() => insert.run(2, 'claim-b', 'user-b', 'org-b', 'member-b', 'other@example.invalid', 'Other', 'Other company'), /CHECK constraint failed/);
    assert.throws(() => db.exec("UPDATE bootstrap_installation SET state = 'unclaimed'"), /CHECK constraint failed/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_list(bootstrap_installation)').all(), []);
  } finally { db.close(); }
});

test('missing mail configuration cannot claim or create an account', async () => {
  const f = fixture();
  try {
    assert.equal((await f.request('/api/bootstrap/claim', f.claim)).status, 503);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM bootstrap_installation').get()?.total, 0);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM user').get()?.total, 0);
  } finally { f.close(); }
});

test('concurrent claims select one owner identity and never overwrite its metadata', async () => {
  const f = fixture(acceptingMailer);
  try {
    const other = { ...f.claim, claimId: crypto.randomUUID(), email: 'other@example.invalid' };
    const replies = await Promise.all([f.request('/api/bootstrap/claim', f.claim), f.request('/api/bootstrap/claim', other)]);
    assert.deepEqual(replies.map(reply => reply.status).sort(), [201, 409]);
    const winning = replies[0].status === 201 ? f.claim : other;
    assert.equal((await f.request('/api/bootstrap/claim', winning)).status, 200);
    assert.equal((await f.request('/api/bootstrap/claim', { ...winning, organizationName: 'Changed' })).status, 409);
    const privateStatus = await (await f.request('/api/bootstrap')).json() as { claim: typeof winning & { step: string } };
    assert.deepEqual(privateStatus.claim, { ...winning, step: 'account_pending' });
    const publicStatus = await (await f.request('/api/bootstrap', undefined, '')).json();
    assert.deepEqual(publicStatus, { state: 'provisioning', configured: true, emailConfigured: true });
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM user').get()?.total, 0);
  } finally { f.close(); }
});

test('bootstrap rejects foreign origins, invalid secrets and URL credentials before changing state', async () => {
  const f = fixture(acceptingMailer);
  try {
    assert.equal((await f.request('/api/bootstrap/claim', f.claim, 'wrong')).status, 401);
    assert.equal((await f.request('/api/bootstrap/claim', f.claim, f.env.BOOTSTRAP_SECRET, 'https://foreign.example.invalid')).status, 403);
    assert.equal((await f.request('/api/bootstrap?secret=synthetic')).status, 400);
    assert.equal((await f.request('/api/bootstrap/claim', { ...f.claim, secret: 'body-credentials' })).status, 400);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM bootstrap_installation').get()?.total, 0);
  } finally { f.close(); }
});

test('an existing account cannot become the installation owner', async () => {
  const f = fixture(acceptingMailer);
  try {
    f.sqlite.prepare('INSERT INTO user (id,name,email,email_verified) VALUES (?,?,?,1)').run('existing-user', 'Existing', f.claim.email);
    assert.equal((await f.request('/api/bootstrap/claim', f.claim)).status, 409);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM bootstrap_installation').get()?.total, 0);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM member').get()?.total, 0);
  } finally { f.close(); }
});

test('an unverified owner receives no organization until email verification and a correct password', async () => {
  const mails: MailMessage[] = [];
  const f = fixture(async message => { mails.push(message); return { id: 'synthetic-mail' }; });
  const password = 'Synthetic-password-for-bootstrap-1';
  try {
    assert.equal((await f.request('/api/bootstrap/claim', f.claim)).status, 201);
    const pending = await f.request('/api/bootstrap/resume', { claimId: f.claim.claimId, password });
    assert.equal(pending.status, 202);
    assert.deepEqual(await pending.json(), { state: 'provisioning', step: 'email_verification_required', verificationEmail: 'accepted' });
    assert.equal(mails.length, 1);
    assert.equal(f.sqlite.prepare('SELECT email_verified FROM user').get()?.email_verified, 0);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM member').get()?.total, 0);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM session').get()?.total, 0);
    assert.equal(pending.headers.get('set-cookie'), null);
    await verifyEmail(f, mails[0]);
    assert.equal((await f.request('/api/bootstrap/resume', { claimId: f.claim.claimId, password: 'Incorrect-password-value' })).status, 401);
    const completed = await f.request('/api/bootstrap/resume', { claimId: f.claim.claimId, password });
    assert.equal(completed.status, 200);
    const result = await completed.json() as Record<string, unknown>;
    assert.equal(result.state, 'initialized');
    assert.equal(Object.hasOwn(result, 'token'), false);
    assert.ok(completed.headers.getSetCookie().some(cookie => cookie.includes('session_token=') && cookie.includes('HttpOnly')));
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM user').get()?.total, 1);
    assert.equal(f.sqlite.prepare('SELECT role FROM member').get()?.role, 'owner');
    assert.equal((await f.request('/api/bootstrap/resume', { claimId: f.claim.claimId, password })).status, 410);
    assert.equal((await f.request('/api/bootstrap/claim', { ...f.claim, claimId: crypto.randomUUID() })).status, 410);
  } finally { f.close(); }
});

test('a failed mail attempt recovers the same unverified account without persisting the password', async () => {
  const mails: MailMessage[] = [];
  let attempt = 0;
  const f = fixture(async message => { if (++attempt === 1) throw new Error('synthetic mail interruption'); mails.push(message); return { id: 'synthetic-mail' }; });
  const password = 'Synthetic-password-for-bootstrap-2';
  try {
    await f.request('/api/bootstrap/claim', f.claim);
    assert.equal((await f.request('/api/bootstrap/resume', { claimId: f.claim.claimId, password })).status, 503);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM user').get()?.total, 1);
    assert.equal((await f.request('/api/bootstrap/resume', { claimId: f.claim.claimId, password })).status, 202);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM user').get()?.total, 1);
    const job = f.sqlite.prepare('SELECT * FROM bootstrap_installation').get();
    assert.equal(JSON.stringify(job).includes(password), false);
    assert.equal(job?.state, 'provisioning');
    assert.equal(mails.length, 1);
  } finally { f.close(); }
});

test('an interrupted organization checkpoint resumes without creating a second company or owner', async () => {
  const mails: MailMessage[] = [];
  const f = fixture(async message => { mails.push(message); return { id: 'synthetic-mail' }; });
  const password = 'Synthetic-password-for-bootstrap-3';
  try {
    await f.request('/api/bootstrap/claim', f.claim);
    assert.equal((await f.request('/api/bootstrap/resume', { claimId: f.claim.claimId, password })).status, 202);
    await verifyEmail(f, mails[0]);
    f.failOnce((query, values) => query.startsWith('update "bootstrap_installation"') && values.includes('initialized'));
    assert.equal((await f.request('/api/bootstrap/resume', { claimId: f.claim.claimId, password })).status, 503);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM organization').get()?.total, 1);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM member').get()?.total, 1);
    assert.equal((await f.request('/api/bootstrap/resume', { claimId: f.claim.claimId, password })).status, 200);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM organization').get()?.total, 1);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM member').get()?.total, 1);
  } finally { f.close(); }
});

test('a credential without a password is reported as needing password recovery', async () => {
  const f = fixture(acceptingMailer);
  try {
    await f.request('/api/bootstrap/claim', f.claim);
    assert.equal((await f.request('/api/bootstrap/resume', { claimId: f.claim.claimId, password: 'Synthetic-password-for-bootstrap-4' })).status, 202);
    f.sqlite.exec('UPDATE account SET password = NULL');
    const response = await f.request('/api/bootstrap');
    const status = await response.json() as { claim: { step: string } };
    assert.equal(status.claim.step, 'password_recovery_required');
  } finally { f.close(); }
});

test('a concurrent resume cannot create a second account or send verification twice', async () => {
  const entered = Promise.withResolvers<void>();
  const accepted = Promise.withResolvers<{ id: string }>();
  let deliveries = 0;
  const f = fixture(async () => { deliveries++; entered.resolve(); return accepted.promise; });
  try {
    await f.request('/api/bootstrap/claim', f.claim);
    const body = { claimId: f.claim.claimId, password: 'Synthetic-password-for-bootstrap-5' };
    const running = f.request('/api/bootstrap/resume', body);
    await entered.promise;
    assert.equal((await f.request('/api/bootstrap/resume', body)).status, 409);
    accepted.resolve({ id: 'synthetic-mail' });
    assert.equal((await running).status, 202);
    assert.equal((await f.request('/api/bootstrap/resume', body)).status, 202);
    assert.equal(deliveries, 1);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM user').get()?.total, 1);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM account').get()?.total, 1);
  } finally { accepted.resolve({ id: 'synthetic-mail' }); f.close(); }
});

test('a stale execution cannot checkpoint or release the replacement lease', async () => {
  const entered = Promise.withResolvers<void>();
  const accepted = Promise.withResolvers<{ id: string }>();
  const f = fixture(async () => { entered.resolve(); return accepted.promise; });
  try {
    await f.request('/api/bootstrap/claim', f.claim);
    const running = f.request('/api/bootstrap/resume', { claimId: f.claim.claimId, password: 'Synthetic-password-for-bootstrap-6' });
    await entered.promise;
    f.sqlite.prepare('UPDATE bootstrap_installation SET execution_id = ?, lease_until = ?').run('replacement-execution', Date.now() + 120_000);
    accepted.resolve({ id: 'synthetic-mail' });
    assert.equal((await running).status, 409);
    const job = f.sqlite.prepare('SELECT execution_id, verification_requested_at, state FROM bootstrap_installation').get();
    assert.equal(job?.execution_id, 'replacement-execution');
    assert.equal(job?.verification_requested_at, null);
    assert.equal(job?.state, 'provisioning');
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM member').get()?.total, 0);
  } finally { accepted.resolve({ id: 'synthetic-mail' }); f.close(); }
});

test('an interrupted credential write recovers through public password reset without a second identity', async () => {
  const mails: MailMessage[] = [];
  const mailer: Mailer = async message => { mails.push(message); return { id: 'synthetic-mail' }; };
  const f = fixture(mailer);
  const password = 'Synthetic-password-for-bootstrap-7';
  try {
    await f.request('/api/bootstrap/claim', f.claim);
    f.failOnce(query => query.startsWith('insert into "account"'));
    assert.equal((await f.request('/api/bootstrap/resume', { claimId: f.claim.claimId, password })).status, 503);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM user').get()?.total, 1);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM account').get()?.total, 0);
    const retry = await f.request('/api/bootstrap/resume', { claimId: f.claim.claimId, password });
    assert.equal(retry.status, 202);
    assert.equal((await retry.json() as { step: string }).step, 'password_recovery_required');
    await verifyEmail(f, mails[0]);
    const auth = services(f.env, { mailer })!.auth;
    await auth.api.requestPasswordReset({ body: { email: f.claim.email } });
    const resetLink = mails.at(-1)?.text.match(/https:\/\/\S+/)?.[0];
    assert.ok(resetLink);
    const token = new URLSearchParams(new URL(resetLink).hash.slice(1)).get('token');
    assert.ok(token);
    assert.equal((await auth.api.resetPassword({ body: { token, newPassword: password }, asResponse: true })).status, 200);
    assert.equal((await f.request('/api/bootstrap/resume', { claimId: f.claim.claimId, password })).status, 200);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM user').get()?.total, 1);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM account').get()?.total, 1);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM member').get()?.total, 1);
  } finally { f.close(); }
});

test('a company created before interruption at the owner write is safely resumed', async () => {
  const mails: MailMessage[] = [];
  const f = fixture(async message => { mails.push(message); return { id: 'synthetic-mail' }; });
  const body = { claimId: f.claim.claimId, password: 'Synthetic-password-for-bootstrap-8' };
  try {
    await f.request('/api/bootstrap/claim', f.claim);
    assert.equal((await f.request('/api/bootstrap/resume', body)).status, 202);
    await verifyEmail(f, mails[0]);
    f.sqlite.exec("CREATE TRIGGER synthetic_member_failure BEFORE INSERT ON member BEGIN SELECT RAISE(ABORT, 'Synthetic member failure'); END");
    assert.equal((await f.request('/api/bootstrap/resume', body)).status, 503);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM organization').get()?.total, 1);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM member').get()?.total, 0);
    f.sqlite.exec('DROP TRIGGER synthetic_member_failure');
    assert.equal((await f.request('/api/bootstrap/resume', body)).status, 200);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM organization').get()?.total, 1);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM member').get()?.total, 1);
    f.sqlite.exec(`INSERT INTO user (id,name,email,email_verified) VALUES ('synthetic-backup-owner','Backup','backup@example.invalid',1);
      INSERT INTO member (id,organization_id,user_id,role,created_at)
        SELECT 'synthetic-backup-member',expected_organization_id,'synthetic-backup-owner','owner',1 FROM bootstrap_installation;
      DELETE FROM member WHERE id = (SELECT expected_member_id FROM bootstrap_installation)`);
    assert.equal((await f.request('/api/bootstrap/resume', body)).status, 410);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM member').get()?.total, 1);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM member WHERE id=(SELECT expected_member_id FROM bootstrap_installation)').get()?.total, 0);
    delete (f.env as { BOOTSTRAP_SECRET?: string }).BOOTSTRAP_SECRET;
    assert.equal((await (await f.request('/api/bootstrap', undefined, '')).json() as { state: string }).state, 'initialized');
  } finally { f.close(); }
});
