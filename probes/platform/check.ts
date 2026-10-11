import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

interface JobState {
  deliveries: number;
  attempts: number[];
  effectCount: number;
  deadLetters: number;
  messageIds: string[];
}

interface CronState {
  count: number;
  last: { cron: string; scheduledTime: number; observedAt: number } | null;
}

function client(baseURL: string, token: string) {
  return (path: string, init: RequestInit = {}) => fetch(new URL(path, baseURL), {
    ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(15_000),
  });
}

export async function checkAuthorization(baseURL: string, token: string) {
  assert.equal((await fetch(new URL('/api/health', baseURL))).status, 200);
  const routes = [
    ['/__probe/r2/' + randomUUID(), 'GET'], ['/__probe/r2/' + randomUUID(), 'PUT'],
    ['/__probe/r2/' + randomUUID(), 'HEAD'], ['/__probe/r2/' + randomUUID(), 'DELETE'],
    ['/__probe/jobs', 'POST'], ['/__probe/runs/' + randomUUID(), 'GET'], ['/__probe/cron', 'GET'],
  ];
  for (const [path, method] of routes) {
    for (const headers of [new Headers(), new Headers({ authorization: 'Bearer wrong-probe-token' })]) {
      const response = await fetch(new URL(path!, baseURL), { method, headers });
      assert.equal(response.status, 401, `${method} ${path} needs authentication`);
      assert.equal(response.headers.get('cache-control'), 'no-store', 'control responses must not be cached');
    }
  }
  const request = client(baseURL, token);
  assert.equal((await request('/__probe/cron')).headers.get('cache-control'), 'no-store');
  assert.equal((await request('/__probe/r2/invalid', { method: 'PUT' })).status, 400);
  assert.equal((await request('/__probe/jobs', { method: 'POST', body: '{}' })).status, 400);
  for (const behavior of [['poison'], {}, { toString: 'poison' }]) {
    const response = await request('/__probe/jobs', {
      method: 'POST', body: JSON.stringify({ runId: randomUUID(), key: 'invalid', behavior, copies: 1 }),
    });
    assert.equal(response.status, 400, 'job behavior must be a supported string');
  }
}

export async function checkR2(baseURL: string, token: string) {
  const request = client(baseURL, token);
  const runId = randomUUID();
  const path = '/__probe/r2/' + runId;
  const payload = `DingBell synthetic platform fixture ${runId}\n`;
  const expectedHash = createHash('sha256').update(payload).digest('hex');
  try {
    const write = await request(path, { method: 'PUT' });
    assert.equal(write.status, 201, 'R2 put succeeds');
    const written = await write.json() as { key: string; sha256: string; size: number };
    assert.deepEqual(written, { key: `synthetic/${runId}/fixture.txt`, sha256: expectedHash, size: Buffer.byteLength(payload) });
    const head = await request(path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(payload));
    assert.equal(head.headers.get('x-probe-sha256'), expectedHash);
    const read = await request(path);
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('etag'), head.headers.get('etag'));
    const bytes = Buffer.from(await read.arrayBuffer());
    assert.equal(bytes.toString(), payload);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash);
    assert.equal((await request(path, { method: 'DELETE' })).status, 204);
    assert.equal((await request(path)).status, 404);
    assert.equal((await request(path, { method: 'HEAD' })).status, 404);
    return { runId, sha256: expectedHash, status: 'PASS' as const };
  } finally {
    await request(path, { method: 'DELETE' });
  }
}

export async function checkQueues(baseURL: string, token: string, timeoutMs = 60_000) {
  const request = client(baseURL, token);
  const runId = randomUUID();
  for (const [key, behavior, copies] of [['deduplicate', 'once', 3], ['retry', 'retry-once', 1], ['dead-letter', 'poison', 1]] as const) {
    const response = await request('/__probe/jobs', { method: 'POST', body: JSON.stringify({ runId, key, behavior, copies }) });
    assert.equal(response.status, 202, 'native Queue producer accepts fixture messages');
  }
  const deadline = Date.now() + timeoutMs;
  let jobs: Record<string, JobState> = {};
  while (Date.now() < deadline) {
    const response = await request('/__probe/runs/' + runId);
    assert.equal(response.status, 200);
    jobs = (await response.json() as { jobs: Record<string, JobState> }).jobs;
    if (jobs.deduplicate?.deliveries >= 3 && jobs.retry?.effectCount === 1 && jobs['dead-letter']?.deadLetters >= 1) break;
    await delay(250);
  }
  assert.ok(jobs.deduplicate?.deliveries >= 3, 'all duplicate business jobs reach the actual consumer');
  assert.equal(jobs.deduplicate.effectCount, 1, 'one atomic effect for a stable business key');
  assert.equal(new Set(jobs.deduplicate.messageIds).size, 3, 'producer sent three separate transport messages');
  assert.equal(jobs.retry?.effectCount, 1);
  assert.ok(jobs.retry.attempts.includes(1) && jobs.retry.attempts.some(attempt => attempt >= 2), 'native redelivery succeeds after the first retry');
  assert.equal(new Set(jobs.retry.messageIds).size, 1, 'retry keeps the native message ID');
  assert.equal(jobs['dead-letter']?.effectCount, 0);
  assert.deepEqual([...new Set(jobs['dead-letter'].attempts)].sort(), [1, 2, 3], 'max_retries=2 allows three attempts before native DLQ forwarding');
  assert.ok(jobs['dead-letter'].deadLetters >= 1, 'independent DLQ consumer records the poison message');
  return { runId, jobs, status: 'PASS' as const };
}

export async function checkCron(baseURL: string, token: string, options: { local: boolean; cron?: string; timeoutMs?: number }) {
  const request = client(baseURL, token);
  const read = async () => {
    const response = await request('/__probe/cron');
    assert.equal(response.status, 200);
    return await response.json() as CronState;
  };
  const before = await read();
  const startedAt = Date.now();
  const cron = options.cron ?? '* * * * *';
  if (options.local) {
    // Wrangler 4.116.0 exposes this development-only native dispatch route with --test-scheduled.
    const url = new URL('/__scheduled', baseURL);
    url.searchParams.set('cron', cron);
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, 200, 'native workerd scheduled test endpoint succeeds');
    assert.equal(await response.text(), 'Ran scheduled event');
  }
  const deadline = Date.now() + (options.timeoutMs ?? (options.local ? 10_000 : 90_000));
  let after = before;
  while (Date.now() < deadline) {
    after = await read();
    if (after.count > before.count && after.last && after.last.observedAt >= startedAt) break;
    await delay(options.local ? 200 : 1000);
  }
  assert.ok(after.count > before.count, 'a new native scheduled invocation must arrive during observation');
  assert.equal(after.last?.cron, cron);
  if (options.local) assert.ok(after.last!.scheduledTime >= startedAt && after.last!.scheduledTime <= Date.now());
  assert.ok(after.last!.observedAt >= startedAt);
  return { before: before.count, ...after, status: 'PASS' as const };
}
