import assert from 'node:assert/strict';
import { test } from 'node:test';
import app from '../src/app.ts';

test('liveness reports the application without claiming external services are ready', async () => {
  const response = await app.request('/api/health');

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), {
    service: 'dingbell',
    status: 'ok',
  });
});

test('production routing does not expose an anonymous agent or probe endpoint', async () => {
  for (const [method, path] of [
    ['POST', '/agents/probe/test-id'],
    ['POST', '/agents/probe/test-id/abort'],
    ['POST', '/__probe/test-id/dispatch'],
    ['GET', '/__probe/test-id/reply/test-submission'],
    ['GET', '/api/unknown'],
  ]) {
    const response = await app.request(path, { method });
    assert.equal(response.status, 404);
  }
});
