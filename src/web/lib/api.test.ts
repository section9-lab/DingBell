/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activateCompany, readIdentity, request, signIn } from './api.ts';
import * as v from 'valibot';

const setup = {
  identity: { configured: true },
  registration: { enabled: false },
  email: { configured: false },
};
const session = {
  user: {
    id: 'u1',
    name: 'Test',
    email: 'test@example.invalid',
    emailVerified: true,
    image: null,
  },
  session: {
    id: 's1',
    expiresAt: '2026-12-01T00:00:00.000Z',
    activeOrganizationId: 'a',
  },
};

test('bootstrap authorization stays in its header and is preserved on JSON requests', async (t) => {
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    assert.equal(path, '/api/bootstrap/claim');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), 'Bearer synthetic-install-token');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal((init.body as string).includes('synthetic-install-token'), false);
    return Response.json({ accepted: true });
  });
  await request('/api/bootstrap/claim', v.object({ accepted: v.boolean() }), {
    method: 'POST', headers: { authorization: 'Bearer synthetic-install-token' },
    body: JSON.stringify({ claimId: 'synthetic-job' }),
  });
});

test('identity reads stop before private requests when authentication is not configured', async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    calls.push(path);
    return Response.json({ ...setup, identity: { configured: false } });
  });
  const result = await readIdentity();
  assert.equal(result.setup.identity.configured, false);
  assert.equal(result.session, null);
  assert.deepEqual(calls, ['/api/setup']);
});

test('a revoked session never returns the previously fetched identity or company', async (t) => {
  const replies = [
    Response.json(setup),
    Response.json(session),
    Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 }),
  ];
  t.mock.method(globalThis, 'fetch', async () => replies.shift()!);
  const result = await readIdentity();
  assert.equal(result.session, null);
  assert.equal(result.companies, null);
});

test('an invalid server payload is rejected instead of becoming cached company data', async (t) => {
  const replies = [
    Response.json(setup),
    Response.json(session),
    Response.json({
      companies: [{ id: 'a', role: 'owner' }],
      activeCompanyId: 'a',
    }),
  ];
  t.mock.method(globalThis, 'fetch', async () => replies.shift()!);
  await assert.rejects(readIdentity(), { code: 'INVALID_RESPONSE' });
});

test('an interrupted mutation is uncertain and is never automatically retried', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new TypeError('private transport detail');
  });
  await assert.rejects(signIn('test@example.invalid', 'synthetic-password'), {
    code: 'OPERATION_UNCONFIRMED',
  });
  assert.equal(calls, 1);
});

test('company selection uses the authenticated same-origin API without redirect or caching', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async (path: string, init: RequestInit) => {
      assert.equal(path, '/api/companies/a%2Fb/activate');
      assert.equal(init.method, 'POST');
      assert.equal(init.credentials, 'same-origin');
      assert.equal(init.cache, 'no-store');
      assert.equal(init.redirect, 'error');
      assert.deepEqual(JSON.parse(init.body as string), {});
      return Response.json({ activeCompanyId: 'a/b' });
    },
  );
  assert.deepEqual(await activateCompany('a/b'), { activeCompanyId: 'a/b' });
});

test('safe API errors retain a request ID without exposing backend text', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      {
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'private internal error',
        },
        requestId: 'request-123',
      },
      { status: 401 },
    ),
  );
  await assert.rejects(
    signIn('test@example.invalid', 'synthetic-password'),
    (error: any) => {
      assert.equal(error.code, 'INVALID_CREDENTIALS');
      assert.equal(error.requestId, 'request-123');
      assert.equal(error.message.includes('private internal'), false);
      return true;
    },
  );
});
