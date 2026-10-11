import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Hono } from 'hono';
import { hashPassword } from 'better-auth/crypto';
import { apiError, type ApplicationEnv } from '../src/http.ts';
import { AuditUnavailable, OperationUnconfirmed } from '../src/modules/audit/operation.ts';
import { services } from '../src/modules/identity/services.ts';
import { registerMembershipRoutes } from '../src/modules/membership/http.ts';

async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const folder = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(folder).filter(file => file.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, folder), 'utf8'));
  function prepare(sql: string, parameters: SQLInputValue[] = []) {
    return {
      bind: (...values: SQLInputValue[]) => prepare(sql, values),
      async all() { return { success: true, results: sqlite.prepare(sql).all(...parameters), meta: {} }; },
      async raw() { const statement = sqlite.prepare(sql); statement.setReturnArrays(true); return statement.all(...parameters); },
      async first(column?: string) { const row = sqlite.prepare(sql).get(...parameters); return row ? column ? row[column] : row : null; },
      async run() { const result = sqlite.prepare(sql).run(...parameters); return { success: true, results: [], meta: { changes: Number(result.changes) } }; },
    };
  }
  const password = 'synthetic-membership-confirmation-password';
  const hash = await hashPassword(password);
  for (const id of ['owner', 'second-owner', 'admin', 'staff', 'other']) {
    sqlite.prepare('INSERT INTO user (id,name,email,email_verified) VALUES (?,?,?,1)').run(id, id, `${id}@example.invalid`);
    sqlite.prepare("INSERT INTO account (id,account_id,provider_id,user_id,password,updated_at) VALUES (?,?,'credential',?,?,1)").run(`account-${id}`, id, id, hash);
  }
  sqlite.exec("INSERT INTO organization (id,name,slug,created_at) VALUES ('company','Company','company',1),('other-company','Other','other',1)");
  for (const [id, company, role] of [['owner', 'company', 'owner'], ['second-owner', 'company', 'owner'], ['admin', 'company', 'admin'], ['staff', 'company', 'member'], ['other', 'other-company', 'owner']]) {
    sqlite.prepare('INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES (?,?,?,?,1)').run(`${id}-member`, company, id, role);
  }
  const env = { DB: { prepare } as unknown as D1Database, APP_BASE_URL: 'https://membership.example.invalid', BETTER_AUTH_SECRET: 'synthetic-membership-secret-at-least-thirty-two' };
  const app = new Hono<ApplicationEnv>();
  app.use('*', async (c, next) => { c.set('requestId', crypto.randomUUID()); await next(); });
  app.onError((error, c) => apiError(c, error instanceof AuditUnavailable ? 'AUDIT_UNAVAILABLE' : error instanceof OperationUnconfirmed ? 'OPERATION_UNCONFIRMED' : 'UNEXPECTED_TEST_ERROR', 'Operation unavailable.', 503));
  registerMembershipRoutes(app);
  const cookies: Record<string, string> = {};
  for (const id of ['owner', 'second-owner', 'admin', 'staff', 'other']) {
    const response = await services(env)!.auth.api.signInEmail({ body: { email: `${id}@example.invalid`, password }, asResponse: true });
    assert.equal(response.status, 200);
    cookies[id] = response.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).join('; ');
  }
  const request = (target: string, action: 'role' | 'remove', body: unknown, actor = 'owner', company = 'company', origin = env.APP_BASE_URL) => app.request(`${env.APP_BASE_URL}/api/companies/${company}/members/${target}-member/${action}`, {
    method: 'POST', headers: { cookie: cookies[actor] ?? '', origin, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.30' }, body: JSON.stringify(body),
  }, env);
  return { sqlite, env, request, password, close: () => sqlite.close() };
}

test('member role changes are authenticated and restricted to the selected company and exact role contract', async () => {
  const f = await fixture();
  try {
    const body = { expectedRole: 'member', role: 'admin' };
    assert.equal((await f.request('staff', 'role', body, '')).status, 401);
    assert.equal((await f.request('staff', 'role', body, 'staff')).status, 403);
    assert.equal((await f.request('staff', 'role', body, 'other')).status, 404);
    assert.equal((await f.request('other', 'role', { expectedRole: 'owner', role: 'member', password: f.password })).status, 404);
    assert.equal((await f.request('staff', 'role', { ...body, role: ['admin'] })).status, 400);
    assert.equal((await f.request('staff', 'role', { ...body, role: 'owner,admin' })).status, 400);
    assert.equal((await f.request('staff', 'role', { ...body, ignored: true })).status, 400);
    assert.equal((await f.request('staff', 'role', body, 'owner', 'company', 'https://foreign.example.invalid')).status, 403);
    const changed = await f.request('staff', 'role', body);
    assert.equal(changed.status, 200);
    assert.deepEqual(await changed.json(), { memberId: 'staff-member', role: 'admin' });
    assert.equal(f.sqlite.prepare("SELECT role FROM member WHERE id='staff-member'").get()?.role, 'admin');
  } finally { f.close(); }
});

test('administrators may manage non-owners but cannot grant or alter owner membership', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('staff', 'role', { expectedRole: 'member', role: 'owner', password: f.password }, 'admin')).status, 403);
    assert.equal((await f.request('second-owner', 'role', { expectedRole: 'owner', role: 'member', password: f.password }, 'admin')).status, 403);
    assert.equal((await f.request('second-owner', 'remove', { expectedRole: 'owner', password: f.password }, 'admin')).status, 403);
    assert.equal((await f.request('staff', 'role', { expectedRole: 'member', role: 'admin' }, 'admin')).status, 200);
    const removed = await f.request('staff', 'remove', { expectedRole: 'admin' }, 'admin');
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { memberId: 'staff-member', role: null });
    assert.equal((await f.request('admin', 'role', { expectedRole: 'admin', role: 'member' }, 'admin')).status, 200);
    assert.equal((await f.request('owner', 'remove', { expectedRole: 'owner' }, 'admin')).status, 403);
  } finally { f.close(); }
});

test('owner changes require the current password in the same request and record the affected role', async () => {
  const f = await fixture();
  try {
    const body = { expectedRole: 'member', role: 'owner' };
    const missing = await f.request('staff', 'role', body);
    assert.equal(missing.status, 403);
    assert.equal((await missing.json() as { error: { code: string } }).error.code, 'PASSWORD_CONFIRMATION_REQUIRED');
    const wrong = await f.request('staff', 'role', { ...body, password: 'synthetic-incorrect-password' });
    assert.equal(wrong.status, 403);
    assert.equal((await wrong.json() as { error: { code: string } }).error.code, 'INVALID_PASSWORD');
    const response = await f.request('staff', 'role', { ...body, password: f.password });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { memberId: 'staff-member', role: 'owner' });
    const audits = f.sqlite.prepare('SELECT action,outcome,actor_user_id,target_member_id,before_role,after_role FROM identity_audit_event WHERE request_id=? ORDER BY rowid').all(response.headers.get('x-request-id'));
    assert.deepEqual(audits.map(row => ({ ...row })), ['started', 'succeeded'].map(outcome => ({
      action: 'member.role.update', outcome, actor_user_id: 'owner', target_member_id: 'staff-member', before_role: 'member', after_role: 'owner',
    })));
    assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM identity_audit_event').all()).includes(f.password), false);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM rate_limit').get()?.total, 1, 'password confirmation traverses the SDK database limiter');
  } finally { f.close(); }
});

test('repeated incorrect password confirmations use the native persistent rate limit', async () => {
  const f = await fixture();
  try {
    const body = { expectedRole: 'owner', role: 'admin', password: 'synthetic-incorrect-password' };
    for (let index = 0; index < 5; index++) assert.equal((await f.request('second-owner', 'role', body)).status, 403);
    const response = await f.request('second-owner', 'role', { ...body, password: f.password });
    assert.equal(response.status, 429);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'RATE_LIMITED');
    assert.equal(f.sqlite.prepare("SELECT role FROM member WHERE id='second-owner-member'").get()?.role, 'owner');
  } finally { f.close(); }
});

test('the last owner cannot be demoted or removed, while stale expected roles return a conflict', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('staff', 'remove', { expectedRole: 'admin' })).status, 409);
    assert.equal((await f.request('second-owner', 'remove', { expectedRole: 'owner', password: f.password })).status, 200);
    for (const [action, body] of [['role', { expectedRole: 'owner', role: 'admin', password: f.password }], ['remove', { expectedRole: 'owner', password: f.password }]] as const) {
      const response = await f.request('owner', action, body);
      assert.equal(response.status, 409);
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'LAST_OWNER_REQUIRED');
    }
    assert.equal(f.sqlite.prepare("SELECT count(*) AS total FROM member WHERE organization_id='company' AND role='owner'").get()?.total, 1);
  } finally { f.close(); }
});

test('a missing audit intent prevents change and a missing result audit reports uncertainty', async () => {
  const f = await fixture();
  try {
    const body = { expectedRole: 'member', role: 'admin' };
    f.sqlite.exec("CREATE TRIGGER synthetic_audit_intent_failure BEFORE INSERT ON identity_audit_event WHEN NEW.outcome='started' BEGIN SELECT RAISE(ABORT,'Synthetic audit failure'); END");
    assert.equal((await f.request('staff', 'role', body)).status, 503);
    assert.equal(f.sqlite.prepare("SELECT role FROM member WHERE id='staff-member'").get()?.role, 'member');
    f.sqlite.exec('DROP TRIGGER synthetic_audit_intent_failure');
    f.sqlite.exec("CREATE TRIGGER synthetic_audit_result_failure BEFORE INSERT ON identity_audit_event WHEN NEW.outcome='succeeded' BEGIN SELECT RAISE(ABORT,'Synthetic audit failure'); END");
    const changed = await f.request('staff', 'role', body);
    assert.equal(changed.status, 503);
    assert.equal((await changed.json() as { error: { code: string } }).error.code, 'OPERATION_UNCONFIRMED');
    assert.equal(f.sqlite.prepare("SELECT role FROM member WHERE id='staff-member'").get()?.role, 'admin');
    assert.equal(f.sqlite.prepare("SELECT count(*) AS total FROM identity_audit_event WHERE outcome='started'").get()?.total, 1);
  } finally { f.close(); }
});
