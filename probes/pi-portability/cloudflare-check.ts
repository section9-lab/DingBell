import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

interface GateState {
  models: number;
  prepared: string[];
  waiting: { callId: string; bootId: string }[];
  released: boolean;
  interruption: { bootId: string; nonce: string } | null;
}
interface Receipt { operationId: string; session: string; accepted: boolean }
interface Result { result: { operationId: string; status: string; text?: string; reason?: string }; bootId: string; userEntries: number }

export async function checkCloudflare(origin: string, token: string) {
  const base = new URL(origin);
  const loopback = base.protocol === 'http:' && base.hostname === '127.0.0.1';
  const isolatedCloud = base.protocol === 'https:' && /^dingbell-pi-portability-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(base.hostname);
  assert.ok(loopback || isolatedCloud, 'Only loopback or the dedicated portability fixture is allowed.');
  async function request<T>(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(new URL(path, base), {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, data: await response.json() as T };
  }
  const unauthorizedPath = new URL(`/cases/${crypto.randomUUID()}/gate`, base);
  let unauthorizedStatus = 0;
  let unauthorizedBody = '';
  const authReadyUntil = Date.now() + 30_000;
  while (Date.now() < authReadyUntil) {
    const unauthorized = await fetch(unauthorizedPath, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    unauthorizedStatus = unauthorized.status;
    unauthorizedBody = (await unauthorized.text()).slice(0, 1000);
    if (unauthorizedStatus === 401) break;
    await delay(1000);
  }
  assert.equal(unauthorizedStatus, 401, `Unauthenticated probe response: ${unauthorizedBody}`);
  const id = crypto.randomUUID(), path = `/cases/${id}`, operationId = 'stable-fixture-input';
  const draft = { input: 'synthetic-fixture-input', operationId };
  const [one, two] = await Promise.all([
    request<Receipt>(`${path}/submit`, 'POST', draft), request<Receipt>(`${path}/submit`, 'POST', draft),
  ]);
  assert.equal(one.status, 202, JSON.stringify(one.data));
  assert.equal(two.status, 202, JSON.stringify(two.data));
  assert.equal(one.data.operationId, two.data.operationId);
  assert.equal(one.data.session, two.data.session);
  assert.equal(Number(one.data.accepted) + Number(two.data.accepted), 1);
  const conflict = await request<Receipt>(`${path}/submit`, 'POST', { ...draft, input: 'different-synthetic-content' });
  assert.equal(conflict.status, 202);
  assert.equal(conflict.data.accepted, false);
  async function untilGate(predicate: (state: GateState) => boolean, description: string, timeoutMs = 90_000) {
    const end = Date.now() + timeoutMs;
    let latest: GateState | undefined;
    while (Date.now() < end) {
      const read = await request<GateState>(`${path}/gate`);
      assert.equal(read.status, 200);
      latest = read.data;
      if (predicate(latest)) return latest;
      await delay(250);
    }
    throw new Error(`${description}: ${JSON.stringify(latest)}`);
  }
  const before = await untilGate(state => state.waiting.length === 1, 'initial tool wait');
  assert.equal(before.prepared.length, 1);
  const interruption = await request(`${path}/interrupt`, 'POST');
  assert.equal(interruption.status, 500, 'object reset interrupts its RPC response');
  // Poll only the separate Gate DO: these reads cannot wake the Pi session.
  const recovered = await untilGate(state => state.waiting.length >= 2, 'alarm-only PiHarness recovery');
  assert.equal(recovered.prepared.length, 1);
  assert.ok(recovered.interruption?.nonce);
  assert.equal(recovered.interruption.bootId, before.waiting[0].bootId);
  assert.notEqual(recovered.waiting[1].bootId, before.waiting[0].bootId);
  assert.equal(recovered.waiting[1].callId, before.waiting[0].callId);
  await request(`${path}/release`, 'POST');
  const complete = await request<Result>(`${path}/result?operationId=${operationId}`);
  assert.equal(complete.status, 200, JSON.stringify(complete.data));
  assert.equal(complete.data.result.status, 'done');
  assert.equal(complete.data.result.text, 'fixture-ok');
  assert.equal(complete.data.userEntries, 1);
  const calls = (await request<GateState>(`${path}/gate`)).data.models;
  await request(`${path}/interrupt`, 'POST');
  const reopened = await request<Result>(`${path}/result?operationId=${operationId}`);
  assert.equal(reopened.status, 200, JSON.stringify(reopened.data));
  assert.equal(reopened.data.result.status, 'done');
  assert.equal(reopened.data.result.text, 'fixture-ok');
  assert.notEqual(reopened.data.bootId, complete.data.bootId);
  assert.equal((await request<GateState>(`${path}/gate`)).data.models, calls);

  const abortId = crypto.randomUUID(), abortPath = `/cases/${abortId}`, abortOperation = 'abort-fixture-input';
  await request<Receipt>(`${abortPath}/submit`, 'POST', { ...draft, operationId: abortOperation });
  const abortEnd = Date.now() + 20_000;
  while (Date.now() < abortEnd) {
    const gate = await request<GateState>(`${abortPath}/gate`);
    if (gate.data.waiting.length) break;
    await delay(100);
  }
  assert.equal((await request<GateState>(`${abortPath}/gate`)).data.waiting.length, 1);
  const aborted = await request<{ aborted: boolean }>(`${abortPath}/abort?operationId=${abortOperation}`, 'POST');
  assert.equal(aborted.status, 200);
  assert.equal(aborted.data.aborted, true);
  const abortResult = await request<Result>(`${abortPath}/result?operationId=${abortOperation}`);
  assert.equal(abortResult.status, 200);
  assert.equal(abortResult.data.result.status, 'unanswered');
  assert.equal(abortResult.data.result.reason, 'aborted');

  return {
    environment: loopback ? 'local-workerd' : 'cloudflare-workers',
    checks: ['authentication', 'concurrent-idempotency', 'alarm-only-interruption-recovery', 'completed-tool-not-replayed', 'stable-tool-task-id', 'terminal-object-reset', 'abort-settlement'],
    nativeConflictingPayload: 'accepted_as_original', modelCalls: calls,
    completedCase: { id, operationId }, abortedCase: { id: abortId, operationId: abortOperation },
  };
}

export async function checkRedeployment(origin: string, token: string, evidence: Awaited<ReturnType<typeof checkCloudflare>>) {
  const read = async (path: string) => {
    const response = await fetch(new URL(path, origin), { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, 200);
    return response.json() as Promise<Result & GateState>;
  };
  const complete = await read(`/cases/${evidence.completedCase.id}/result?operationId=${evidence.completedCase.operationId}`);
  assert.equal(complete.result.status, 'done');
  assert.equal(complete.result.text, 'fixture-ok');
  assert.equal(complete.userEntries, 1);
  const gate = await read(`/cases/${evidence.completedCase.id}/gate`);
  assert.equal(gate.models, evidence.modelCalls);
  const aborted = await read(`/cases/${evidence.abortedCase.id}/result?operationId=${evidence.abortedCase.operationId}`);
  assert.equal(aborted.result.status, 'unanswered');
  assert.equal(aborted.result.reason, 'aborted');
  return { originalCompletedReceiptPreserved: true, originalAbortedReceiptPreserved: true, additionalModelCalls: 0 };
}
