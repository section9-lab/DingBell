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
import { checkAuthorization, checkCron, checkQueues, checkR2 } from '../../probes/platform/check.ts';
import app from '../../probes/platform/src/app.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('job fixture behavior rejects arrays and objects before enqueueing', async () => {
  let enqueued = 0;
  for (const behavior of [['poison'], {}, { toString: 'poison' }]) {
    const response = await app.request('/__probe/jobs', {
      method: 'POST', headers: { authorization: 'Bearer synthetic-test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ runId: crypto.randomUUID(), key: 'invalid', behavior, copies: 1 }),
    }, { PROBE_TOKEN: 'synthetic-test-token', PROBE_QUEUE: { async sendBatch() { enqueued++; } } });
    assert.equal(response.status, 400);
  }
  assert.equal(enqueued, 0);
});

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

test('real workerd R2, Queues, DLQ and scheduled contracts', { timeout: 240_000 }, async context => {
  const statePath = await mkdtemp(join(tmpdir(), 'dingbell-platform-'));
  const children = new Set<ChildProcess>();
  context.after(async () => {
    await Promise.all([...children].map(stop));
    await rm(statePath, { recursive: true, force: true });
  });
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const baseURL = `http://127.0.0.1:${port}`;
  const token = crypto.randomUUID();
  async function start(probeToken: string, skipR2 = false) {
    const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', DINGBELL_PLATFORM_SKIP_R2: skipR2 ? '1' : '0', DINGBELL_PLATFORM_CRON: '' };
    const build = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'probes/platform/vite.config.ts'], {
      cwd: root, detached: true, stdio: 'ignore', env,
    });
    children.add(build);
    const [exitCode] = await once(build, 'exit');
    await stop(build); children.delete(build);
    assert.equal(exitCode, 0, 'the Flue-generated platform Worker must build');
    const child = spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', 'probes/platform/dist/dingbell_platform_probe/wrangler.json', '--bundle', '--local', '--test-scheduled', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0', '--persist-to', statePath, '--var', `PROBE_TOKEN:${probeToken}`], {
      cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    children.add(child);
    child.stdout!.resume(); child.stderr!.resume();
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null && !context.signal.aborted) {
      try {
        if ((await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(1000) })).status === 200) { ready = true; break; }
      } catch { /* Wait for workerd. */ }
      await delay(200);
    }
    assert.ok(ready, 'platform probe Worker must start');
    return child;
  }
  async function finish(child: ChildProcess) { await stop(child); children.delete(child); }
  let child = await start(token);
  await context.test('public health, protected controls and fixture validation', () => checkAuthorization(baseURL, token));
  await context.test('R2 synthetic put, head, get, hash, delete and missing', async () => { await checkR2(baseURL, token); });
  await context.test('native producer/consumer, stable-key deduplication, retry and DLQ', async () => { await checkQueues(baseURL, token); });
  await context.test('native scheduled invocation, stored event and count', async () => { await checkCron(baseURL, token, { local: true }); });
  const cronBefore = await fetch(`${baseURL}/__probe/cron`, { headers: { authorization: `Bearer ${token}` } });
  const snapshot = cronBefore.status === 200 ? await cronBefore.json() : null;
  await finish(child);
  child = await start(token, true);
  await context.test('SQLite state survives restart; queues and cron work without R2', async () => {
    const headers = { authorization: `Bearer ${token}` };
    assert.deepEqual(await (await fetch(`${baseURL}/__probe/cron`, { headers })).json(), snapshot);
    assert.equal((await fetch(`${baseURL}/__probe/r2/${crypto.randomUUID()}`, { headers })).status, 503);
    await checkQueues(baseURL, token);
    await checkCron(baseURL, token, { local: true });
  });
  await finish(child);
  child = await start('');
  await context.test('missing probe secret fails closed', async () => {
    assert.equal((await fetch(`${baseURL}/__probe/cron`, { headers: { authorization: 'Bearer ' } })).status, 503);
    assert.equal((await fetch(`${baseURL}/api/health`)).status, 200);
  });
  await finish(child);
});
