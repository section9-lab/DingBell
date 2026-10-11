import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { checkIdentity } from '../../probes/identity/check.ts';
import { checkBootstrap } from '../../probes/identity/bootstrap-check.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

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

test('real Workers/D1 identity and organization contracts', { timeout: 180_000 }, async (context) => {
  const statePath = await mkdtemp(join(tmpdir(), 'dingbell-identity-'));
  const children = new Set<ChildProcess>();
  context.after(async () => {
    await Promise.all([...children].map(stop));
    await rm(statePath, { recursive: true, force: true });
  });
  async function finish(child: ChildProcess) {
    await stop(child);
    children.delete(child);
  }
  async function migrate(target = statePath) {
    const migration = spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'migrations', 'apply', 'DB', '--config', 'probes/identity/wrangler.jsonc', '--local', '--persist-to', target], {
      cwd: root, detached: true, stdio: 'ignore', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    });
    children.add(migration);
    const [code] = await once(migration, 'exit');
    await finish(migration);
    assert.equal(code, 0, 'official Wrangler migrations must succeed');
  }
  await context.test('empty D1 database and repeated migration application', async () => {
    await migrate();
    await migrate();
  });
  const portServer = createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const address = portServer.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  const baseURL = `http://127.0.0.1:${port}`;
  const token = crypto.randomUUID();
  const authSecret = crypto.randomUUID() + crypto.randomUUID();
  const bootstrapSecret = crypto.randomUUID();
  async function start(probeToken: string, secret = authSecret, target = statePath, installationSecret = bootstrapSecret, hooks = 'true') {
    const child = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--config', 'probes/identity/vite.config.ts', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', DINGBELL_IDENTITY_STATE_PATH: target, DINGBELL_IDENTITY_TOKEN: probeToken, DINGBELL_IDENTITY_AUTH_SECRET: secret, DINGBELL_IDENTITY_BASE_URL: baseURL, DINGBELL_IDENTITY_BOOTSTRAP_SECRET: installationSecret, DINGBELL_IDENTITY_BOOTSTRAP_TEST_HOOKS: hooks },
    });
    children.add(child);
    // Drain diagnostics without exposing cookies, mail links or secrets in failures.
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
    assert.ok(ready, 'local identity Worker must start');
    return child;
  }
  let child = await start(token);
  await context.test('official identity and organization HTTP contracts survive migration/restart', async () => {
    await checkIdentity(baseURL, token, async () => {
      await finish(child);
      await migrate();
      child = await start(token);
    });
  });
  await context.test('bootstrap claim, expired execution lease and interrupted public APIs', async () => {
    await checkBootstrap(baseURL, token, bootstrapSecret, false, async () => {
      await finish(child);
      child = await start(token);
    });
  });
  await finish(child);
  await context.test('absent probe or auth secrets fail closed in workerd', async () => {
    for (const [probeToken, secret] of [['', authSecret], [token, '']]) {
      child = await start(probeToken, secret);
      const response = await fetch(`${baseURL}/api/auth/get-session`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 503);
      assert.equal((await fetch(`${baseURL}/api/health`)).status, 200);
      await finish(child);
    }
  });
  await context.test('absent installation secret does not open bootstrap', async () => {
    child = await start(token, authSecret, statePath, '');
    assert.equal((await fetch(`${baseURL}/__probe/bootstrap/status`, { headers: { authorization: `Bearer ${token}` } })).status, 503);
    await finish(child);
  });
  await context.test('clock and fault injection require the explicit probe test switch', async () => {
    child = await start(token, authSecret, statePath, bootstrapSecret, '');
    const response = await fetch(`${baseURL}/__probe/bootstrap/resume`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-bootstrap-authorization': `Bearer ${bootstrapSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ claimId: crypto.randomUUID(), password: crypto.randomUUID(), testNow: Date.now() }),
    });
    assert.equal(response.status, 400);
    await finish(child);
  });
  await context.test('bootstrap cannot appropriate an existing email identity', async () => {
    const isolatedPath = join(statePath, 'occupied-email');
    await migrate(isolatedPath);
    child = await start(token, authSecret, isolatedPath);
    await checkBootstrap(baseURL, token, bootstrapSecret, true);
    await finish(child);
  });
});
