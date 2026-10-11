import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { AgentRunError, SubmissionConflictError } from '@flue/runtime';
import { assertSupportedFlueFormatVersion, FLUE_FORMAT_VERSION, PersistedFormatVersionError } from '@flue/runtime/adapter';
import { createProbeApp, type ProbeDependencies } from './src/create-app.ts';

const receipt = {
  submissionId: 'submission-fixture',
  acceptedAt: '2026-10-08T00:00:00.000Z',
  uid: 'instance-fixture',
};
const environment = { PROBE_TOKEN: 'fixture-token-for-tests' };
const authorization = { authorization: `Bearer ${environment.PROBE_TOKEN}` };

test('the public format guard accepts the pinned current version', () => {
  assert.equal(FLUE_FORMAT_VERSION, 1);
  assert.doesNotThrow(() => assertSupportedFlueFormatVersion(String(FLUE_FORMAT_VERSION)));
});

test('the public format guard explicitly rejects unknown and newer versions', () => {
  for (const stored of ['unknown', '0', '2', '8']) {
    assert.throws(() => assertSupportedFlueFormatVersion(stored), error => {
      assert.ok(error instanceof PersistedFormatVersionError);
      assert.equal(error.type, 'persisted_format_version_unsupported');
      return true;
    });
  }
  // A format marker "8" is not the separate legacy schema_version=8 adoption path.
});

function makeApp(overrides: Partial<ProbeDependencies> = {}) {
  const agentRouter = new Hono();
  agentRouter.post('/:id/abort', (context) => context.json({ id: context.req.param('id') }));
  return createProbeApp({
    agentRouter,
    dispatch: async () => receipt,
    read: async (_id, submissionId) => ({ text: 'fixture-ok', data: {}, submissionId }),
    ...overrides,
  });
}

test('health identifies the isolated Flue probe', async () => {
  const response = await makeApp().request('/api/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { service: 'dingbell-flue-probe', status: 'ok' });
});

test('mounts the supplied native agent router without rewriting abort', async () => {
  const response = await makeApp().request('/agents/probe/conversation-1/abort', {
    method: 'POST', headers: authorization,
  }, environment);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 'conversation-1' });
});

test('dispatch preserves the idempotency payload and uses the path instance id', async () => {
  let received: unknown;
  const app = makeApp({ dispatch: async (request) => { received = request; return receipt; } });
  const response = await app.request('/__probe/path-id/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorization },
    body: JSON.stringify({ id: 'body-id', message: 'hello', idempotencyKey: 'delivery-1' }),
  }, environment);
  assert.equal(response.status, 202);
  assert.deepEqual(received, { id: 'path-id', message: 'hello', idempotencyKey: 'delivery-1' });
  assert.deepEqual(await response.json(), receipt);
});

test('read delegates the original submission identifier and returns its reply', async () => {
  let received: unknown;
  const app = makeApp({ read: async (id, submissionId) => {
    received = { id, submissionId };
    return { text: 'fixture-ok', data: {}, submissionId };
  } });
  const response = await app.request('/__probe/conversation-1/reply/submission-1', {
    headers: authorization,
  }, environment);
  assert.equal(response.status, 200);
  assert.deepEqual(received, { id: 'conversation-1', submissionId: 'submission-1' });
  assert.deepEqual(await response.json(), { text: 'fixture-ok', data: {}, submissionId: 'submission-1' });
});

for (const outcome of ['failed', 'aborted'] as const) {
  test(`maps a settled ${outcome} read without exposing its error details`, async () => {
    const app = makeApp({ read: async (_id, submissionId) => {
      const error = new AgentRunError({
        outcome,
        submissionId,
        cause: new Error('private provider failure and credential'),
      });
      error.message = 'private run message';
      throw error;
    } });
    const response = await app.request('/__probe/conversation-1/reply/submission-1', {
      headers: authorization,
    }, environment);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: {
      type: `agent_run_${outcome}`,
      submissionId: 'submission-1',
    } });
  });
}

test('preserves the native submission conflict type and HTTP status', async () => {
  const app = makeApp({ dispatch: async () => {
    throw new SubmissionConflictError({ submissionId: receipt.submissionId });
  } });
  const response = await app.request('/__probe/conversation-1/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorization },
    body: JSON.stringify({ message: 'different', idempotencyKey: 'delivery-1' }),
  }, environment);
  assert.equal(response.status, 409);
  const body = await response.json() as { error: Record<string, unknown> };
  assert.equal(body.error.type, 'submission_conflict');
  assert.equal('stack' in body.error, false);
  assert.equal('cause' in body.error, false);
});

test('does not expose untyped exception details or stack traces', async () => {
  const app = makeApp({ read: async () => { throw new Error('private fixture failure'); } });
  const response = await app.request('/__probe/conversation-1/reply/submission-1', {
    headers: authorization,
  }, environment);
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.equal(JSON.parse(body).error.type, 'internal_error');
  assert.equal(body.includes('private fixture failure'), false);
  assert.equal(body.includes('stack'), false);
});

const protectedRoutes = [
  { name: 'dispatch', method: 'POST', path: '/__probe/conversation-1/dispatch' },
  { name: 'read', method: 'GET', path: '/__probe/conversation-1/reply/submission-1' },
  { name: 'native abort', method: 'POST', path: '/agents/probe/conversation-1/abort' },
];

for (const scenario of [
  { name: 'missing bearer token', headers: {} as Record<string, string>, env: environment, status: 401 },
  { name: 'incorrect bearer token', headers: { authorization: 'Bearer incorrect-token' }, env: environment, status: 401 },
  { name: 'missing server secret', headers: authorization, env: {}, status: 503 },
  { name: 'empty server secret', headers: authorization, env: { PROBE_TOKEN: '' }, status: 503 },
]) {
  for (const route of protectedRoutes) {
    test(`${scenario.name} blocks ${route.name} before reaching the runtime`, async () => {
      const calls: string[] = [];
      const agentRouter = new Hono();
      agentRouter.post('/:id/abort', (context) => {
        calls.push('abort');
        return context.json({ ok: true });
      });
      const app = makeApp({
        agentRouter,
        dispatch: async () => { calls.push('dispatch'); return receipt; },
        read: async (_id, submissionId) => {
          calls.push('read');
          return { text: 'fixture-ok', data: {}, submissionId };
        },
      });
      const response = await app.request(route.path, {
        method: route.method,
        headers: { 'content-type': 'application/json', ...scenario.headers },
        ...(route.method === 'POST' ? { body: JSON.stringify({ message: 'hello' }) } : {}),
      }, scenario.env);
      assert.equal(response.status, scenario.status);
      assert.deepEqual(calls, []);
      if (scenario.status === 401) assert.match(response.headers.get('WWW-Authenticate') ?? '', /^Bearer/);
      assert.equal((await response.text()).includes(environment.PROBE_TOKEN), false);
    });
  }
}
