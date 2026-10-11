import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { URL } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { createApp } from '../src/application.ts';
import { services } from '../src/modules/identity/services.ts';

const readResponses: Record<string, unknown> = {
  '/v1/roles': { roles: [] }, '/v3/product/list': { result: { items: [] } },
  '/v3/chat/list': { chats: [] }, '/v4/posting/fbs/list': { postings: [] },
};
const syntheticKey = 'synthetic-private-ozon-api-key';
const newStore = (id = crypto.randomUUID(), clientId = '123456') => ({ id, name: 'Synthetic shop', clientId, apiKey: syntheticKey });

async function fixture(fetcher?: typeof fetch) {
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
  const password = 'synthetic-stores-user-password';
  const hash = await hashPassword(password);
  sqlite.exec("INSERT INTO organization (id,name,slug,created_at) VALUES ('company','Company','company',1),('other-company','Other','other',1)");
  for (const [id, company, role] of [['owner', 'company', 'owner'], ['admin', 'company', 'admin'], ['staff', 'company', 'member'], ['other', 'other-company', 'owner']]) {
    sqlite.prepare('INSERT INTO user (id,name,email,email_verified) VALUES (?,?,?,1)').run(id, id, `${id}@example.invalid`);
    sqlite.prepare("INSERT INTO account (id,account_id,provider_id,user_id,password,updated_at) VALUES (?,?,'credential',?,?,1)").run(`account-${id}`, id, id, hash);
    sqlite.prepare('INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES (?,?,?,?,1)').run(`${id}-member`, company, id, role);
  }
  const env = {
    DB: { prepare } as unknown as D1Database, APP_BASE_URL: 'https://stores.example.invalid', BETTER_AUTH_SECRET: 'synthetic-stores-secret-at-least-thirty-two',
    STORE_CREDENTIAL_KEYS: JSON.stringify({ test: btoa('s'.repeat(32)) }), STORE_CREDENTIAL_ACTIVE_KEY: 'test',
  };
  const calls: string[] = [];
  const app = createApp({ storeFetch: fetcher ?? (async input => {
    const url = new URL(String(input)); calls.push(url.pathname);
    assert.equal(url.origin, 'https://api-seller.ozon.ru');
    return Response.json(readResponses[url.pathname]);
  }) as typeof fetch });
  const cookies: Record<string, string> = {};
  for (const id of ['owner', 'admin', 'staff', 'other']) {
    const response = await services(env)!.auth.api.signInEmail({ body: { email: `${id}@example.invalid`, password }, asResponse: true });
    assert.equal(response.status, 200);
    cookies[id] = response.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).join('; ');
  }
  const request = (path = '', body?: unknown, actor = 'owner', company = 'company', origin = env.APP_BASE_URL) => app.request(`${env.APP_BASE_URL}/api/companies/${company}/stores${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { cookie: cookies[actor] ?? '', origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  const create = async (input = newStore()) => { const response = await request('', input); assert.equal(response.status, 200); return input.id; };
  return { sqlite, env, request, create, calls, close: () => sqlite.close() };
}

test('store pagination ignores URL fragments while preserving actual query values', async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    // Node Request preserves fragments; Workers normalizes them before the application.
    for (const suffix of ['#?offset=100', '?offset=0#?offset=100']) {
      const response = await f.request(suffix);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json() as { stores: { id: string }[] }).stores.map(store => store.id), [id]);
    }
    assert.deepEqual((await (await f.request('?offset=100')).json() as { stores: unknown[] }).stores, []);
    assert.equal((await f.request('?offset=0%23ignored')).status, 400);
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('creating a store encrypts credentials without contacting Ozon; replays and account duplicates cannot rotate them', async () => {
  const f = await fixture();
  try {
    const input = newStore(); const id = await f.create(input);
    assert.deepEqual(f.calls, []);
    const response = await f.request(`/${id}`); const result = await response.json() as { store: Record<string, unknown> };
    assert.equal(result.store.status, 'unverified'); assert.equal(result.store.revision, 1);
    assert.equal(result.store.hasCredentials, true); assert.equal(result.store.credentialVersion, 1);
    assert.equal(JSON.stringify(result).includes(syntheticKey), false);
    assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM store').all()).includes(syntheticKey), false);
    assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM store_audit_event').all()).includes(syntheticKey), false);
    for (const forbidden of ['credentialKeyVersion', 'credentialNonce', 'credentialCiphertext', 'apiKey', 'checkToken']) assert.equal(forbidden in result.store, false);
    assert.equal((await f.request('', { ...input, apiKey: 'replacement-key' })).status, 409);
    assert.equal((await f.request('', newStore())).status, 409);
    assert.equal(f.sqlite.prepare('SELECT credential_version FROM store').get()?.credential_version, 1);
  } finally { f.close(); }
});

test('store access is tenant scoped, explicit for staff, and revoked by removing the membership', async () => {
  const f = await fixture();
  try {
    const id = await f.create(); const path = `/${id}/grants/staff-member`;
    assert.equal((await f.request('', undefined, '')).status, 401);
    assert.equal((await f.request('', newStore(), 'staff')).status, 403);
    assert.equal((await f.request(`/${id}`, undefined, 'other')).status, 404);
    assert.equal((await f.request(`/${id}`, undefined, 'staff')).status, 404);
    assert.deepEqual((await (await f.request('', undefined, 'staff')).json() as { stores: unknown[] }).stores, []);
    assert.equal((await f.request(path, { expectedGranted: false, granted: true })).status, 200);
    assert.equal((await f.request(`/${id}`, undefined, 'staff')).status, 200);
    assert.equal((await f.request(`/${id}/credentials`, { expectedRevision: 1, apiKey: 'new-key' }, 'staff')).status, 403);
    assert.equal((await f.request(`/${id}/check`, { expectedRevision: 1 }, 'staff')).status, 403);
    assert.equal((await f.request(`/${id}/grants`, undefined, 'staff')).status, 403);
    assert.equal((await f.request(path, { expectedGranted: false, granted: true })).status, 409);
    assert.equal((await f.request(`/${id}/grants/other-member`, { expectedGranted: false, granted: true })).status, 404);
    assert.equal((await f.request(`/${id}/grants/admin-member`, { expectedGranted: false, granted: true })).status, 403);
    const grants = await (await f.request(`/${id}/grants`)).json() as { members: { memberId: string; granted: boolean }[] };
    assert.equal(grants.members.find(member => member.memberId === 'staff-member')?.granted, true);
    assert.equal((await f.request(path, { expectedGranted: true, granted: false }, 'admin')).status, 200);
    assert.equal((await f.request(`/${id}`, undefined, 'staff')).status, 404);
    assert.equal((await f.request(path, { expectedGranted: false, granted: true })).status, 200);
    f.sqlite.exec("DELETE FROM member WHERE id='staff-member'; INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('staff-reinvited','company','staff','member',1)");
    assert.equal((await f.request(`/${id}`, undefined, 'staff')).status, 404);
    assert.equal(f.sqlite.prepare('SELECT revision FROM store').get()?.revision, 1, 'grant CAS is independent of store revision');
  } finally { f.close(); }
});

test('read checks produce limited evidence, obey a cooldown and expire without enabling message sends', async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    const response = await f.request(`/${id}/check`, { expectedRevision: 1 }); assert.equal(response.status, 200);
    const { store } = await response.json() as { store: { revision: number; capabilities: { code: string; status: string }[] } };
    assert.equal(store.revision, 2); assert.equal(f.calls.length, 4);
    assert.equal(store.capabilities.find(item => item.code === 'reply')?.status, 'unknown');
    assert.equal((await f.request(`/${id}/check`, { expectedRevision: 2 })).status, 429);
    f.sqlite.prepare('UPDATE store SET expires_at=1 WHERE id=?').run(id);
    const expired = await (await f.request(`/${id}`)).json() as { store: { capabilities: { status: string; reason: string }[] } };
    assert.ok(expired.store.capabilities.every(item => item.status === 'unknown' && item.reason === 'expired'));
  } finally { f.close(); }
});

test('rotating, pausing, resuming and disconnecting use revision checks and clear stale evidence', async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    assert.equal((await f.request(`/${id}/credentials`, { expectedRevision: 1, apiKey: 'replacement-key' })).status, 200);
    assert.equal((await f.request(`/${id}/credentials`, { expectedRevision: 1, apiKey: 'stale-key' })).status, 409);
    assert.equal((await f.request(`/${id}/state`, { expectedRevision: 2, state: 'paused' })).status, 200);
    assert.equal((await f.request(`/${id}/check`, { expectedRevision: 3 })).status, 409);
    assert.equal((await f.request(`/${id}/state`, { expectedRevision: 3, state: 'unverified' })).status, 200);
    assert.equal((await f.request(`/${id}/state`, { expectedRevision: 4, state: 'disconnected' })).status, 200);
    const { store } = await (await f.request(`/${id}`)).json() as { store: { hasCredentials: boolean; credentialVersion: number } };
    assert.equal(store.hasCredentials, false); assert.ok(store.credentialVersion >= 2);
    assert.equal((await f.request(`/${id}/state`, { expectedRevision: 5, state: 'unverified' })).status, 409);
    assert.equal(f.sqlite.prepare('SELECT credential_ciphertext FROM store').get()?.credential_ciphertext, null);
    assert.deepEqual(f.sqlite.prepare("SELECT action FROM store_audit_event WHERE outcome='succeeded' ORDER BY rowid").all().map(row => row.action), ['store.create', 'store.credentials.rotate', 'store.pause', 'store.resume', 'store.disconnect']);
  } finally { f.close(); }
});

test('a check finishing after rotation or manager revocation cannot commit its obsolete result', async () => {
  for (const mutation of ['rotate', 'revoke'] as const) {
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const f = await fixture((async input => { entered(); await waiting; return Response.json(readResponses[new URL(String(input)).pathname]); }) as typeof fetch);
    try {
      const id = await f.create();
      const checking = f.request(`/${id}/check`, { expectedRevision: 1 }, 'admin');
      await started;
      assert.equal((await f.request(`/${id}/check`, { expectedRevision: 1 })).status, 409);
      if (mutation === 'rotate') assert.equal((await f.request(`/${id}/credentials`, { expectedRevision: 1, apiKey: 'rotated-key' })).status, 200);
      else f.sqlite.exec("UPDATE member SET role='member' WHERE id='admin-member'");
      release(); const result = await checking;
      assert.equal(result.status, 409);
      assert.equal(f.sqlite.prepare('SELECT capabilities FROM store').get()?.capabilities, null);
    } finally { release(); f.close(); }
  }
});

test('missing encryption configuration leaves metadata readable but refuses credentials and checks', async () => {
  const f = await fixture();
  try {
    const id = await f.create(); f.env.STORE_CREDENTIAL_KEYS = '';
    const listed = await f.request(''); assert.equal(listed.status, 200);
    assert.equal((await listed.json() as { configured: boolean }).configured, false);
    assert.equal((await f.request('', newStore(crypto.randomUUID(), '987654'))).status, 503);
    assert.equal((await f.request(`/${id}/credentials`, { expectedRevision: 1, apiKey: 'new-key' })).status, 503);
    const missing = await f.request(`/${id}/check`, { expectedRevision: 1 });
    assert.equal(missing.status, 503);
    assert.equal((await missing.json() as { error: { code: string } }).error.code, 'CREDENTIALS_NOT_CONFIGURED');
    f.env.STORE_CREDENTIAL_KEYS = JSON.stringify({ replacement: btoa('r'.repeat(32)) });
    f.env.STORE_CREDENTIAL_ACTIVE_KEY = 'replacement';
    const unavailable = await f.request(`/${id}/check`, { expectedRevision: 1 });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json() as { error: { code: string } }).error.code, 'CREDENTIALS_UNAVAILABLE');
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('a confirmed write followed by access revocation reports uncertainty and never records a rejected mutation', async () => {
  const f = await fixture();
  try {
    const id = await f.create();
    f.sqlite.exec("CREATE TRIGGER synthetic_post_write_revocation AFTER UPDATE OF credential_ciphertext ON store BEGIN UPDATE member SET role='member' WHERE id='admin-member'; END");
    const response = await f.request(`/${id}/credentials`, { expectedRevision: 1, apiKey: 'replacement-key' }, 'admin');
    assert.equal(f.sqlite.prepare('SELECT credential_version FROM store').get()?.credential_version, 2);
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'OPERATION_UNCONFIRMED');
    assert.deepEqual(f.sqlite.prepare("SELECT outcome FROM store_audit_event WHERE action='store.credentials.rotate' ORDER BY rowid").all().map(row => row.outcome), ['started', 'unknown']);
  } finally { f.close(); }
});

test('grant and revoke audit events identify which permission operation actually succeeded', async () => {
  const f = await fixture();
  try {
    const id = await f.create(); const path = `/${id}/grants/staff-member`;
    assert.equal((await f.request(path, { expectedGranted: false, granted: true })).status, 200);
    assert.equal((await f.request(path, { expectedGranted: true, granted: false })).status, 200);
    assert.deepEqual(f.sqlite.prepare("SELECT action FROM store_audit_event WHERE target_member_id='staff-member' AND outcome='succeeded' ORDER BY rowid").all().map(row => row.action), ['store.grant.add', 'store.grant.revoke']);
  } finally { f.close(); }
});

test('request validation and audit failures cannot silently perform or misreport a store change', async () => {
  const f = await fixture();
  try {
    for (const extra of [{ clientId: 'https://example.invalid' }, { id: '../store' }, { apiKey: 'has whitespace' }, { apiKey: '' }, { name: '' }, { platform: 'different' }]) assert.equal((await f.request('', { ...newStore(), ...extra })).status, 400);
    assert.equal((await f.request('', newStore(), 'owner', 'company', 'https://foreign.example.invalid')).status, 403);
    assert.equal((await f.request('?offset=-1')).status, 400);
    f.sqlite.exec("CREATE TRIGGER synthetic_store_audit_failure BEFORE INSERT ON store_audit_event WHEN NEW.outcome='started' BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END");
    assert.equal((await f.request('', newStore())).status, 503);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM store').get()?.total, 0);
    f.sqlite.exec('DROP TRIGGER synthetic_store_audit_failure');
    f.sqlite.exec("CREATE TRIGGER synthetic_store_audit_failure BEFORE INSERT ON store_audit_event WHEN NEW.outcome='succeeded' BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END");
    const response = await f.request('', newStore()); assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'OPERATION_UNCONFIRMED');
    assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM store').get()?.total, 1);
  } finally { f.close(); }
});
