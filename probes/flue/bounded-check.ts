import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { DispatchReceipt } from '@flue/runtime';

interface Inspection {
  exists: boolean;
  bootId: string;
  interruption: { nonce: string; previousBootId: string } | null;
  gate: { entered: string[]; prepared: string[] };
  events: { type: string; errorType?: string; attemptCount?: number; maxAttempts?: number }[];
}

// The bounded agent has its own identity: the existing recovery probe keeps its defaults.
export async function checkBounded(origin: string, token: string) {
  const evidence = [];
  for (const mode of ['timeout', 'attempts'] as const) {
    const id = `lifecycle-${crypto.randomUUID()}`;
    const path = `/__probe/${id}/bounded`;
    async function request(route: string, body?: unknown, authorization = `Bearer ${token}`) {
      return fetch(new URL(path + route, origin), {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal: AbortSignal.timeout(60_000),
      });
    }
    async function json<T>(route: string, body?: unknown, status = 200): Promise<T> {
      const response = await request(route, body);
      assert.equal(response.status, status, `${mode}${route}: ${response.status}`);
      return response.json() as Promise<T>;
    }
    async function until(predicate: (state: Inspection) => boolean) {
      const deadline = Date.now() + 60_000;
      let state = await json<Inspection>('/inspection');
      while (!predicate(state) && Date.now() < deadline) {
        await delay(100);
        state = await json<Inspection>('/inspection');
      }
      assert.ok(predicate(state), JSON.stringify(state));
      return state;
    }
    for (const auth of ['', 'Bearer wrong-token']) {
      for (const [route, body] of [['/dispatch', {}], ['/inspection', undefined], ['/interrupt', {}], ['/destroy', {}]] as const) {
        assert.equal((await request(route, body, auth)).status, 401);
      }
    }
    const began = Date.now();
    const receipt = await json<DispatchReceipt>('/dispatch', {}, 202);
    const before = await until(state => state.gate.entered.length === 1);
    assert.ok(before.events.some(event => event.type === 'submission_running' && event.attemptCount === 1));
    // Flue 2.2.2 emits the first running event before applying Agent durability:
    // its maxAttempts can still be the admission default (10), not this Agent's 1.
    // Preserve that evidence; verify the enforced limit by terminal failure below.
    let interruption: Inspection | undefined;
    if (mode === 'attempts') {
      const nonce = crypto.randomUUID();
      assert.equal((await request('/interrupt', { nonce })).status, 500);
      interruption = await until(state => state.bootId !== before.bootId);
      assert.deepEqual(interruption.interruption, { nonce, previousBootId: before.bootId });
    }
    const result = await json<{ error: { type: string; submissionId: string } }>(`/reply/${receipt.submissionId}`, undefined, 409);
    const settledAt = Date.now();
    assert.deepEqual(result.error, { type: 'agent_run_failed', submissionId: receipt.submissionId });
    const settled = await until(state => state.events.some(event => event.type === 'submission_settled'));
    const reason = settled.events.find(event => event.type === 'submission_settled')?.errorType;
    assert.equal(reason, mode === 'timeout' ? 'submission_timeout' : 'submission_retry_exhausted');
    assert.equal(settled.gate.prepared.length, 1);
    assert.equal(settled.gate.entered.length, 1, 'The exhausted attempt must not start the unfinished tool again.');
    const replay = await json<DispatchReceipt>('/dispatch', {}, 202);
    assert.equal(replay.submissionId, receipt.submissionId);
    assert.equal(replay.deduplicated, true);
    assert.equal((await request(`/reply/${receipt.submissionId}`)).status, 409);
    const destroy = await request('/destroy', { submissionId: receipt.submissionId });
    assert.ok([200, 500].includes(destroy.status));
    const removed = await until(state => !state.exists && state.bootId !== settled.bootId);
    assert.equal(removed.interruption, null);
    assert.equal((await request(`/reply/${receipt.submissionId}`)).status, 404);
    evidence.push({
      mode, id, receipt, reason, configuredTimeoutMs: 3_000,
      settledAfterMs: settledAt - began,
      deadlinePassedMs: settledAt - Date.parse(receipt.acceptedAt) - 3_000,
      before, interruption, settled, destroyStatus: destroy.status, removed,
    });
  }
  return evidence;
}
