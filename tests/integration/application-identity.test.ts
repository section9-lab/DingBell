import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { hashPassword } from 'better-auth/crypto';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = 'tests/fixtures/application-identity';

async function stop(child: ChildProcess) {
  if (child.pid === undefined) return;
  const kill = (signal: NodeJS.Signals) => {
    try { process.kill(-child.pid!, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const exited = child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve();
  kill('SIGTERM');
  const timer = setTimeout(() => kill('SIGKILL'), 5_000);
  try { await exited; } finally { clearTimeout(timer); kill('SIGKILL'); }
}

test('production application identity and company isolation in real Workers/D1', { timeout: 300_000 }, async (context) => {
  const statePath = await mkdtemp(join(tmpdir(), 'dingbell-application-identity-'));
  const children = new Set<ChildProcess>();
  context.after(async () => {
    await Promise.all([...children].map(stop));
    await rm(statePath, { recursive: true, force: true });
  });
  const environment = {
    ...process.env,
    CI: 'true',
    WRANGLER_SEND_METRICS: 'false',
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
  };
  async function finish(child: ChildProcess) {
    await stop(child);
    children.delete(child);
  }
  async function wrangler(args: string[], capture = false) {
    const child = spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args,
      '--config', `${fixture}/wrangler.jsonc`, '--local', '--persist-to', statePath], {
      cwd: root, detached: true, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'], env: environment,
    });
    let output = '';
    child.stdout?.setEncoding('utf8').on('data', value => { output += value; });
    children.add(child);
    const [code] = await once(child, 'exit');
    await finish(child);
    assert.equal(code, 0, 'official Wrangler local D1 operation must succeed');
    return output;
  }
  async function sql(query: string) {
    const path = join(statePath, 'fixture.sql');
    await writeFile(path, query, { mode: 0o600 });
    try { await wrangler(['d1', 'execute', 'DB', '--file', path]); }
    finally { await rm(path, { force: true }); }
  }
  const portServer = createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const address = portServer.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  const baseURL = `http://127.0.0.1:${port}`;
  const secret = crypto.randomUUID() + crypto.randomUUID();
  const password = crypto.randomUUID() + '!Aa1';
  let clientNumber = 1;
  context.beforeEach(() => { clientNumber += 1; });
  async function start(authSecret = secret, appBaseURL = baseURL, noDB = false) {
    const child = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'),
      '--config', `${fixture}/vite.config.ts`, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...environment, DINGBELL_APPLICATION_IDENTITY_STATE_PATH: statePath,
        DINGBELL_APPLICATION_IDENTITY_SECRET: authSecret, DINGBELL_APPLICATION_IDENTITY_BASE_URL: appBaseURL,
        DINGBELL_APPLICATION_IDENTITY_NO_DB: String(noDB) },
    });
    children.add(child);
    // Drain diagnostics without printing passwords, cookies or environment bindings.
    child.stdout!.resume(); child.stderr!.resume();
    let ready = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && child.exitCode === null && !context.signal.aborted) {
      try {
        const response = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(1_000) });
        if (response.status === 200) { ready = true; break; }
      } catch { /* Wait for workerd. */ }
      await delay(200);
    }
    assert.ok(ready, 'local production application Worker must start');
    return child;
  }
  async function request(path: string, method = 'GET', cookie = '', body?: unknown, origin = baseURL) {
    const response = await fetch(`${baseURL}${path}`, {
      method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { 'x-request-id': 'client-supplied-id-must-not-be-trusted',
        'cf-connecting-ip': `192.0.2.${clientNumber}`,
        ...(cookie ? { cookie } : {}), ...(method === 'GET' || !origin ? {} : { origin }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.match(response.headers.get('x-request-id') ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response;
  }
  async function login(email: string) {
    const response = await request('/api/auth/sign-in/email', 'POST', '', { email, password });
    assert.equal(response.status, 200, 'verified fixture identity can sign in');
    const cookies = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
    assert.ok(cookies.includes('session_token='), 'sign-in must return a session cookie');
    assert.ok(response.headers.getSetCookie().some(value => /httponly/i.test(value)), 'session cookie is HTTP-only');
    const result = await response.json() as Record<string, unknown>;
    assert.equal(Object.hasOwn(result, 'token'), false, 'bearer-equivalent session token is never returned in JSON');
    return cookies;
  }

  let child = await start();
  await context.test('public setup reports configured identity without enabling registration or mail', async () => {
    const response = await request('/api/setup');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.get('x-request-id'), 'server generates a request ID');
    const result = await response.json() as { identity: { configured: boolean }; registration: { enabled: boolean }; email: { configured: boolean } };
    assert.equal(result.identity.configured, true);
    assert.equal(result.registration.enabled, false);
    assert.equal(result.email.configured, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  });
  // Do not continue a red contract run into unrelated seed/configuration failures.
  if (!(await request('/api/setup')).ok) return;
  await finish(child);

  await context.test('empty official schema migrates twice', async () => {
    await wrangler(['d1', 'migrations', 'apply', 'DB']);
    await wrangler(['d1', 'migrations', 'apply', 'DB']);
  });
  const hashedPassword = await hashPassword(password);
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const now = Date.now();
  await sql(`
    INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES
      ('user-a', 'Fixture A', 'a@example.invalid', 1, ${now}, ${now}),
      ('user-b', 'Fixture B', 'b@example.invalid', 1, ${now}, ${now}),
      ('user-unverified', 'Unverified', 'unverified@example.invalid', 0, ${now}, ${now});
    INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES
      ('account-a', 'user-a', 'credential', 'user-a', ${quote(hashedPassword)}, ${now}, ${now}),
      ('account-b', 'user-b', 'credential', 'user-b', ${quote(hashedPassword)}, ${now}, ${now}),
      ('account-unverified', 'user-unverified', 'credential', 'user-unverified', ${quote(hashedPassword)}, ${now}, ${now});
    INSERT INTO organization (id, name, slug, created_at) VALUES
      ('company-a', 'Company A', 'company-a', ${now}), ('company-b', 'Company B', 'company-b', ${now});
    INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES
      ('member-a', 'company-a', 'user-a', 'owner', ${now}),
      ('member-a-b', 'company-b', 'user-a', 'member', ${now}),
      ('member-b', 'company-b', 'user-b', 'owner', ${now});
  `);
  child = await start();
  let cookieA = '';
  let cookieB = '';
  let activationRequestId = '';
  await context.test('verified sign-in and uncached session retrieval', async () => {
    cookieA = await login('a@example.invalid');
    cookieB = await login('b@example.invalid');
    const response = await request('/api/auth/get-session', 'GET', cookieA);
    assert.equal(response.status, 200);
    const result = await response.json() as { user: { id: string } };
    assert.equal(result.user.id, 'user-a');
    assert.equal(JSON.stringify(result).includes('"token"'), false, 'session JSON excludes bearer tokens');
    assert.equal(cookieA.includes('session_data='), false, 'cookie session cache must remain disabled');
  });
  await context.test('unverified email is rejected and wrong credentials do not disclose account existence', async () => {
    const unverified = await request('/api/auth/sign-in/email', 'POST', '', { email: 'unverified@example.invalid', password });
    assert.equal(unverified.status, 403);
    assert.equal(unverified.headers.getSetCookie().some(value => value.includes('session_token=')), false);
    const failures = await Promise.all(['a@example.invalid', 'absent@example.invalid'].map(email =>
      request('/api/auth/sign-in/email', 'POST', '', { email, password: 'deliberately-incorrect-password' })));
    assert.equal(failures[0]!.status, 401);
    assert.equal(failures[1]!.status, 401);
    assert.deepEqual((await failures[0]!.json() as { error: unknown }).error, (await failures[1]!.json() as { error: unknown }).error);
  });
  await context.test('native database-backed sign-in rate limiting rejects the fourth attempt', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await request('/api/auth/sign-in/email', 'POST', '', { email: 'absent@example.invalid', password: 'deliberately-incorrect-password' });
      assert.equal(response.status, attempt < 3 ? 401 : 429);
    }
  });
  await context.test('sign-in rejects unapproved callback fields before creating a session', async () => {
    const response = await request('/api/auth/sign-in/email', 'POST', '', {
      email: 'a@example.invalid', password, callbackURL: 'https://untrusted.example',
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.getSetCookie().some(value => value.includes('session_token=')), false);
  });
  await context.test('company access requires a current authenticated membership', async () => {
    const anonymous = await request('/api/companies');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('cache-control'), 'no-store');
    const error = await anonymous.json() as { error: { code: string; message: string }; requestId: string };
    assert.equal(error.requestId, anonymous.headers.get('x-request-id'));
    assert.equal(typeof error.error.code, 'string');
    assert.equal(typeof error.error.message, 'string');
    const list = await request('/api/companies', 'GET', cookieA);
    assert.equal(list.status, 200);
    const result = await list.json() as { companies: { id: string; name: string; slug: string; role: string }[]; activeCompanyId: string | null };
    assert.deepEqual(result.companies.map(company => company.id).sort(), ['company-a', 'company-b']);
    assert.equal(result.activeCompanyId, null);
    assert.deepEqual(result.companies.find(company => company.id === 'company-a'), { id: 'company-a', name: 'Company A', slug: 'company-a', role: 'owner' });
    const company = await request('/api/companies/company-b', 'GET', cookieB);
    assert.equal(company.status, 200);
    assert.deepEqual(await company.json(), { company: { id: 'company-b', name: 'Company B', slug: 'company-b', role: 'owner' } });
    const denied = await request('/api/companies/company-a', 'GET', cookieB);
    const absent = await request('/api/companies/company-absent', 'GET', cookieB);
    assert.equal(denied.status, 404);
    assert.equal(absent.status, 404);
    assert.deepEqual((await denied.json() as { error: unknown }).error, (await absent.json() as { error: unknown }).error);
  });
  await context.test('activation is POST-only, same-origin, and checks membership', async () => {
    assert.equal((await request('/api/companies/company-a/activate', 'GET', cookieA)).status, 404);
    assert.equal((await request('/api/companies/company-a/activate', 'POST', cookieA, {}, 'https://untrusted.example')).status, 403);
    assert.equal((await request('/api/companies/company-a/activate', 'POST', cookieA, {}, '')).status, 403);
    const rejected = await request('/api/companies/company-a/activate', 'POST', cookieB, {});
    const absent = await request('/api/companies/company-absent/activate', 'POST', cookieB, {});
    assert.equal(rejected.status, 404);
    assert.equal(absent.status, 404);
    assert.deepEqual((await rejected.json() as { error: unknown }).error, (await absent.json() as { error: unknown }).error);
    const response = await request('/api/companies/company-b/activate', 'POST', cookieA, {});
    assert.equal(response.status, 200);
    activationRequestId = response.headers.get('x-request-id')!;
    assert.deepEqual(await response.json(), { activeCompanyId: 'company-b' });
    const list = await request('/api/companies', 'GET', cookieA);
    assert.equal((await list.json() as { activeCompanyId: string }).activeCompanyId, 'company-b');
  });
  await context.test('company activation persists a bounded intent and result audit pair', async () => {
    const output = await wrangler(['d1', 'execute', 'DB', '--command',
      `SELECT * FROM identity_audit_event WHERE request_id = '${activationRequestId}' ORDER BY created_at, rowid`, '--json'], true);
    const rows = (JSON.parse(output) as { results: Record<string, unknown>[] }[]).flatMap(result => result.results);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.outcome), ['started', 'succeeded']);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['action', 'actor_user_id', 'after_role', 'before_role', 'created_at', 'id', 'organization_id', 'outcome', 'request_id', 'target_member_id']);
      assert.equal(row.target_member_id, null);
      assert.equal(row.before_role, null);
      assert.equal(row.after_role, null);
      assert.equal(row.action, 'company.activate');
      assert.equal(row.actor_user_id, 'user-a');
      assert.equal(row.organization_id, 'company-b');
    }
    assert.equal(JSON.stringify(rows).includes(password), false);
    assert.equal(JSON.stringify(rows).includes(cookieA), false);
  });
  await context.test('failed audit intent prevents the company change', async () => {
    await sql("CREATE TRIGGER fixture_audit_fault BEFORE INSERT ON identity_audit_event WHEN NEW.action = 'company.activate' AND NEW.outcome = 'started' BEGIN SELECT RAISE(FAIL, 'synthetic audit failure'); END;");
    try {
      const response = await request('/api/companies/company-a/activate', 'POST', cookieA, {});
      assert.equal(response.status, 503);
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'AUDIT_UNAVAILABLE');
      const list = await request('/api/companies', 'GET', cookieA);
      assert.equal((await list.json() as { activeCompanyId: string }).activeCompanyId, 'company-b');
    } finally { await sql('DROP TRIGGER fixture_audit_fault;'); }
  });
  await context.test('failed completion audit reports uncertainty while preserving the actual change and cookies', async () => {
    await sql("CREATE TRIGGER fixture_audit_fault BEFORE INSERT ON identity_audit_event WHEN NEW.action = 'company.activate' AND NEW.outcome = 'succeeded' BEGIN SELECT RAISE(FAIL, 'synthetic audit failure'); END;");
    try {
      const response = await request('/api/companies/company-a/activate', 'POST', cookieA, {});
      assert.equal(response.status, 503);
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'OPERATION_UNCONFIRMED');
      assert.ok(response.headers.getSetCookie().length > 0, 'native session cookies survive the uncertain result');
      const list = await request('/api/companies', 'GET', cookieA);
      assert.equal((await list.json() as { activeCompanyId: string }).activeCompanyId, 'company-a');
    } finally { await sql('DROP TRIGGER fixture_audit_fault;'); }
    assert.equal((await request('/api/companies/company-b/activate', 'POST', cookieA, {})).status, 200);
  });
  await context.test('session and active company survive a Worker restart', async () => {
    await finish(child);
    child = await start();
    const list = await request('/api/companies', 'GET', cookieA);
    assert.equal(list.status, 200);
    assert.equal((await list.json() as { activeCompanyId: string }).activeCompanyId, 'company-b');
  });
  await context.test('removing a membership immediately revokes a live cookie and active-company access', async () => {
    await sql("DELETE FROM member WHERE id = 'member-a-b';");
    assert.equal((await request('/api/companies/company-b', 'GET', cookieA)).status, 404);
    assert.equal((await request('/api/companies/company-b/activate', 'POST', cookieA, {})).status, 404);
    const list = await request('/api/companies', 'GET', cookieA);
    const result = await list.json() as { companies: { id: string }[]; activeCompanyId: string | null };
    assert.deepEqual(result.companies.map(company => company.id), ['company-a']);
    assert.equal(result.activeCompanyId, null, 'revoked active company must not remain accessible through session cache');
  });
  await context.test('sign-out invalidates the old session cookie immediately', async () => {
    assert.equal((await request('/api/auth/sign-out', 'POST', cookieA, {}, 'https://untrusted.example')).status, 403);
    assert.equal((await request('/api/companies', 'GET', cookieA)).status, 200);
    assert.equal((await request('/api/auth/sign-out', 'POST', cookieA, {})).status, 200);
    assert.equal((await request('/api/companies', 'GET', cookieA)).status, 401);
    const session = await request('/api/auth/get-session', 'GET', cookieA);
    assert.equal(await session.json(), null);
  });
  await context.test('direct SDK administration stays closed and mail requests require configuration', async () => {
    const cases: [string, string][] = [
      ['/api/auth/sign-up/email', 'POST'], ['/api/auth/organization/create', 'POST'],
      ['/api/auth/organization/invite-member', 'POST'], ['/api/auth/organization/set-active', 'POST'],
      ['/api/auth/verify-email', 'GET'],
      ['/__probe/mail', 'GET'], ['/__probe/bootstrap/status', 'GET'], ['/__probe/seed', 'POST'],
    ];
    for (const [path, method] of cases) {
      assert.equal((await request(path, method, cookieB, method === 'POST' ? {} : undefined)).status, 404, path);
    }
    for (const path of ['/api/auth/request-password-reset', '/api/auth/send-verification-email']) {
      const response = await request(path, 'POST', cookieB, { email: 'b@example.invalid' });
      assert.equal(response.status, 503);
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'MAIL_NOT_CONFIGURED');
    }
  });
  await context.test('a previously verified identity loses company access when email verification is revoked', async () => {
    await sql("UPDATE user SET email_verified = 0 WHERE id = 'user-b';");
    const response = await request('/api/companies', 'GET', cookieB);
    assert.ok([401, 403].includes(response.status), 'historical cookies cannot bypass current email verification');
  });
  await finish(child);
  await context.test('missing database, URL, or sufficiently strong secret fails closed', async () => {
    for (const config of [
      { secret: '', url: baseURL, noDB: false },
      { secret: 'too-short', url: baseURL, noDB: false },
      { secret, url: '', noDB: false },
      { secret, url: baseURL, noDB: true },
    ]) {
      child = await start(config.secret, config.url, config.noDB);
      assert.equal((await request('/api/health')).status, 200);
      const setup = await request('/api/setup');
      assert.equal(setup.status, 200);
      assert.equal((await setup.json() as { identity: { configured: boolean } }).identity.configured, false);
      for (const path of ['/api/auth/get-session', '/api/companies', '/api/companies/company-a']) {
        assert.equal((await request(path, 'GET', cookieB)).status, 503, path);
      }
      assert.equal((await request('/api/auth/sign-in/email', 'POST', '', { email: 'a@example.invalid', password })).status, 503);
      await finish(child);
    }
  });
});
