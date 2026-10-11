import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Hono } from 'hono';
import { hashPassword } from 'better-auth/crypto';
import { apiError, type ApplicationEnv } from '../src/http.ts';
import { AuditUnavailable, OperationUnconfirmed } from '../src/modules/audit/operation.ts';
import { services } from '../src/modules/identity/services.ts';
import { registerInvitationRoutes } from '../src/modules/invitations/http.ts';
import type { MailMessage } from '../src/modules/mail/types.ts';

function sqliteD1(sqlite: DatabaseSync): D1Database {
  function prepare(sql: string, values: SQLInputValue[] = []) {
    return {
      bind: (...parameters: SQLInputValue[]) => prepare(sql, parameters),
      async all() { return { results: sqlite.prepare(sql).all(...values), success: true, meta: {} }; },
      async raw() { return sqlite.prepare(sql).all(...values).map(row => Object.values(row)); },
      async first(column?: string) { const row = sqlite.prepare(sql).get(...values); return row ? column ? row[column] : row : null; },
      async run() { const result = sqlite.prepare(sql).run(...values); return { success: true, results: [], meta: { changes: Number(result.changes) } }; },
    };
  }
  return { prepare } as unknown as D1Database;
}

async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const folder = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(folder).filter(file => file.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, folder), 'utf8'));
  const password = 'synthetic-invitation-fixture-password';
  const hashed = await hashPassword(password);
  for (const id of ['owner', 'recipient', 'other', 'staff']) {
    sqlite.prepare('INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,1,1,1)').run(id, id, `${id}@example.invalid`);
    sqlite.prepare("INSERT INTO account (id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES (?,?,'credential',?,?,1,1)").run(`account-${id}`, id, id, hashed);
  }
  sqlite.exec("INSERT INTO organization (id,name,slug,created_at) VALUES ('company','Company','company',1),('other-company','Other','other',1); INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('owner-member','company','owner','owner',1),('staff-member','company','staff','member',1),('other-member','other-company','other','owner',1)");
  const env = { DB: sqliteD1(sqlite), APP_BASE_URL: 'https://dingbell.example', BETTER_AUTH_SECRET: 'synthetic-invitation-test-secret-at-least-32' };
  const mails: MailMessage[] = [];
  let failMail = false;
  const app = new Hono<ApplicationEnv>();
  app.use('*', async (c, next) => { c.set('requestId', crypto.randomUUID()); await next(); });
  registerInvitationRoutes(app, { mailer: async message => { if (failMail) throw new Error('synthetic mail interruption'); mails.push(message); return { id: `synthetic-mail-${mails.length}` }; } });
  app.onError((error, c) => apiError(c, error instanceof AuditUnavailable ? 'AUDIT_UNAVAILABLE' : error instanceof OperationUnconfirmed ? 'OPERATION_UNCONFIRMED' : 'UNEXPECTED_TEST_ERROR', 'Operation unavailable.', 503));
  const cookies: Record<string, string> = {};
  for (const id of ['owner', 'recipient', 'other', 'staff']) {
    const result = await services(env)!.auth.api.signInEmail({ body: { email: `${id}@example.invalid`, password }, asResponse: true });
    assert.equal(result.status, 200);
    cookies[id] = result.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  }
  const request = (path: string, method = 'GET', actor = 'owner', body?: unknown) => app.request(`https://dingbell.example${path}`, {
    method, headers: { cookie: cookies[actor] ?? '', origin: env.APP_BASE_URL, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  async function invite(email = 'recipient@example.invalid') {
    const response = await request('/api/companies/company/invitations', 'POST', 'owner', { email, role: 'member' });
    assert.equal(response.status, 200);
    return ((await response.json()) as { invitation: { id: string } }).invitation.id;
  }
  return { sqlite, env, request, invite, mails, setMailFailure: (value: boolean) => { failMail = value; }, close: () => sqlite.close() };
}

test('only company owners/admins can create invitations, and owner grants are never accepted', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/companies/company/invitations', 'POST', 'staff', { email: 'recipient@example.invalid', role: 'member' })).status, 403);
    assert.equal((await f.request('/api/companies/company/invitations', 'POST', 'other', { email: 'recipient@example.invalid', role: 'member' })).status, 404);
    assert.equal((await f.request('/api/companies/company/invitations', 'POST', 'owner', { email: 'recipient@example.invalid', role: 'owner' })).status, 400);
    await f.invite();
    assert.equal(f.mails.length, 1);
    assert.equal((await f.request('/api/companies/company/invitations', 'POST', 'owner', { email: 'recipient@example.invalid', role: 'admin' })).status, 409);
  } finally { f.close(); }
});

test('acceptance is recipient-only, repeatable, and cannot restore a subsequently removed member', async () => {
  const f = await fixture();
  try {
    const id = await f.invite();
    assert.equal((await f.request(`/api/invitations/${id}`, 'GET', 'other')).status, 404);
    assert.equal((await f.request(`/api/invitations/${id}/accept`, 'POST', 'other', {})).status, 404);
    f.sqlite.exec("UPDATE user SET email_verified=0 WHERE id='recipient'");
    assert.equal((await f.request(`/api/invitations/${id}/accept`, 'POST', 'recipient', {})).status, 401);
    f.sqlite.exec("UPDATE user SET email_verified=1 WHERE id='recipient'");
    const attempts = await Promise.all([f.request(`/api/invitations/${id}/accept`, 'POST', 'recipient', {}), f.request(`/api/invitations/${id}/accept`, 'POST', 'recipient', {})]);
    assert.ok(attempts.some(response => response.status === 200));
    assert.equal((await f.request(`/api/invitations/${id}/accept`, 'POST', 'recipient', {})).status, 200);
    assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM member WHERE user_id='recipient'").get()!.count, 1);
    f.sqlite.exec("DELETE FROM member WHERE user_id='recipient'");
    const detail = await f.request(`/api/invitations/${id}`, 'GET', 'recipient');
    const details = await detail.json() as { canAccept: boolean; membershipStatus: string };
    assert.equal(details.canAccept, false);
    assert.equal(details.membershipStatus, 'removed');
    const removed = await f.request(`/api/invitations/${id}/accept`, 'POST', 'recipient', {});
    assert.equal(removed.status, 403);
    assert.equal((await removed.json() as { error: { code: string } }).error.code, 'MEMBERSHIP_REMOVED');
    assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM member WHERE user_id='recipient'").get()!.count, 0);
  } finally { f.close(); }
});

test('expired and revoked invitations do not create members or allow resend', async () => {
  const f = await fixture();
  try {
    const id = await f.invite();
    f.sqlite.prepare('UPDATE invitation SET expires_at=? WHERE id=?').run(Date.now(), id);
    assert.equal((await f.request(`/api/invitations/${id}/accept`, 'POST', 'recipient', {})).status, 410);
    assert.equal((await f.request(`/api/companies/company/invitations/${id}/resend`, 'POST', 'owner', {})).status, 410);
    const replacement = await f.invite();
    assert.notEqual(replacement, id);
    assert.equal((await f.request(`/api/companies/company/invitations/${replacement}/revoke`, 'POST', 'owner', {})).status, 200);
    assert.equal((await f.request(`/api/companies/company/invitations/${replacement}/revoke`, 'POST', 'owner', {})).status, 200);
    assert.equal((await f.request(`/api/invitations/${replacement}/accept`, 'POST', 'recipient', {})).status, 410);
    assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM member WHERE user_id='recipient'").get()!.count, 0);
  } finally { f.close(); }
});

test('invitation-bound registration creates only its unverified recipient and never grants membership', async () => {
  const f = await fixture();
  try {
    const id = await f.invite('new@example.invalid');
    const body = { email: 'new@example.invalid', name: 'New recipient', password: 'synthetic-registration-password' };
    assert.equal((await f.request(`/api/invitations/${id}/register`, 'POST', '', { ...body, email: 'other@example.invalid' })).status, 404);
    const response = await f.request(`/api/invitations/${id}/register`, 'POST', '', body);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { status: string }).status, 'verification_required');
    const user = f.sqlite.prepare("SELECT id,email_verified FROM user WHERE email='new@example.invalid'").get()!;
    assert.equal(user.email_verified, 0);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM member WHERE user_id=?').get(user.id)!.count, 0);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal(f.mails.length, 2);
  } finally { f.close(); }
});

test('a native accepted-before-member interruption recovers through the public addMember API', async () => {
  const f = await fixture();
  try {
    const id = await f.invite();
    f.sqlite.prepare("INSERT INTO invitation_flow (invitation_id,organization_id,member_id,accepting_user_id,created_at) VALUES (?,'company','recovery-member','recipient',1)").run(id);
    f.sqlite.prepare("UPDATE invitation SET status='accepted' WHERE id=?").run(id);
    const detail = await f.request(`/api/invitations/${id}`, 'GET', 'recipient');
    assert.equal((await detail.json() as { canAccept: boolean }).canAccept, true, 'the UI must allow resuming the incomplete grant');
    const result = await f.request(`/api/invitations/${id}/accept`, 'POST', 'recipient', {});
    assert.equal(result.status, 200);
    assert.equal(f.sqlite.prepare("SELECT id FROM member WHERE user_id='recipient'").get()!.id, 'recovery-member');
    assert.notEqual(f.sqlite.prepare('SELECT completed_at FROM invitation_flow WHERE invitation_id=?').get(id)!.completed_at, null);
  } finally { f.close(); }
});

test('failure after the member write does not reopen the invitation or duplicate the grant', async () => {
  const f = await fixture();
  try {
    const id = await f.invite();
    f.sqlite.exec("CREATE TRIGGER fixture_session_write_failure BEFORE UPDATE OF active_organization_id ON session BEGIN SELECT RAISE(FAIL, 'synthetic session interruption'); END;");
    assert.equal((await f.request(`/api/invitations/${id}/accept`, 'POST', 'recipient', {})).status, 200);
    assert.equal(f.sqlite.prepare('SELECT status FROM invitation WHERE id=?').get(id)!.status, 'accepted');
    assert.equal((await f.request(`/api/invitations/${id}/accept`, 'POST', 'recipient', {})).status, 200);
    assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM member WHERE user_id='recipient'").get()!.count, 1);
  } finally { f.close(); }
});

test('mail failure keeps one recoverable invitation and resend preserves its role', async () => {
  const f = await fixture();
  try {
    f.setMailFailure(true);
    const response = await f.request('/api/companies/company/invitations', 'POST', 'owner', { email: 'recipient@example.invalid', role: 'member' });
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'OPERATION_UNCONFIRMED');
    const rows = f.sqlite.prepare('SELECT id FROM invitation').all();
    assert.equal(rows.length, 1);
    f.setMailFailure(false);
    const resent = await f.request(`/api/companies/company/invitations/${rows[0]!.id}/resend`, 'POST', 'owner', {});
    assert.equal(resent.status, 200);
    assert.equal((await resent.json() as { mail: { status: string } }).mail.status, 'accepted');
    assert.equal(f.sqlite.prepare('SELECT role FROM invitation').get()!.role, 'member');
    assert.equal(f.mails.length, 1);
  } finally { f.close(); }
});

test('concurrent creation leaves one pending invitation and one accepted email delivery', async () => {
  const f = await fixture();
  try {
    const responses = await Promise.all([0, 1].map(() => f.request('/api/companies/company/invitations', 'POST', 'owner', { email: 'recipient@example.invalid', role: 'member' })));
    assert.equal(responses.filter(response => response.status === 200).length, 1);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM invitation').get()!.count, 1);
    assert.equal(f.mails.length, 1);
  } finally { f.close(); }
});

test('registration resumes after email failure without changing the original password and identifies incomplete credentials', async () => {
  const f = await fixture();
  try {
    const id = await f.invite('new@example.invalid');
    const body = { email: 'new@example.invalid', name: 'New', password: 'synthetic-registration-password' };
    f.setMailFailure(true);
    assert.equal((await f.request(`/api/invitations/${id}/register`, 'POST', '', body)).status, 503);
    const user = f.sqlite.prepare("SELECT id FROM user WHERE email='new@example.invalid'").get()!;
    const original = f.sqlite.prepare("SELECT password FROM account WHERE user_id=?").get(user.id)!.password;
    f.setMailFailure(false);
    assert.equal((await f.request(`/api/invitations/${id}/register`, 'POST', '', { ...body, password: 'do-not-overwrite-original-password' })).status, 200);
    assert.equal(f.sqlite.prepare('SELECT password FROM account WHERE user_id=?').get(user.id)!.password, original);
    f.sqlite.prepare('UPDATE account SET password=NULL WHERE user_id=?').run(user.id);
    const response = await f.request(`/api/invitations/${id}/register`, 'POST', '', body);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { status: string }).status, 'password_recovery_required');
    assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM member WHERE user_id=?').get(user.id)!.count, 0);
  } finally { f.close(); }
});

test('invitation lists validate offsets and expose the next page instead of silently truncating', async () => {
  const f = await fixture();
  try {
    for (const offset of ['-1', '1.5', 'Infinity', '0x10', '10001']) assert.equal((await f.request(`/api/companies/company/invitations?offset=${offset}`)).status, 400);
    for (let index = 0; index < 101; index++) f.sqlite.prepare("INSERT INTO invitation (id,organization_id,email,role,status,expires_at,created_at,inviter_id) VALUES (?,'company',?,'member','canceled',4102444800000,?,'owner')").run(`history-${index}`, `history-${index}@example.invalid`, index);
    const first = await (await f.request('/api/companies/company/invitations')).json() as { invitations: unknown[]; nextOffset: number; hasMore: boolean };
    assert.equal(first.invitations.length, 100);
    assert.equal(first.nextOffset, 100);
    assert.equal(first.hasMore, true);
    const second = await (await f.request('/api/companies/company/invitations?offset=100')).json() as { invitations: unknown[]; nextOffset: number | null; hasMore: boolean };
    assert.equal(second.invitations.length, 1);
    assert.equal(second.nextOffset, null);
    assert.equal(second.hasMore, false);
  } finally { f.close(); }
});
