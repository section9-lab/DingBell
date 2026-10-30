import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkCloudflare, checkRedeployment } from './cloudflare-check.ts';

if (!process.argv.includes('--isolated-cloud')) throw new Error('Pass --isolated-cloud to create and remove one dedicated fixture Worker.');
const workerName = `dingbell-pi-portability-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
const temporary = await mkdtemp(join(tmpdir(), 'dingbell-pi-cloud-secret-'));
const secretPath = join(temporary, 'secrets.json');
const token = crypto.randomUUID() + crypto.randomUUID();
await writeFile(secretPath, JSON.stringify({ PROBE_TOKEN: token }), { mode: 0o600 });
const outputDirectory = resolve(import.meta.dirname, '../../test-results/pi-portability');
await mkdir(outputDirectory, { recursive: true });
const evidencePath = join(outputDirectory, `${workerName}.json`);
const phases: { phase: string; exitCode: number | null; version?: string }[] = [];
let deployed = false;
let removed = false;

function wrangler(arguments_: string[]) {
  return new Promise<{ code: number | null; output: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...arguments_], {
      cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
    });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-24_000); });
    child.stderr.on('data', chunk => { output = (output + String(chunk)).slice(-24_000); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timeout); resolvePromise({ code, output: output.replaceAll(token, '[redacted]') }); });
  });
}

const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), node: process.version, workerName, phases };
try {
  console.log('Deploying a new, synthetic-only PiHarness fixture Worker.');
  const first = await wrangler(['deploy', '--config', 'wrangler.jsonc', '--name', workerName, '--secrets-file', secretPath, '--autoconfig=false']);
  phases.push({ phase: 'initial-deploy', exitCode: first.code, version: /Current Version ID:\s*(\S+)/.exec(first.output)?.[1] });
  if (first.code !== 0) throw new Error(`Initial deployment failed: ${first.output.slice(-5000)}`);
  deployed = true;
  const origin = /https:\/\/dingbell-pi-portability-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/.exec(first.output)?.[0];
  assert.ok(origin, 'Dedicated fixture origin missing from deploy output.');
  evidence.origin = origin;
  let healthy = false;
  let readinessError: unknown;
  const readyUntil = Date.now() + 45_000;
  while (Date.now() < readyUntil) {
    try {
      const response = await fetch(new URL('/health', origin), { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (response.ok && (await response.json() as { service?: string }).service === 'dingbell-pi-portability-probe') { healthy = true; break; }
      readinessError = `HTTP ${response.status}`;
    } catch (error) { readinessError = error instanceof Error ? { message: error.message, cause: String(error.cause) } : String(error); }
    await delay(1000);
  }
  evidence.readiness = { healthy, ...(healthy ? {} : { error: readinessError }) };
  assert.ok(healthy, `Cloud fixture readiness failed: ${JSON.stringify(readinessError)}`);
  console.log('Checking cloud submission, alarm-only recovery, completion and cancellation.');
  const contracts = await checkCloudflare(origin, token);
  evidence.contracts = contracts;
  console.log('Redeploying the same fixture and reading original receipts without resubmission.');
  const second = await wrangler(['deploy', '--config', 'wrangler.jsonc', '--name', workerName, '--secrets-file', secretPath, '--autoconfig=false']);
  phases.push({ phase: 'redeploy', exitCode: second.code, version: /Current Version ID:\s*(\S+)/.exec(second.output)?.[1] });
  if (second.code !== 0) throw new Error(`Redeployment failed: ${second.output.slice(-5000)}`);
  assert.ok(phases[0].version && phases[1].version && phases[0].version !== phases[1].version, 'Two distinct deployed versions required.');
  evidence.redeployment = await checkRedeployment(origin, token, contracts);
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = error instanceof Error ? error.message : String(error);
  evidence.cause = error instanceof Error ? String(error.cause) : undefined;
  process.exitCode = 1;
} finally {
  if (deployed) {
    console.log('Removing the dedicated fixture Worker and its synthetic state.');
    const cleanup = await wrangler(['delete', workerName, '--config', 'wrangler.jsonc', '--force']);
    phases.push({ phase: 'cleanup', exitCode: cleanup.code });
    removed = cleanup.code === 0;
    if (!removed) { evidence.cleanupError = cleanup.output.slice(-3000); process.exitCode = 1; }
  }
  evidence.removed = removed;
  evidence.finishedAt = new Date().toISOString();
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ status: evidence.status, removed, evidencePath, error: evidence.error }));
}
