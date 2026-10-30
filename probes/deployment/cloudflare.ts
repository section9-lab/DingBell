import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hashPassword } from 'better-auth/crypto';

type BuiltConfig = {
  name: string; main: string; assets: { directory: string };
  d1_databases: { binding: string; database_name: string; database_id: string; migrations_dir: string }[];
  workflows: { name: string; binding: string; class_name: string }[];
  vars: Record<string, string>; r2_buckets?: unknown[];
};

if (!process.argv.includes('--isolated-cloud')) throw new Error('Pass --isolated-cloud to create and remove a synthetic-only installation.');
const root = resolve(import.meta.dirname, '../..');
const built = resolve(root, 'dist/dingbell/wrangler.json');
const name = `dingbell-install-check-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
const output = resolve(root, 'test-results/deployment', name);
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'dingbell-install-secret-'));
const configPath = join(output, 'wrangler.json');
const secretsPath = join(temporary, 'secrets.json');
const secret = crypto.randomUUID() + crypto.randomUUID();
const bootstrap = crypto.randomUUID() + crypto.randomUUID();
const password = crypto.randomUUID() + '!Aa1';
const workflows = [`${name}-index`, `${name}-review`];
const phases: { phase: string; code: number | null; version?: string }[] = [];
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), name, phases, scope: 'production-build-with-synthetic-identities-no-email-model-or-sends' };
let databaseCreated = false;
let uploadAttempted = false;

async function command(phase: string, args: string[], executable = resolve(root, 'node_modules/wrangler/bin/wrangler.js')) {
  const result = await new Promise<{ code: number | null; output: string }>((complete, reject) => {
    const child = spawn(process.execPath, [executable, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' } });
    let captured = '';
    const capture = (chunk: Buffer) => { captured = (captured + chunk.toString()).slice(-200_000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); complete({ code, output: captured }); });
  });
  for (const value of [secret, bootstrap, password]) result.output = result.output.replaceAll(value, '[redacted]');
  await writeFile(join(output, `${phase}.log`), result.output, { mode: 0o600 });
  phases.push({ phase, code: result.code, version: /Current Version ID:\s*(\S+)/.exec(result.output)?.[1] });
  console.log(`${phase}: ${result.code === 0 ? 'passed' : 'failed'}`);
  return result;
}
function success(result: { code: number | null; output: string }) {
  assert.equal(result.code, 0, result.output.slice(-6000));
  return result.output;
}

try {
  const config = JSON.parse(await readFile(built, 'utf8')) as BuiltConfig;
  assert.equal(config.name, 'dingbell');
  assert.equal(config.r2_buckets?.length ?? 0, 0);
  config.name = name;
  config.main = resolve(built, '..', config.main);
  config.assets.directory = resolve(built, '..', config.assets.directory);
  config.d1_databases = [{ binding: 'DB', database_name: name, database_id: 'dingbell-local-only', migrations_dir: resolve(root, 'migrations') }];
  for (let index = 0; index < config.workflows.length; index++) config.workflows[index].name = workflows[index];
  // Keep every default feature gate closed, with no provider credentials.
  assert.ok(Object.values(config.vars).every(value => value === 'false'));
  await writeFile(configPath, JSON.stringify(config));
  const create = await command('create-database', ['d1', 'create', name, '--update-config=false', '--config', configPath]);
  const databaseId = /"database_id"\s*:\s*"([0-9a-f-]{36})"/.exec(create.output)?.[1];
  if (databaseId) databaseCreated = true;
  success(create);
  assert.ok(databaseId, 'Created database ID must be returned by Wrangler.');
  config.d1_databases[0].database_id = databaseId;
  await writeFile(configPath, JSON.stringify(config));
  // The first upload discovers the account's workers.dev origin. It has no identity secrets yet.
  uploadAttempted = true;
  const initial = success(await command('deploy-initial', ['--config', configPath], resolve(root, 'scripts/deploy-cloudflare.ts')));
  const origin = /https:\/\/dingbell-install-check-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/.exec(initial)?.[0];
  assert.ok(origin, 'A dedicated workers.dev origin must be returned.');
  evidence.origin = origin;
  await writeFile(secretsPath, JSON.stringify({ APP_BASE_URL: origin, BETTER_AUTH_SECRET: secret, BOOTSTRAP_SECRET: bootstrap }), { mode: 0o600 });
  success(await command('deploy-configured', ['--config', configPath, '--secrets-file', secretsPath], resolve(root, 'scripts/deploy-cloudflare.ts')));
  async function request(path: string, method = 'GET', cookie = '', body?: unknown) {
    return fetch(new URL(path, origin), { method, redirect: 'manual', signal: AbortSignal.timeout(20_000),
      headers: { origin: origin!, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  let ready = false;
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    try {
      const response = await request('/api/setup');
      if (response.ok && (await response.json() as { identity?: { configured?: boolean } }).identity?.configured) { ready = true; break; }
    } catch { /* wait for workers.dev provisioning */ }
    await delay(1000);
  }
  assert.ok(ready, 'Configured production application must become ready.');
  assert.equal((await request('/api/health')).status, 200);
  const status = await request('/api/bootstrap');
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { state: 'unclaimed', configured: true, emailConfigured: false });
  const html = await request('/login');
  assert.equal(html.status, 200);
  const page = await html.text();
  const modulePath = /<script[^>]+src="(\/assets\/[^"?]+\.js)"/.exec(page)?.[1];
  assert.ok(modulePath, 'The deployed HTML must load a local application bundle.');
  const asset = await request(modulePath);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type') ?? '', /javascript/);
  const missing = await request('/api/not-a-real-endpoint');
  assert.equal(missing.status, 404); assert.match(missing.headers.get('content-type') ?? '', /json/);
  assert.equal((await request('/api/companies')).status, 401);
  evidence.freshInstallation = { schemaReadable: true, unclaimed: true, identityConfigured: true, mailConfigured: false, staticAssets: true, apiRouting: true, anonymousDenied: true };

  // Isolated test identities exercise real deployed auth/business SQL without sending email.
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const now = Date.now();
  const sql = join(temporary, 'identities.sql');
  await writeFile(sql, `
    INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES('fixture-a','Fixture A','a@example.invalid',1,${now},${now});
    INSERT INTO account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES('fixture-account','fixture-a','credential','fixture-a',${quote(await hashPassword(password))},${now},${now});
    INSERT INTO organization(id,name,slug,created_at) VALUES('fixture-company-a','Fixture A','fixture-a',${now}),('fixture-company-b','Fixture B','fixture-b',${now});
    INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('fixture-owner','fixture-company-a','fixture-a','owner',${now});
  `, { mode: 0o600 });
  success(await command('seed-synthetic-identities', ['d1', 'execute', 'DB', '--remote', '--config', configPath, '--file', sql]));
  const login = await request('/api/auth/sign-in/email', 'POST', '', { email: 'a@example.invalid', password });
  assert.equal(login.status, 200, 'Real production sign-in must work.');
  const cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  assert.ok(cookie.includes('session_token='));
  assert.equal(JSON.stringify(await login.json()).includes('"token"'), false);
  const companies = await request('/api/companies', 'GET', cookie);
  assert.equal(companies.status, 200);
  const catalog = await companies.json() as { companies: { id: string }[] };
  assert.deepEqual(catalog.companies.map(value => value.id), ['fixture-company-a']);
  assert.equal((await request('/api/companies/fixture-company-a/activate', 'POST', cookie, {})).status, 200);
  const settingsPath = '/api/companies/fixture-company-a/settings';
  const setting = await request(settingsPath, 'GET', cookie);
  assert.equal(setting.status, 200);
  const current = await setting.json() as { version: number };
  const saved = await request(settingsPath, 'POST', cookie, { timeZone: 'Asia/Shanghai', expectedVersion: current.version });
  assert.equal(saved.status, 200);
  const expected = await saved.json();
  assert.equal((await request('/api/companies/fixture-company-b/settings', 'GET', cookie)).status, 404);
  evidence.business = { realSignIn: true, httpOnlySession: login.headers.getSetCookie().some(value => /httponly/i.test(value)), companyIsolation: true, settingsWrite: true };
  success(await command('redeploy', ['--config', configPath, '--secrets-file', secretsPath], resolve(root, 'scripts/deploy-cloudflare.ts')));
  const restored = await request(settingsPath, 'GET', cookie);
  assert.equal(restored.status, 200);
  assert.deepEqual(await restored.json(), expected);
  evidence.redeployment = { migrationsIdempotent: true, settingsPreserved: true, sessionPreserved: true };
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed'; evidence.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
} finally {
  const cleanup: Record<string, boolean> = {};
  if (uploadAttempted) {
    for (const workflow of workflows) cleanup[workflow] = (await command(`delete-${workflow.endsWith('-index') ? 'index' : 'review'}`, ['workflows', 'delete', workflow, '--config', configPath])).code === 0;
    cleanup.worker = (await command('delete-worker', ['delete', name, '--force', '--config', configPath])).code === 0;
  }
  if (databaseCreated) cleanup.database = (await command('delete-database', ['d1', 'delete', name, '--skip-confirmation', '--config', configPath])).code === 0;
  evidence.cleanup = cleanup; evidence.finishedAt = new Date().toISOString();
  if (Object.values(cleanup).some(value => !value)) process.exitCode = 1;
  await rm(temporary, { recursive: true, force: true });
  const path = join(output, 'evidence.json');
  await writeFile(path, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ status: evidence.status, cleanup, evidencePath: path, error: evidence.error }));
}
