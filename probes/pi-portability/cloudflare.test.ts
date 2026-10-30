import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { checkCloudflare } from './cloudflare-check.ts';

test('PiHarness: local workerd storage, alarm recovery and abort contracts', { timeout: 150_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dingbell-pi-workerd-'));
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const token = crypto.randomUUID();
  const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'wrangler.jsonc', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', directory, '--var', `PROBE_TOKEN:${token}`], {
    cwd: import.meta.dirname, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs = (logs + String(chunk)).slice(-12_000); });
  child.stderr.on('data', chunk => { logs = (logs + String(chunk)).slice(-12_000); });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    }
    await exited;
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  const end = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < end && child.exitCode === null) {
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch { /* Wait for the local runtime. */ }
    await delay(100);
  }
  assert.ok(ready, logs.replaceAll(token, '[redacted]'));
  const result = await checkCloudflare(origin, token);
  t.diagnostic(JSON.stringify(result));
});
