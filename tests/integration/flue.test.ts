import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { checkLifecycle } from '../../probes/flue/lifecycle-check.ts';
import { checkBounded } from '../../probes/flue/bounded-check.ts';
import { checkContracts } from '../../probes/flue/contracts-check.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function reservePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stop(child: ChildProcess, force = false) {
  if (child.pid === undefined) return;
  const signalGroup = (signal: NodeJS.Signals) => {
    try { process.kill(-child.pid!, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const exited = child.exitCode === null && child.signalCode === null
    ? once(child, 'exit')
    : Promise.resolve();
  signalGroup(force ? 'SIGKILL' : 'SIGTERM');
  const timer = setTimeout(() => signalGroup('SIGKILL'), 5_000);
  try { await exited; } finally {
    clearTimeout(timer);
    // Vite exiting alone does not prove its workerd children have exited.
    signalGroup('SIGKILL');
  }
}

async function start(statePath: string, token: string, gateUrl: string, children: Set<ChildProcess>, signal: AbortSignal) {
  const port = await reservePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [
    join(root, 'node_modules/vite/bin/vite.js'),
    '--config', 'probes/flue/vite.config.ts',
    '--host', '127.0.0.1', '--port', String(port), '--strictPort',
  ], {
    cwd: root,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: 'false',
      DINGBELL_PROBE_STATE_PATH: statePath,
      DINGBELL_PROBE_TOKEN: token,
      DINGBELL_PROBE_GATE_URL: gateUrl,
    },
  });
  children.add(child);
  let output = '';
  const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-12_000); };
  child.stdout!.on('data', collect);
  child.stderr!.on('data', collect);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && child.exitCode === null && !signal.aborted) {
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
      const body = await response.json() as { service?: string };
      if (response.ok && body.service === 'dingbell-flue-probe') return { child, url, logs: () => output };
    } catch { /* Wait for the local Worker to become ready. */ }
    await delay(200);
  }
  await stop(child);
  children.delete(child);
  throw new Error(`Local Flue probe did not become ready.\n${output}`);
}

test('native Cloudflare Flue submission, abort and recovery contracts', {
  timeout: 180_000,
}, async (context) => {
  const statePath = await mkdtemp(join(tmpdir(), 'dingbell-flue-test-'));
  const token = crypto.randomUUID();
  const children = new Set<ChildProcess>();
  const gates = new Map<string, { prepared: string[]; entered: string[]; waiting: Set<ServerResponse> }>();
  // This controller stays alive when the Worker process group is killed.
  const gate = createHttpServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    const [action, id, callId] = (request.url ?? '').slice(1).split('/').map(decodeURIComponent);
    const state = gates.get(id);
    if (!state || !callId) { response.writeHead(404).end(); return; }
    if (action === 'prepare') {
      state.prepared.push(callId);
      response.end('prepared');
    } else if (action === 'wait') {
      state.entered.push(callId);
      state.waiting.add(response);
      response.on('close', () => state.waiting.delete(response));
    } else response.writeHead(404).end();
  });
  let server: Awaited<ReturnType<typeof start>> | undefined;
  context.after(async () => {
    await Promise.all([...children].map(child => stop(child)));
    gate.closeAllConnections();
    if (gate.listening) await new Promise<void>(resolve => gate.close(() => resolve()));
    await rm(statePath, { recursive: true, force: true });
  });
  gate.listen(0, '127.0.0.1');
  await once(gate, 'listening');
  const address = gate.address();
  assert.ok(address && typeof address === 'object');
  const gateUrl = `http://127.0.0.1:${address.port}`;
  server = await start(statePath, token, gateUrl, children, context.signal);
  await context.test('public cloud extension recovers an interrupted submission and deletes its settled instance', async () => {
    await checkLifecycle(server!.url, token);
  });
  await context.test('bounded native submissions settle on timeout and exhausted recovery attempts', async () => {
    await checkBounded(server!.url, token);
  });
  await context.test('the standalone cloud contract runner verifies the probe and cleans up its Flue fixtures', async () => {
    await checkContracts(server!.url, token);
  });
  const id = `test-${crypto.randomUUID()}`;
  const payload = {
    message: { kind: 'user', body: 'hello' },
    initialData: { organizationId: 'fixture-company' },
    idempotencyKey: 'delivery-1',
  };

  async function request(path: string, body?: unknown) {
    const response = await fetch(`${server!.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = response.headers.get('content-type')?.includes('application/json')
      ? await response.json() as Record<string, any>
      : { body: await response.text() };
    return { response, data };
  }

  async function until(predicate: () => boolean, description: string, id?: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline && !context.signal.aborted) await delay(100);
    const snapshot = !predicate() && id ? await request(`/agents/probe/${id}`) : undefined;
    assert.ok(predicate(), `${description}\n${JSON.stringify(snapshot?.data ?? null).slice(0, 5000)}\n${server!.logs()}`);
  }

  function newGate() {
    const id = `gate-${crypto.randomUUID()}`;
    const state = { prepared: [] as string[], entered: [] as string[], waiting: new Set<ServerResponse>() };
    gates.set(id, state);
    return { id, state, payload: { message: 'fixture:gate', idempotencyKey: 'gate-input' } };
  }

  const admitted = await request(`/__probe/${id}/dispatch`, payload);
  assert.equal(admitted.response.status, 202, `${JSON.stringify(admitted.data)}\n${server.logs()}`);
  assert.equal(typeof admitted.data.submissionId, 'string');
  const submissionId = admitted.data.submissionId as string;

  await context.test('a lost receipt is recovered without appending a second input', async () => {
    const lostId = `lost-${crypto.randomUUID()}`;
    const body = { message: 'hello', idempotencyKey: 'lost-receipt' };
    // Wait for HTTP admission, but deliberately discard the receipt without parsing it.
    const lost = await fetch(`${server!.url}/__probe/${lostId}/dispatch`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    assert.equal(lost.status, 202);
    await lost.body?.cancel();
    const recovered = await request(`/__probe/${lostId}/dispatch`, body);
    assert.equal(recovered.response.status, 202);
    assert.equal(recovered.data.deduplicated, true);
    const reply = await request(`/__probe/${lostId}/reply/${recovered.data.submissionId}`);
    assert.equal(reply.response.status, 200);
    assert.equal(reply.data.submissionId, recovered.data.submissionId);
    const history = await request(`/agents/probe/${lostId}`);
    assert.equal(history.data.messages.filter((message: { role: string }) => message.role === 'user').length, 1);
  });

  await context.test('native idempotency keys reject empty and oversized values and accept 256 characters', async () => {
    const target = `keys-${crypto.randomUUID()}`;
    for (const key of ['', 'k'.repeat(257)]) {
      const invalid = await request(`/__probe/${target}/dispatch`, { message: 'hello', idempotencyKey: key });
      assert.equal(invalid.response.status, 400, JSON.stringify(invalid.data));
    }
    const body = { message: 'hello', idempotencyKey: 'k'.repeat(256) };
    const accepted = await request(`/__probe/${target}/dispatch`, body);
    assert.equal(accepted.response.status, 202);
    const replay = await request(`/__probe/${target}/dispatch`, body);
    assert.equal(replay.data.submissionId, accepted.data.submissionId);
    assert.equal(replay.data.deduplicated, true);
    assert.equal((await request(`/__probe/${target}/reply/${accepted.data.submissionId}`)).response.status, 200);
  });

  await context.test('the same key is isolated by the native instance target', async () => {
    const targets = [`tenant-a-${crypto.randomUUID()}`, `tenant-b-${crypto.randomUUID()}`];
    const receipts = await Promise.all(targets.map(target => request(`/__probe/${target}/dispatch`, {
      message: 'hello', idempotencyKey: 'shared-key',
    })));
    for (const receipt of receipts) assert.equal(receipt.response.status, 202);
    assert.notEqual(receipts[0].data.submissionId, receipts[1].data.submissionId);
    assert.notEqual(receipts[0].data.uid, receipts[1].data.uid);
    for (let index = 0; index < targets.length; index++) {
      const result = await request(`/__probe/${targets[index]}/reply/${receipts[index].data.submissionId}`);
      assert.equal(result.response.status, 200);
    }
  });

  await context.test('a terminal failure replays its original failed receipt, while a new key can complete', async () => {
    const target = `failure-${crypto.randomUUID()}`;
    const body = { message: 'fixture:failure', idempotencyKey: 'failure-input' };
    const accepted = await request(`/__probe/${target}/dispatch`, body);
    const result = await request(`/__probe/${target}/reply/${accepted.data.submissionId}`);
    assert.equal(result.response.status, 409, JSON.stringify(result.data));
    assert.deepEqual(result.data.error, { type: 'agent_run_failed', submissionId: accepted.data.submissionId });
    const replay = await request(`/__probe/${target}/dispatch`, body);
    assert.equal(replay.data.submissionId, accepted.data.submissionId);
    assert.equal(replay.data.acceptedAt, accepted.data.acceptedAt);
    assert.equal(replay.data.deduplicated, true);
    assert.equal((await request(`/__probe/${target}/reply/${replay.data.submissionId}`)).response.status, 409);
    const next = await request(`/__probe/${target}/dispatch`, { message: 'hello', idempotencyKey: 'new-run' });
    assert.notEqual(next.data.submissionId, accepted.data.submissionId);
    assert.equal((await request(`/__probe/${target}/reply/${next.data.submissionId}`)).response.status, 200);
  });

  await context.test('public observe exposes correlated live events without replacing durable reads', async () => {
    const target = `lifecycle-${crypto.randomUUID()}`;
    const endpoint = `/__probe/${target}/observations`;
    const empty = await request(endpoint);
    assert.equal(empty.response.status, 200);
    assert.deepEqual(empty.data.events, []);
    const body = { message: 'hello', idempotencyKey: 'observed-input' };
    const accepted = await request(`/__probe/${target}/dispatch`, body);
    assert.equal((await request(`/__probe/${target}/reply/${accepted.data.submissionId}`)).response.status, 200);
    await request(`/__probe/${target}/dispatch`, body);
    const observed = await request(endpoint);
    const events = observed.data.events as { type: string; v: number; eventIndex: number; timestamp: string; instanceId: string; submissionId: string }[];
    assert.ok(events.some(event => event.type === 'submission_running'));
    assert.ok(events.some(event => event.type === 'submission_settled'));
    for (const event of events) {
      assert.equal(event.v, 3);
      assert.equal(typeof event.eventIndex, 'number');
      assert.ok(Number.isFinite(Date.parse(event.timestamp)));
      assert.equal(event.instanceId, target);
      assert.equal(event.submissionId, accepted.data.submissionId);
    }
    assert.ok(events.filter(event => event.type === 'submission_queued').length >= 2);
    await stop(server!.child);
    children.delete(server!.child);
    server = await start(statePath, token, gateUrl, children, context.signal);
    assert.deepEqual((await request(endpoint)).data.events, [], 'observe does not replay durable history after restart');
    assert.equal((await request(`/__probe/${target}/reply/${accepted.data.submissionId}`)).response.status, 200);
  });

  await context.test('an async observer failure cannot change the durable submission outcome', async () => {
    const target = `lifecycle-${crypto.randomUUID()}`;
    const endpoint = `/__probe/${target}/observations/failure`;
    assert.equal((await request(endpoint, { enabled: true })).response.status, 200);
    const accepted = await request(`/__probe/${target}/dispatch`, { message: 'hello', idempotencyKey: 'observer-failure' });
    const reply = await request(`/__probe/${target}/reply/${accepted.data.submissionId}`);
    assert.equal(reply.response.status, 200);
    assert.equal(reply.data.text, 'fixture-ok');
    assert.equal((await request(endpoint, { enabled: false })).response.status, 200);
    const events = (await request(`/__probe/${target}/observations`)).data.events;
    assert.ok(events.some((event: { type: string }) => event.type === 'submission_settled'));
  });

  await context.test('a signal-blind tool times out without blocking the agent reply', async () => {
    const target = `tool-timeout-${crypto.randomUUID()}`;
    const began = performance.now();
    const accepted = await request(`/__probe/${target}/dispatch`, { message: 'fixture:tool-timeout', idempotencyKey: 'tool-timeout' });
    const reply = await request(`/__probe/${target}/reply/${accepted.data.submissionId}`);
    assert.equal(reply.response.status, 200);
    assert.equal(reply.data.text, 'fixture-tool-error');
    assert.ok(performance.now() - began < 2_000, 'The ignored signal must not defer settlement until the tool finishes.');
  });

  await context.test('a persisted takeover epoch rejects an old candidate after AI resumes and the process restarts', async () => {
    const target = `lifecycle-${crypto.randomUUID()}`;
    const endpoint = `/__probe/${target}/control`;
    const started = await request(`${endpoint}/run`, { message: 'fixture:cloud-gate' });
    assert.equal(started.response.status, 202);
    const old = started.data;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const state = await request(`/__probe/${target}/lifecycle`);
      if (state.data.gate.entered.length === 1) break;
      await delay(100);
    }
    assert.equal((await request(`/__probe/${target}/lifecycle`)).data.gate.entered.length, 1);
    const takeover = await request(`${endpoint}/mode`, { mode: 'human' });
    assert.equal(takeover.response.status, 200);
    assert.ok(takeover.data.epoch > old.context.epoch);
    assert.equal((await request(`${endpoint}/run`, { message: 'hello' })).response.status, 409);
    const resumed = await request(`${endpoint}/mode`, { mode: 'ai' });
    assert.ok(resumed.data.epoch > takeover.data.epoch);
    await request(`/__probe/${target}/lifecycle/release`, {});
    assert.equal((await request(`/__probe/${target}/reply/${old.receipt.submissionId}`)).response.status, 200);
    await stop(server!.child);
    children.delete(server!.child);
    server = await start(statePath, token, gateUrl, children, context.signal);
    const stale = await request(`${endpoint}/candidate`, { runId: old.context.runId });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.data.error.type, 'stale_candidate');
    assert.deepEqual(stale.data.context, old.context, 'stored run context must not be restamped');
    const next = await request(`${endpoint}/run`, { message: 'hello' });
    assert.equal(next.response.status, 202);
    assert.notEqual(next.data.context.runId, old.context.runId);
    const ready = await request(`${endpoint}/candidate`, { runId: next.data.context.runId });
    assert.equal(ready.response.status, 200);
    assert.equal(ready.data.accepted, true);
    assert.equal(ready.data.sent, false);
    const stillStale = await request(`${endpoint}/candidate`, { runId: old.context.runId, context: next.data.context });
    assert.equal(stillStale.response.status, 409);
    assert.deepEqual(stillStale.data.context, old.context);
  });

  await context.test('concurrent identical dispatches return the original durable receipt', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => request(`/__probe/${id}/dispatch`, payload)));
    for (const { response, data } of results) {
      assert.equal(response.status, 202, JSON.stringify(data));
      assert.equal(data.submissionId, submissionId);
      assert.equal(data.acceptedAt, admitted.data.acceptedAt);
      assert.equal(data.uid, admitted.data.uid);
      assert.equal(data.deduplicated, true);
    }
  });

  await context.test('cross-transport reuse conflicts instead of admitting another input', async () => {
    const { response, data } = await request(`/agents/probe/${id}`, {
      ...payload.message, initialData: payload.initialData, idempotencyKey: payload.idempotencyKey,
    });
    assert.equal(response.status, 409, JSON.stringify(data));
    assert.equal(data.error.type, 'submission_conflict');
  });

  await context.test('reusing a key with a changed payload is a visible conflict', async () => {
    const { response, data } = await request(`/__probe/${id}/dispatch`, { ...payload, message: 'changed' });
    assert.equal(response.status, 409);
    assert.equal(data.error.type, 'submission_conflict');
  });

  await context.test('the official faux model completes without a model credential', async () => {
    const { response, data } = await request(`/__probe/${id}/reply/${submissionId}`);
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.submissionId, submissionId);
    assert.equal(data.text, 'fixture-ok');
  });

  await stop(server.child);
  children.delete(server.child);
  server = await start(statePath, token, gateUrl, children, context.signal);

  await context.test('a fresh process reads the original result and deduplicates a lost receipt replay', async () => {
    const reply = await request(`/__probe/${id}/reply/${submissionId}`);
    assert.equal(reply.response.status, 200, JSON.stringify(reply.data));
    assert.equal(reply.data.text, 'fixture-ok');
    const replay = await request(`/__probe/${id}/dispatch`, payload);
    assert.equal(replay.response.status, 202, JSON.stringify(replay.data));
    assert.equal(replay.data.submissionId, submissionId);
    assert.equal(replay.data.deduplicated, true);
    const history = await request(`/agents/probe/${id}`);
    assert.equal(history.response.status, 200);
    assert.equal(history.data.messages.filter((message: { role: string }) => message.role === 'user').length, 1);
    assert.equal(history.data.messages.filter((message: { role: string }) => message.role === 'assistant').length, 1);
  });

  await context.test('abort settles a running tool and permits a new submission after settlement', async () => {
    const { id, state, payload } = newGate();
    const admitted = await request(`/__probe/${id}/dispatch`, payload);
    assert.equal(admitted.response.status, 202);
    await until(() => state.entered.length === 1, 'The fixture tool must be waiting before abort.', id);
    const aborted = await request(`/agents/probe/${id}/abort`, {});
    assert.equal(aborted.response.status, 200);
    assert.equal(aborted.data.aborted, true);
    const result = await request(`/__probe/${id}/reply/${admitted.data.submissionId}`);
    assert.equal(result.response.status, 409, JSON.stringify(result.data));
    assert.deepEqual(result.data.error, { type: 'agent_run_aborted', submissionId: admitted.data.submissionId });
    await until(() => state.waiting.size === 0, 'The aborted fetch must leave the gate.');
    const replay = await request(`/__probe/${id}/dispatch`, payload);
    assert.equal(replay.data.submissionId, admitted.data.submissionId);
    assert.equal(replay.data.deduplicated, true);
    const old = await request(`/__probe/${id}/reply/${admitted.data.submissionId}`);
    assert.equal(old.response.status, 409);
    const next = await request(`/__probe/${id}/dispatch`, { message: 'hello again', idempotencyKey: 'next-input' });
    assert.equal(next.response.status, 202);
    assert.notEqual(next.data.submissionId, admitted.data.submissionId);
    const reply = await request(`/__probe/${id}/reply/${next.data.submissionId}`);
    assert.equal(reply.response.status, 200, JSON.stringify(reply.data));
    assert.equal(reply.data.text, 'fixture-ok');
    assert.equal(state.prepared.length, 1);
    assert.equal(state.entered.length, 1);
  });

  await context.test('a killed process resumes an unfinished durable step without repeating the completed step', async () => {
    const { id, state, payload } = newGate();
    const admitted = await request(`/__probe/${id}/dispatch`, payload);
    assert.equal(admitted.response.status, 202);
    await until(() => state.entered.length === 1, 'The fixture tool must be waiting before SIGKILL.', id);
    assert.equal(state.prepared.length, 1);
    const callId = state.entered[0];
    await stop(server!.child, true);
    children.delete(server!.child);
    await until(() => state.waiting.size === 0, 'The killed process must release its old connection.');
    server = await start(statePath, token, gateUrl, children, context.signal);
    // A GET wakes the same instance; no second dispatch is allowed before recovery.
    const snapshot = await request(`/agents/probe/${id}`);
    assert.equal(snapshot.response.status, 200);
    // Allow the native 30-second recovery backstop, not only the immediate wake path.
    await until(() => state.entered.length >= 2, 'The same unfinished tool must resume after process restart.', id, 45_000);
    assert.deepEqual(state.prepared, [callId]);
    assert.deepEqual([...new Set(state.entered)], [callId]);
    for (const response of state.waiting) response.end('released');
    const reply = await request(`/__probe/${id}/reply/${admitted.data.submissionId}`);
    assert.equal(reply.response.status, 200, JSON.stringify(reply.data));
    assert.equal(reply.data.submissionId, admitted.data.submissionId);
    assert.equal(reply.data.text, 'fixture-ok');
    const history = await request(`/agents/probe/${id}`);
    assert.equal(history.data.messages.filter((message: { role: string }) => message.role === 'user').length, 1);
    assert.deepEqual(state.prepared, [callId]);
  });
});
