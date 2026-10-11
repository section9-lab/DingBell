import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentReply, DispatchReceipt } from '@flue/runtime';
import type { ProbeRunContext } from './src/cloudflare.ts';

// Runs the same cloud-facing checks locally before the operator deploys the probe.
// Native target isolation here is not a substitute for later tenant authorization tests.
export async function checkContracts(origin: string, token: string) {
  const cleanup = new Map<string, string>();
  const evidence: Record<string, unknown> = {};
  const newId = () => `lifecycle-${crypto.randomUUID()}`;
  async function request(path: string, body?: unknown, authorization = `Bearer ${token}`) {
    return fetch(new URL(path, origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: AbortSignal.timeout(60_000),
    });
  }
  async function json<T>(path: string, body?: unknown, status = 200): Promise<T> {
    const response = await request(path, body);
    assert.equal(response.status, status, `${path}: ${response.status}`);
    return response.json() as Promise<T>;
  }
  async function dispatch(id: string, message = 'hello', key = 'contract-input') {
    return json<DispatchReceipt>(`/__probe/${id}/dispatch`, { message, idempotencyKey: key }, 202);
  }
  async function read(id: string, receipt: DispatchReceipt) {
    const reply = await json<AgentReply>(`/__probe/${id}/reply/${receipt.submissionId}`);
    assert.equal(reply.submissionId, receipt.submissionId);
    cleanup.set(id, receipt.submissionId);
    return reply;
  }

  const lostId = newId();
  const lost = await request(`/__probe/${lostId}/dispatch`, { message: 'hello', idempotencyKey: 'lost-receipt' });
  assert.equal(lost.status, 202);
  await lost.body?.cancel();
  const recovered = await dispatch(lostId, 'hello', 'lost-receipt');
  assert.equal(recovered.deduplicated, true);
  await read(lostId, recovered);
  const history = await json<{ messages: { role: string }[] }>(`/agents/probe/${lostId}`);
  assert.equal(history.messages.filter(message => message.role === 'user').length, 1);
  evidence.lostReceipt = { id: lostId, receipt: recovered, userInputs: 1 };

  const keyId = newId();
  for (const key of ['', 'k'.repeat(257)]) {
    assert.equal((await request(`/__probe/${keyId}/dispatch`, { message: 'hello', idempotencyKey: key })).status, 400);
  }
  const boundary = await dispatch(keyId, 'hello', 'k'.repeat(256));
  const boundaryReplay = await dispatch(keyId, 'hello', 'k'.repeat(256));
  assert.equal(boundaryReplay.submissionId, boundary.submissionId);
  assert.equal(boundaryReplay.deduplicated, true);
  await read(keyId, boundary);
  evidence.keyBoundary = { rejectedLengths: [0, 257], acceptedLength: 256, receipt: boundary };

  const targets = [newId(), newId()];
  const isolated = await Promise.all(targets.map(id => dispatch(id, 'hello', 'same-key')));
  assert.notEqual(isolated[0].submissionId, isolated[1].submissionId);
  assert.notEqual(isolated[0].uid, isolated[1].uid);
  for (let index = 0; index < targets.length; index++) await read(targets[index], isolated[index]);
  evidence.targetIsolation = { targets, receipts: isolated };

  const failedId = newId();
  const failed = await dispatch(failedId, 'fixture:failure');
  const failure = await json<{ error: { type: string; submissionId: string } }>(`/__probe/${failedId}/reply/${failed.submissionId}`, undefined, 409);
  assert.deepEqual(failure.error, { type: 'agent_run_failed', submissionId: failed.submissionId });
  const replay = await dispatch(failedId, 'fixture:failure');
  assert.equal(replay.submissionId, failed.submissionId);
  assert.equal(replay.deduplicated, true);
  assert.equal((await request(`/__probe/${failedId}/reply/${failed.submissionId}`)).status, 409);
  const fresh = await dispatch(failedId, 'hello', 'new-run');
  assert.notEqual(fresh.submissionId, failed.submissionId);
  await read(failedId, fresh);
  evidence.failedReplay = { id: failedId, original: failed, replay, fresh };

  const observedId = newId();
  const observedPath = `/__probe/${observedId}/observations`;
  for (const auth of ['', 'Bearer wrong-token']) {
    for (const [path, body] of [[observedPath, undefined], [`${observedPath}/failure`, { enabled: true }], [`/__probe/${observedId}/control/run`, { message: 'hello' }], [`/__probe/${observedId}/control/mode`, { mode: 'human' }], [`/__probe/${observedId}/control/candidate`, {}]] as const) {
      assert.equal((await request(path, body, auth)).status, 401);
    }
  }
  await json(`${observedPath}/failure`, { enabled: true });
  const observed = await dispatch(observedId, 'fixture-body-must-not-be-retained');
  assert.equal((await read(observedId, observed)).text, 'fixture-ok');
  await dispatch(observedId, 'fixture-body-must-not-be-retained');
  await json(`${observedPath}/failure`, { enabled: false });
  const events = await json<{ events: { type: string; v: number; instanceId: string; submissionId: string }[] }>(observedPath);
  assert.ok(events.events.some(event => event.type === 'submission_settled'));
  assert.ok(events.events.filter(event => event.type === 'submission_queued').length >= 2);
  for (const event of events.events) {
    assert.equal(event.v, 3);
    assert.equal(event.instanceId, observedId);
    assert.equal(event.submissionId, observed.submissionId);
  }
  assert.equal(JSON.stringify(events).includes('fixture-body-must-not-be-retained'), false);
  assert.equal(JSON.stringify(events).includes(token), false);
  evidence.observation = { id: observedId, receipt: observed, ...events };

  const controlledId = newId();
  const path = `/__probe/${controlledId}/control`;
  const old = await json<{ context: ProbeRunContext; receipt: DispatchReceipt }>(`${path}/run`, { message: 'fixture:cloud-gate' }, 202);
  const deadline = Date.now() + 30_000;
  let gate: { gate: { entered: string[] } };
  do {
    gate = await json(`/__probe/${controlledId}/lifecycle`);
    if (gate.gate.entered.length === 1) break;
    await delay(100);
  } while (Date.now() < deadline);
  assert.equal(gate.gate.entered.length, 1);
  const takeover = await json<{ epoch: number }>(`${path}/mode`, { mode: 'human' });
  assert.ok(takeover.epoch > old.context.epoch);
  assert.equal((await request(`${path}/run`, { message: 'hello' })).status, 409);
  const resumed = await json<{ epoch: number }>(`${path}/mode`, { mode: 'ai' });
  assert.ok(resumed.epoch > takeover.epoch);
  await json(`/__probe/${controlledId}/lifecycle/release`, {});
  await read(controlledId, old.receipt);
  const stale = await json<{ context: ProbeRunContext; error: { type: string } }>(`${path}/candidate`, { runId: old.context.runId }, 409);
  assert.equal(stale.error.type, 'stale_candidate');
  assert.deepEqual(stale.context, old.context);
  const current = await json<{ context: ProbeRunContext; receipt: DispatchReceipt }>(`${path}/run`, { message: 'hello' }, 202);
  const ready = await json<{ accepted: boolean; sent: boolean }>(`${path}/candidate`, { runId: current.context.runId });
  assert.deepEqual({ accepted: ready.accepted, sent: ready.sent }, { accepted: true, sent: false });
  const forged = await json<{ context: ProbeRunContext }>(`${path}/candidate`, { runId: old.context.runId, context: current.context }, 409);
  assert.deepEqual(forged.context, old.context);
  cleanup.set(controlledId, current.receipt.submissionId);
  evidence.takeover = { id: controlledId, old, takeover, resumed, current, ready };

  // Remove Flue instances only. Application-owned Gate evidence intentionally survives.
  for (const [id, submissionId] of cleanup) {
    await json(`/__probe/${id}/lifecycle/release`, {});
    const response = await request(`/__probe/${id}/lifecycle/destroy`, { submissionId });
    assert.ok([200, 500].includes(response.status));
    let state = await json<{ exists: boolean }>(`/__probe/${id}/lifecycle`);
    const deadline = Date.now() + 10_000;
    while (state.exists && Date.now() < deadline) {
      await delay(100);
      state = await json(`/__probe/${id}/lifecycle`);
    }
    assert.equal(state.exists, false);
    const missing = await json<{ error: { type: string } }>(`/__probe/${id}/reply/${submissionId}`, undefined, 404);
    assert.equal(missing.error.type, 'agent_instance_not_found');
  }
  return { ...evidence, removedFlueInstances: [...cleanup.keys()], checkedAt: new Date().toISOString() };
}
