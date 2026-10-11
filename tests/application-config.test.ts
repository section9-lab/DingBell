import assert from 'node:assert/strict';
import { test } from 'node:test';
import app from '../src/app.ts';

test('setup reports missing identity and mail configuration without requiring model secrets', async () => {
  const response = await app.request('/api/setup');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { identity: { configured: false }, registration: { enabled: false }, email: { configured: false } });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('identity endpoints fail closed with a safe error and a server-generated request ID', async () => {
  for (const [method, path] of [['GET', '/api/companies'], ['GET', '/api/auth/get-session'], ['POST', '/api/auth/sign-in/email'], ['POST', '/api/auth/request-password-reset'], ['POST', '/api/auth/send-verification-email'], ['POST', '/api/auth/verify-email'], ['POST', '/api/auth/reset-password']]) {
    const response = await app.request(path, { method, headers: { 'x-request-id': 'untrusted-id' } });
    assert.equal(response.status, 503);
    const data = await response.json() as { error: { code: string }; requestId: string };
    assert.equal(data.error.code, 'IDENTITY_NOT_CONFIGURED');
    assert.match(data.requestId, /^[a-f0-9-]{36}$/);
    assert.equal(response.headers.get('x-request-id'), data.requestId);
    assert.notEqual(data.requestId, 'untrusted-id');
  }
});

test('direct SDK administration and test routes stay unavailable', async () => {
  for (const path of ['/api/auth/sign-up/email', '/api/auth/organization/create', '/api/auth/organization/set-active', '/api/auth/organization/invite-member', '/__probe/mail/example']) {
    assert.equal((await app.request(path, { method: 'POST' })).status, 404);
  }
});

test('cross-origin identity writes are rejected before touching a configured database', async () => {
  const env = {
    DB: { prepare() { throw new Error('Database must not be used'); } },
    APP_BASE_URL: 'https://app.example.com', BETTER_AUTH_SECRET: 'synthetic-secret-for-unit-tests-only',
  };
  for (const origin of ['https://attacker.example.com', 'null', 'https://app.example.com.attacker.com']) {
    const response = await app.request('/api/companies/company-a/activate', { method: 'POST', headers: { origin } }, env);
    assert.equal(response.status, 403);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'ORIGIN_REJECTED');
  }
});
