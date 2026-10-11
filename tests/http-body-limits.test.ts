import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { URL } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { createApp } from '../src/application.ts';

type Transport = 'content-length' | 'chunked-stream';
const encoder = new TextEncoder();
const password = 'synthetic-边界-ключ-password-1';
const email = 'body-limit@example.invalid';
const login = { email, password, rememberMe: true };
const claim = { claimId: 'e3bd054d-4769-4b0a-bf2c-477fa0a4ad9a', email, name: '安装者', organizationName: '边界公司' };

async function fixture(withUser = false) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter(file => file.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  const DB = {
    prepare(query: string) {
      let values: SQLInputValue[] = [];
      const execute = (arrays = false) => {
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
  if (withUser) {
    const hashed = await hashPassword(password);
    sqlite.prepare('INSERT INTO user (id,name,email,email_verified) VALUES (?,?,?,1)').run('body-user', 'Body limit user', email);
    sqlite.prepare("INSERT INTO account (id,account_id,provider_id,user_id,password,updated_at) VALUES ('body-account','body-user','credential','body-user',?,1)").run(hashed);
  }
  const env = { DB, APP_BASE_URL: 'https://body-limits.example.invalid',
    BETTER_AUTH_SECRET: 'synthetic-body-limits-auth-secret-at-least-thirty-two',
    BOOTSTRAP_SECRET: 'synthetic-body-limits-install-secret-at-least-thirty-two' };
  const app = createApp({ mailer: async () => ({ id: 'synthetic-mail-not-sent' }) });
  function post(path: string, body: string, transport: Transport) {
    const bytes = encoder.encode(body);
    const headers = new Headers({ 'content-type': 'application/json', origin: env.APP_BASE_URL,
      authorization: `Bearer ${env.BOOTSTRAP_SECRET}`, 'x-request-id': 'untrusted-client-id' });
    if (transport === 'content-length') headers.set('content-length', String(bytes.byteLength));
    // Split the first multibyte character and the final byte into separate chunks.
    // On max+1 requests the final chunk is the byte that must cross the limit.
    const multibyte = bytes.findIndex(byte => byte >= 128);
    const first = multibyte < 0 ? 1 : multibyte + 1;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.slice(0, first));
      controller.enqueue(bytes.slice(first, -1));
      controller.enqueue(bytes.slice(-1));
      controller.close();
    } });
    const init = { method: 'POST', headers, body: transport === 'content-length' ? body : stream, duplex: 'half' };
    const request = new Request(`${env.APP_BASE_URL}${path}`, init);
    assert.equal(request.headers.has('content-length'), transport === 'content-length');
    return app.request(request, undefined, env);
  }
  return { sqlite, env, app, post, close: () => sqlite.close() };
}

function paddedJSON(value: unknown, bytes: number) {
  const json = JSON.stringify(value);
  const body = json + ' '.repeat(bytes - encoder.encode(json).byteLength);
  assert.equal(encoder.encode(body).byteLength, bytes);
  return body;
}

function responseHeaders(response: Response) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const requestId = response.headers.get('x-request-id');
  assert.match(requestId ?? '', /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
  assert.notEqual(requestId, 'untrusted-client-id');
  return requestId;
}

async function errorResponse(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  const requestId = responseHeaders(response);
  const body = await response.json() as { error: { code: string }; requestId: string };
  assert.equal(body.error.code, code);
  assert.equal(body.requestId, requestId);
}

for (const transport of ['content-length', 'chunked-stream'] as const) {
  test(`ordinary writes accept exactly 16 KiB and preserve the cloned body for Better Auth (${transport})`, async () => {
    const f = await fixture(true);
    try {
      const response = await f.post('/api/auth/sign-in/email', paddedJSON(login, 16 * 1024), transport);
      assert.equal(response.status, 200);
      responseHeaders(response);
      const value = await response.json() as { user: { id: string; email: string } };
      assert.equal(value.user.id, 'body-user');
      assert.equal(value.user.email, email);
      assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM session').get()?.total, 1);
      assert.equal(f.sqlite.prepare("SELECT count(*) AS total FROM identity_audit_event WHERE action='auth.sign_in' AND outcome='succeeded'").get()?.total, 1);
      const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
      assert.ok(cookie, 'the actual Better Auth login returns a usable session');
      const session = await f.app.request(`${f.env.APP_BASE_URL}/api/auth/get-session`, { headers: { cookie } }, f.env);
      assert.equal(session.status, 200);
      assert.equal((await session.json() as { user: { id: string } }).user.id, 'body-user');
    } finally { f.close(); }
  });

  test(`ordinary writes reject the byte after 16 KiB before authentication writes (${transport})`, async () => {
    const f = await fixture(true);
    try {
      await errorResponse(await f.post('/api/auth/sign-in/email', paddedJSON(login, 16 * 1024 + 1), transport), 413, 'REQUEST_TOO_LARGE');
      assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM session').get()?.total, 0);
      assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM identity_audit_event').get()?.total, 0);
    } finally { f.close(); }
  });

  test(`installation accepts exactly 4 KiB and persists its full JSON claim (${transport})`, async () => {
    const f = await fixture();
    try {
      const response = await f.post('/api/bootstrap/claim', paddedJSON(claim, 4096), transport);
      assert.equal(response.status, 201);
      responseHeaders(response);
      const persisted = f.sqlite.prepare('SELECT claim_id,email,name,organization_name FROM bootstrap_installation').get();
      assert.deepEqual({ ...persisted }, { claim_id: claim.claimId, email, name: claim.name, organization_name: claim.organizationName });
    } finally { f.close(); }
  });

  test(`installation rejects the byte after 4 KiB without reserving a claim (${transport})`, async () => {
    const f = await fixture();
    try {
      await errorResponse(await f.post('/api/bootstrap/claim', paddedJSON(claim, 4097), transport), 413, 'REQUEST_TOO_LARGE');
      assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM bootstrap_installation').get()?.total, 0);
      assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM identity_audit_event').get()?.total, 0);
    } finally { f.close(); }
  });

  for (const path of ['/api/auth/sign-in/email', '/api/bootstrap/claim']) {
    test(`invalid JSON within the limit stays a 400 without writes (${transport}, ${path})`, async () => {
      const f = await fixture();
      try {
        await errorResponse(await f.post(path, '{"email":"incomplete', transport), 400, 'INVALID_REQUEST');
        assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM session').get()?.total, 0);
        assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM bootstrap_installation').get()?.total, 0);
        assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM identity_audit_event').get()?.total, 0);
      } finally { f.close(); }
    });
  }
}
