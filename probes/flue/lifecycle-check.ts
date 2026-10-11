import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentReply, DispatchReceipt } from '@flue/runtime';

interface Inspection {
  exists: boolean;
  bootId: string;
  interruption: { nonce: string; previousBootId: string } | null;
  gate: { callId: string | null; prepared: string[]; entered: string[]; released: boolean };
}

// The same assertions run against local workerd and the isolated cloud Worker.
export async function checkLifecycle(origin: string, token: string) {
  const id = `lifecycle-${crypto.randomUUID()}`;
  const control = `/__probe/${id}/lifecycle`;
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
    assert.equal(response.status, status, `${path}: ${response.status} ${response.status === status ? '' : await response.text()}`);
    return response.json() as Promise<T>;
  }
  async function inspectUntil(predicate: (state: Inspection) => boolean) {
    const deadline = Date.now() + 60_000;
    let state = await json<Inspection>(control);
    while (!predicate(state) && Date.now() < deadline) {
      await delay(300);
      state = await json<Inspection>(control);
    }
    assert.ok(predicate(state), `Lifecycle condition timed out: ${JSON.stringify(state)}`);
    return state;
  }

  for (const authorization of ['', 'Bearer incorrect-token']) {
    for (const [path, body] of [[control, undefined], [`${control}/interrupt`, {}], [`${control}/release`, {}], [`${control}/destroy`, {}]] as const) {
      assert.equal((await request(path, body, authorization)).status, 401);
    }
  }
  assert.equal((await request('/__probe/not-a-lifecycle-fixture/lifecycle/destroy', {})).status, 400);
  const empty = await json<Inspection>(control);
  assert.equal(empty.exists, false);
  assert.deepEqual(empty.gate, { callId: null, prepared: [], entered: [], released: false });
  const receipt = await json<DispatchReceipt>(`/__probe/${id}/dispatch`, {
    message: 'fixture:cloud-gate', idempotencyKey: 'lifecycle-input',
  }, 202);
  const before = await inspectUntil(state => state.gate.entered.length === 1);
  assert.equal(before.gate.prepared.length, 1);
  assert.equal(before.gate.released, false);
  assert.equal(before.exists, true);
  // A running fixture must not be destroyed by this sequential test controller.
  assert.equal((await request(`${control}/destroy`, { submissionId: receipt.submissionId })).status, 409);
  assert.equal((await request(`${control}/interrupt`, { nonce: '' })).status, 400);
  const nonce = crypto.randomUUID();
  const injected = await request(`${control}/interrupt`, { nonce });
  // ctx.abort terminates its RPC. An error alone is not evidence of interruption.
  assert.equal(injected.status, 500);
  const after = await inspectUntil(state => state.gate.entered.length >= 2);
  assert.notEqual(after.bootId, before.bootId);
  assert.deepEqual(after.interruption, { nonce, previousBootId: before.bootId });
  assert.equal(after.gate.callId, before.gate.callId);
  assert.deepEqual(after.gate.prepared, before.gate.prepared);
  assert.equal(new Set(after.gate.entered).size, after.gate.entered.length);
  assert.equal(after.gate.released, false);
  await json(`${control}/release`, {});
  const reply = await json<AgentReply>(`/__probe/${id}/reply/${receipt.submissionId}`);
  assert.equal(reply.submissionId, receipt.submissionId);
  assert.equal(reply.text, 'fixture-ok');
  const history = await json<{ messages: { role: string }[] }>(`/agents/probe/${id}`);
  assert.equal(history.messages.filter(message => message.role === 'user').length, 1);
  const destroyed = await request(`${control}/destroy`, { submissionId: receipt.submissionId });
  // SDK destroy also aborts the object. Cloud RPC can fail after storage was removed.
  // Neither a 200 nor a 500 proves deletion; the independent checks below must pass.
  assert.ok([200, 500].includes(destroyed.status), `Unexpected destroy response: ${destroyed.status}`);
  const removed = await inspectUntil(state => !state.exists && state.bootId !== after.bootId);
  assert.equal(removed.interruption, null);
  const missing = await json<{ error: { type: string } }>(`/__probe/${id}/reply/${receipt.submissionId}`, undefined, 404);
  assert.equal(missing.error.type, 'agent_instance_not_found');
  // Never dispatch again here: an unconditional send intentionally creates a new instance.
  return { id, receipt, before, after, destroyStatus: destroyed.status, removed, checkedAt: new Date().toISOString() };
}
