import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import type { AgentReply, DispatchReceipt } from '@flue/runtime';
import { checkLifecycle } from './lifecycle-check.ts';
import { checkBounded } from './bounded-check.ts';
import { checkContracts } from './contracts-check.ts';

// Run before and after a separate, explicit Wrangler deployment. This script never deploys.
const [phase, endpoint, checkpoint] = process.argv.slice(2);
assert.ok(['before', 'after', 'lifecycle', 'removed', 'bounded', 'contracts'].includes(phase!), 'Use: cloud-check.ts before|after|lifecycle|removed|bounded|contracts URL CHECKPOINT');
assert.ok(endpoint && checkpoint && process.env.DINGBELL_PROBE_SECRET_FILE, 'URL, checkpoint and secret file are required.');
const url = new URL(endpoint);
assert.equal(url.protocol, 'https:');
assert.ok(url.hostname.startsWith('dingbell-flue-probe.') && url.hostname.endsWith('.workers.dev'));
assert.equal(url.origin + '/', url.href, 'Use the probe origin only.');
const { PROBE_TOKEN: token } = JSON.parse(await readFile(process.env.DINGBELL_PROBE_SECRET_FILE, 'utf8'));
assert.ok(typeof token === 'string' && token.length >= 32, 'A random probe secret is required.');

async function request(path: string, body?: unknown, authorization = `Bearer ${token}`) {
  return fetch(new URL(path, url), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
}

async function json<T>(path: string, body?: unknown, status = 200): Promise<T> {
  const response = await request(path, body);
  assert.equal(response.status, status, `${path} returned ${response.status}`);
  return response.json() as Promise<T>;
}

async function assertHistory(id: string) {
  const history = await json<{ messages: { role: string }[] }>(`/agents/probe/${id}`);
  assert.equal(history.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(history.messages.filter(message => message.role === 'assistant').length, 1);
}

if (phase === 'contracts') {
  const evidence = await checkContracts(url.origin, token);
  await writeFile(checkpoint, JSON.stringify({ url: url.origin, ...evidence }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ phase, status: 'passed', checkedAt: evidence.checkedAt, checks: ['lost receipt replay', 'key boundaries', 'native target isolation', 'failed receipt replay', 'live observe and contained subscriber failure', 'persistent takeover rejects stale candidate', 'Flue fixture cleanup'], checkpoint }));
} else if (phase === 'bounded') {
  const evidence = await checkBounded(url.origin, token);
  await writeFile(checkpoint, JSON.stringify({ url: url.origin, evidence }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ phase, status: 'passed', checks: ['native submission timeout', 'native attempt exhaustion after ctx.abort', 'terminal failed replay', 'settled fixture deletion'], checkpoint }));
} else if (phase === 'lifecycle') {
  const evidence = await checkLifecycle(url.origin, token);
  await writeFile(checkpoint, JSON.stringify({ url: url.origin, ...evidence }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ phase, status: 'passed', checkedAt: evidence.checkedAt, checks: ['authorized fixture-only controls', 'durable interruption marker and changed boot', 'same tool resumed without repeating prepare', 'original submission settled', 'public destroy and cold lookup missing'], checkpoint }));
} else if (phase === 'removed') {
  const saved = JSON.parse(await readFile(checkpoint, 'utf8')) as { url: string; id: string; receipt: DispatchReceipt };
  assert.equal(saved.url, url.origin);
  const inspection = await json<{ exists: boolean; interruption: unknown }>(`/__probe/${saved.id}/lifecycle`);
  assert.equal(inspection.exists, false);
  assert.equal(inspection.interruption, null);
  const missing = await json<{ error: { type: string } }>(`/__probe/${saved.id}/reply/${saved.receipt.submissionId}`, undefined, 404);
  assert.equal(missing.error.type, 'agent_instance_not_found');
  console.log(JSON.stringify({ phase, status: 'passed', checkedAt: new Date().toISOString(), checks: ['deleted instance remains absent after redeployment', 'old submission is unreadable'] }));
} else if (phase === 'before') {
  // Do not overwrite the receipt needed to verify an earlier deployment.
  const id = `cloud-${crypto.randomUUID()}`;
  const payload = {
    message: { kind: 'user', body: 'hello from the isolated cloud fixture' },
    initialData: { organizationId: 'fixture-company' },
    idempotencyKey: 'delivery-1',
  };
  for (const authorization of ['', 'Bearer wrong-token']) {
    for (const [path, body] of [
      [`/__probe/${id}/dispatch`, payload],
      [`/__probe/${id}/reply/not-a-submission`, undefined],
      [`/agents/probe/${id}/abort`, {}],
      [`/agents/probe/${id}`, undefined],
    ] as const) {
      assert.equal((await request(path, body, authorization)).status, 401);
    }
  }
  const receipt = await json<DispatchReceipt>(`/__probe/${id}/dispatch`, payload, 202);
  const reply = await json<AgentReply>(`/__probe/${id}/reply/${receipt.submissionId}`);
  assert.equal(reply.text, 'fixture-ok');
  assert.equal(reply.submissionId, receipt.submissionId);
  const copies = await Promise.all(Array.from({ length: 4 }, () => json<DispatchReceipt>(`/__probe/${id}/dispatch`, payload, 202)));
  for (const copy of copies) {
    assert.equal(copy.submissionId, receipt.submissionId);
    assert.equal(copy.uid, receipt.uid);
    assert.equal(copy.acceptedAt, receipt.acceptedAt);
    assert.equal(copy.deduplicated, true);
  }
  const changed = await json<{ error: { type: string } }>(`/__probe/${id}/dispatch`, { ...payload, message: 'changed' }, 409);
  assert.equal(changed.error.type, 'submission_conflict');
  const cross = await json<{ error: { type: string } }>(`/agents/probe/${id}`, { ...payload.message, initialData: payload.initialData, idempotencyKey: payload.idempotencyKey }, 409);
  assert.equal(cross.error.type, 'submission_conflict');
  await assertHistory(id);
  await writeFile(checkpoint, JSON.stringify({ url: url.origin, id, payload, receipt, text: reply.text, checkedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ phase, status: 'passed', checks: ['missing/wrong token rejected', 'native dispatch and read', 'concurrent deduplication', 'payload and transport conflict', 'single input and reply'], checkpoint }));
} else {
  const saved = JSON.parse(await readFile(checkpoint, 'utf8')) as {
    url: string; id: string; receipt: DispatchReceipt; payload: unknown; text: string;
  };
  assert.equal(saved.url, url.origin);
  // Read first: replaying POST first could conceal an accidentally regenerated result.
  const reply = await json<AgentReply>(`/__probe/${saved.id}/reply/${saved.receipt.submissionId}`);
  assert.equal(reply.submissionId, saved.receipt.submissionId);
  assert.equal(reply.text, saved.text);
  const replay = await json<DispatchReceipt>(`/__probe/${saved.id}/dispatch`, saved.payload, 202);
  assert.equal(replay.submissionId, saved.receipt.submissionId);
  assert.equal(replay.uid, saved.receipt.uid);
  assert.equal(replay.acceptedAt, saved.receipt.acceptedAt);
  assert.equal(replay.deduplicated, true);
  await assertHistory(saved.id);
  console.log(JSON.stringify({ phase, status: 'passed', checkedAt: new Date().toISOString(), checks: ['read original result before replay', 'original receipt deduplicated', 'history unchanged'] }));
}
