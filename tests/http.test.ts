import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { authError, type ApplicationEnv } from '../src/http.ts';

test('uncertain authentication writes preserve every cookie and report an unknown outcome', async () => {
  const app = new Hono<ApplicationEnv>();
  app.get('/', c => {
    c.set('requestId', 'server-generated-id');
    const headers = new Headers();
    headers.append('set-cookie', 'first=fixture; HttpOnly');
    headers.append('set-cookie', 'second=; Max-Age=0');
    headers.set('content-length', '999');
    return authError(c, new Response('private SDK error', { status: 500, headers }), true);
  });
  const response = await app.request('/');
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { error: { code: string } }).error.code, 'OPERATION_UNCONFIRMED');
  assert.deepEqual(response.headers.getSetCookie(), ['first=fixture; HttpOnly', 'second=; Max-Age=0']);
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('x-request-id'), 'server-generated-id');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('rate limiting preserves Retry-After without exposing SDK error details', async () => {
  const app = new Hono<ApplicationEnv>();
  app.get('/', c => {
    c.set('requestId', 'server-generated-id');
    return authError(c, new Response('private SDK error', { status: 429, headers: { 'retry-after': '10' } }), true);
  });
  const response = await app.request('/');
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '10');
  assert.equal((await response.text()).includes('private SDK error'), false);
});
