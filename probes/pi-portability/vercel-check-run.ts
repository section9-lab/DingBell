import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Observation } from './vercel-adapter.ts';

if (!process.argv.includes('--isolated-cloud')) throw new Error('Pass --isolated-cloud to create and remove a synthetic-only Vercel project.');
const option = (key: string) => process.argv[process.argv.indexOf(key) + 1];
const cli = process.argv.includes('--cli') ? option('--cli') : undefined;
const scope = process.argv.includes('--scope') ? option('--scope') : undefined;
if (!cli || !scope || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(scope)) throw new Error('Provide --cli /absolute/path/to/vercel/dist/vc.js and --scope your-team-slug.');
const directory = import.meta.dirname;
const name = `dingbell-harness-check-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
const token = crypto.randomUUID() + crypto.randomUUID();
const output = resolve(directory, '../../test-results/pi-portability', name);
await mkdir(output, { recursive: true });
try { await readFile(join(directory, '.vercel/project.json')); throw new Error('Refusing to replace an existing project link.'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
try { await readFile(join(directory, '.env.local')); throw new Error('Refusing to overwrite an existing local environment file.'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const phases: { phase: string; code: number | null }[] = [];
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), name, node: process.version, phases,
  scope: 'pi-durable-on-vercel-world-only-no-business-db-sandbox-or-real-provider', versions: { pi: '1.4.0', durableHarness: '0.0.1', worldVercel: '5.2.3' } };
let projectAttempted = false;
let origin: string | undefined;
let sessionId: string | undefined;

async function command(phase: string, args: string[], input?: string) {
  const result = await new Promise<{ code: number | null; output: string }>((complete, reject) => {
    const child = spawn(process.execPath, [cli!, ...args, '--scope', scope!], {
      cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DO_NOT_TRACK: '1', VERCEL_TELEMETRY_DISABLED: '1' },
    });
    child.stdin.end(input ?? '');
    let captured = '';
    const capture = (chunk: Buffer) => { captured = (captured + chunk.toString()).slice(-200_000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); complete({ code, output: captured.replaceAll(token, '[redacted]') }); });
  });
  phases.push({ phase, code: result.code });
  await writeFile(join(output, `${phase}.log`), result.output, { mode: 0o600 });
  console.log(`${phase}: ${result.code === 0 ? 'passed' : 'failed'}`);
  return result;
}
function success(result: { code: number | null; output: string }) {
  assert.equal(result.code, 0, result.output.slice(-5000)); return result.output;
}
function deployedURL(log: string) {
  // Unique deployment URLs have Vercel Authentication; the production alias is the app entry.
  const value = /"productionUrl":\s*"(https:\/\/[a-z0-9][a-z0-9.-]*\.vercel\.app)"/.exec(log)?.[1];
  assert.ok(value, 'The CLI must return a deployment URL.'); return value;
}
async function deploy(phase: string, force = false) {
  const result = await command(phase, ['deploy', '--prod', '--yes', ...(force ? ['--force'] : []), '--logs']);
  if (result.code === 0) return deployedURL(result.output);
  const pending = /Could not confirm the status of deployment (dpl_[a-zA-Z0-9]+)/.exec(result.output)?.[1];
  if (!pending) return deployedURL(success(result));
  // A lost CLI status response is uncertain. Inspect that deployment; do not submit another.
  const checked = await command(`${phase}-inspect`, ['inspect', pending, '--wait', '--timeout', '180s', '--json']);
  success(checked);
  if (!origin) throw new Error('Initial deployment status recovered; inspect its production alias before rerunning.');
  return origin;
}
async function request(path: string, method = 'GET', body?: unknown, credentials = true) {
  assert.ok(origin);
  return fetch(new URL(path, origin), { method, redirect: 'manual', signal: AbortSignal.timeout(45_000),
    headers: { ...(credentials ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
interface State {
  sessionId: string; unfinished: boolean; deployment: string; node: string; observations: Observation[];
  receipt?: { submissionId: string; duplicateId: string; conflictId: string; deployment: string };
  entries: { kind: string; model?: unknown[] }[];
  tasks: { id: string; kind: string; status: string; starts: unknown[] }[];
}
async function inspect() {
  const response = await request(`/api/session?sessionId=${sessionId}`);
  assert.equal(response.status, 200, (await response.clone().text()).slice(0, 600));
  return await response.json() as State;
}
try {
  projectAttempted = true;
  success(await command('create-project', ['project', 'create', name]));
  success(await command('link-project', ['link', '--yes', '--project', name]));
  const inputs = JSON.parse(success(await command('deploy-inputs', ['deploy', '--dry', '--json']))) as { files: { path: string }[] };
  const files = inputs.files.map(value => value.path);
  for (const path of ['api/session.ts', 'api/crash.ts', 'api/flow.ts']) assert.ok(files.includes(path), `Missing deployed function: ${path}`);
  assert.equal(files.some(path => /(?:^|\/)\.(?:env|dev)/.test(path)), false, 'Credential files must not be uploaded.');
  // The credential is sent only on stdin, never in process arguments or source.
  success(await command('configure-secret', ['env', 'add', 'PI_PROBE_TOKEN', '--environment', 'production', '--sensitive', '--yes'], token));
  origin = await deploy('deploy');
  evidence.firstOrigin = origin;
  assert.equal((await request('/api/session', 'POST', {}, false)).status, 401);
  assert.equal((await request('/api/crash', 'POST', {}, false)).status, 401);
  const created = await request('/api/session', 'POST', {});
  assert.equal(created.status, 201, (await created.clone().text()).slice(0, 800));
  sessionId = (await created.json() as { sessionId: string }).sessionId;
  evidence.sessionId = sessionId;
  console.log('Waiting for a real Function timeout; no manual abort or recovery request is sent.');
  const started = Date.now();
  const crash = await request('/api/crash', 'POST', { sessionId });
  const crashBody = await crash.text();
  evidence.interruption = { status: crash.status, elapsedMs: Date.now() - started, platformTimeout: crashBody.includes('FUNCTION_INVOCATION_TIMEOUT') };
  assert.equal(crash.status, 504, crashBody.slice(0, 800));
  assert.ok(crashBody.includes('FUNCTION_INVOCATION_TIMEOUT'), 'The platform must confirm Function timeout.');
  let state = await inspect();
  evidence.afterTimeout = state;
  evidence.runtimeNode = state.node;
  const observedInterrupted = state.unfinished;
  const until = Date.now() + 100_000;
  while (state.unfinished && Date.now() < until) { await delay(1500); state = await inspect(); }
  evidence.afterQueue = state;
  assert.equal(state.unfinished, false, 'Only the native queue can finish the interrupted turn.');
  assert.ok(state.receipt, 'The original accepted receipt must be durable.');
  assert.equal(state.receipt.duplicateId, state.receipt.submissionId);
  assert.equal(state.receipt.conflictId, state.receipt.submissionId);
  assert.equal(state.entries.filter(entry => entry.kind === 'pi.user').length, 1);
  assert.equal(JSON.stringify(state.entries).includes('different-synthetic-content'), false, 'Conflicting input must not replace the admitted payload.');
  assert.ok(JSON.stringify(state.entries).includes('fixture-ok'));
  const prepared = state.observations.filter(value => value.action === 'prepare');
  const waits = state.observations.filter(value => value.action === 'wait');
  const models = state.observations.filter(value => value.action === 'model');
  assert.equal(prepared.length, 1, 'Completed tool must not run twice.');
  assert.equal(waits.length, 2, 'Only the interrupted safe tool is replayed.');
  assert.equal(waits[0]!.callId, waits[1]!.callId, 'Recovery must retain the durable tool task ID.');
  assert.notEqual(waits[0]!.openerId, waits[1]!.openerId, 'A new queue-driven Harness must reopen the session.');
  assert.equal(models.length, 3, 'Finished synthetic model calls must not repeat.');
  const receipt = state.receipt;
  evidence.recovery = { observedInterrupted, passiveReaderOnly: true, receipt, completedToolCalls: prepared.length,
    safeToolInvocations: waits.length, sameToolTaskId: true, distinctHarnessOpeners: true, syntheticModelCalls: models.length,
    userEntries: 1, observations: state.observations, tasks: state.tasks };
  const readOriginal = async () => {
    const response = await request('/api/session', 'POST', { sessionId, submissionId: receipt.submissionId });
    assert.equal(response.status, 200, (await response.clone().text()).slice(0, 500));
    const result = await response.json() as { submissionId: string; status: string; text: string };
    assert.equal(result.submissionId, receipt.submissionId); assert.equal(result.status, 'done'); assert.equal(result.text, 'fixture-ok');
    return result;
  };
  await readOriginal();
  origin = await deploy('redeploy', true);
  let after = await inspect();
  const aliasDeadline = Date.now() + 30_000;
  while (after.deployment === receipt.deployment && Date.now() < aliasDeadline) { await delay(1000); after = await inspect(); }
  assert.notEqual(after.deployment, receipt.deployment, 'Two distinct deployments are required.');
  await readOriginal();
  const final = await inspect();
  assert.equal(final.observations.filter(value => value.action === 'model').length, models.length);
  assert.equal(final.observations.filter(value => value.action === 'prepare').length, 1);
  assert.equal(final.observations.filter(value => value.action === 'wait').length, 2);
  evidence.redeployment = { originalDeployment: receipt.deployment, newDeployment: after.deployment, originalReceiptPreserved: true, additionalModelCalls: 0 };
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed'; evidence.error = error instanceof Error ? error.message.replaceAll(token, '[redacted]') : String(error); process.exitCode = 1;
} finally {
  if (origin && sessionId) {
    try { evidence.runCancelled = (await request(`/api/session?sessionId=${sessionId}`, 'DELETE')).status === 204; }
    catch { evidence.runCancelled = false; }
  }
  if (projectAttempted) {
    let removed = await command('delete-project', ['project', 'delete', name, '--yes']);
    for (let attempt = 1; removed.code !== 0 && /fetch failed/.test(removed.output) && attempt <= 2; attempt++) {
      await delay(1500);
      removed = await command(`delete-project-retry-${attempt}`, ['project', 'delete', name, '--yes']);
    }
    evidence.projectRemoved = removed.code === 0;
    if (removed.code !== 0) process.exitCode = 1;
  }
  await rm(join(directory, '.vercel'), { recursive: true, force: true });
  await rm(join(directory, '.env.local'), { force: true });
  // vercel link may create this redundant local ignore file.
  const generatedIgnore = join(directory, '.gitignore');
  try { if ((await readFile(generatedIgnore, 'utf8')).trim() === '.vercel\n.env*') await rm(generatedIgnore); } catch { /* absent */ }
  evidence.finishedAt = new Date().toISOString();
  const path = join(output, 'evidence.json');
  await writeFile(path, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ status: evidence.status, projectRemoved: evidence.projectRemoved, evidencePath: path, error: evidence.error }));
}
