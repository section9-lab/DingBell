import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { URL } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { Hono } from 'hono';
import { type ApplicationEnv, apiError } from '../src/http.ts';
import { AuditUnavailable, OperationUnconfirmed } from '../src/modules/audit/operation.ts';
import { services } from '../src/modules/identity/services.ts';
import { registerProfileRoutes } from '../src/modules/profile/http.ts';

function sqliteD1(sqlite: DatabaseSync): D1Database {
  function prepare(sql: string, values: SQLInputValue[] = []) {
    return {
      bind: (...parameters: SQLInputValue[]) => prepare(sql, parameters),
      async all() {
        return { results: sqlite.prepare(sql).all(...values), success: true, meta: {} };
      },
      async raw() {
        return sqlite
          .prepare(sql)
          .all(...values)
          .map((row) => Object.values(row));
      },
      async first(column?: string) {
        const row = sqlite.prepare(sql).get(...values);
        return row ? (column ? row[column] : row) : null;
      },
      async run() {
        const result = sqlite.prepare(sql).run(...values);
        return { success: true, results: [], meta: { changes: Number(result.changes) } };
      },
    };
  }
  return { prepare } as unknown as D1Database;
}

async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const folder = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(folder)
    .filter((file) => file.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync(new URL(file, folder), 'utf8'));
  const password = 'synthetic-profile-fixture-password';
  const hashed = await hashPassword(password);
  sqlite
    .prepare(
      'INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,1,1,1)',
    )
    .run('owner', 'Owner', 'owner@example.invalid');
  sqlite
    .prepare(
      "INSERT INTO account (id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES (?,?,'credential',?,?,1,1)",
    )
    .run('account-owner', 'owner', 'owner', hashed);
  const env = {
    DB: sqliteD1(sqlite),
    APP_BASE_URL: 'https://dingbell.example',
    BETTER_AUTH_SECRET: 'synthetic-profile-test-secret-at-least-32',
  };
  const app = new Hono<ApplicationEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', crypto.randomUUID());
    await next();
  });
  registerProfileRoutes(app);
  app.onError((error, c) =>
    apiError(
      c,
      error instanceof AuditUnavailable
        ? 'AUDIT_UNAVAILABLE'
        : error instanceof OperationUnconfirmed
          ? 'OPERATION_UNCONFIRMED'
          : 'UNEXPECTED_TEST_ERROR',
      'Operation unavailable.',
      503,
    ),
  );
  const login = await services(env)!.auth.api.signInEmail({
    body: { email: 'owner@example.invalid', password },
    asResponse: true,
  });
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ');
  const request = (path: string, method = 'GET', body?: unknown) =>
    app.request(
      `https://dingbell.example${path}`,
      {
        method,
        headers: { cookie, origin: env.APP_BASE_URL, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  return { sqlite, request, close: () => sqlite.close() };
}

test('profile update only changes name and avatar, never email', async () => {
  const f = await fixture();
  try {
    const response = await f.request('/api/me/profile', 'POST', {
      name: '  New Name  ',
      avatarSeed: 'avatar_seed-1',
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      user: { name: string; email: string; image: string };
    };
    assert.equal(payload.user.name, 'New Name');
    assert.equal(payload.user.email, 'owner@example.invalid');
    assert.equal(payload.user.image, '/api/avatars/avatar_seed-1.svg');
    const row = f.sqlite.prepare("SELECT name,email,image FROM user WHERE id='owner'").get() as {
      name: string;
      email: string;
      image: string;
    };
    assert.equal(row.name, 'New Name');
    assert.equal(row.email, 'owner@example.invalid');
    assert.equal(row.image, '/api/avatars/avatar_seed-1.svg');

    const rejected = await f.request('/api/me/profile', 'POST', {
      name: 'Hijack',
      email: 'changed@example.invalid',
      avatarSeed: 'avatar_seed-2',
    });
    assert.equal(rejected.status, 400);
    assert.equal(
      (f.sqlite.prepare("SELECT email FROM user WHERE id='owner'").get() as { email: string })
        .email,
      'owner@example.invalid',
    );

    for (const body of [
      { name: '', avatarSeed: 'avatar_seed-2' },
      { name: 'Line\nBreak', avatarSeed: 'avatar_seed-2' },
      { name: 'Valid', avatarSeed: '../escape' },
      { name: 'Valid' },
    ])
      assert.equal((await f.request('/api/me/profile', 'POST', body)).status, 400);
  } finally {
    f.close();
  }
});

test('avatar route renders deterministic Micah SVG with attribution and cache headers', async () => {
  const f = await fixture();
  try {
    const first = await f.request('/api/avatars/avatar_seed-1.svg');
    assert.equal(first.status, 200);
    assert.match(first.headers.get('content-type') ?? '', /^image\/svg\+xml/);
    assert.match(first.headers.get('cache-control') ?? '', /immutable/);
    const firstSvg = await first.text();
    assert.match(firstSvg, /<svg/);
    assert.match(firstSvg, /Micah Lanier/);
    assert.match(firstSvg, /CC BY 4\.0/);
    const second = await f.request('/api/avatars/avatar_seed-1.svg');
    assert.equal(await second.text(), firstSvg);
    assert.equal((await f.request('/api/avatars/bad.seed.svg')).status, 404);
    assert.equal((await f.request('/api/avatars/avatar_seed-1.png')).status, 404);
  } finally {
    f.close();
  }
});

test('profile updates require a verified session', async () => {
  const f = await fixture();
  try {
    f.sqlite.exec("UPDATE user SET email_verified=0 WHERE id='owner'");
    const response = await f.request('/api/me/profile', 'POST', {
      name: 'Nope',
      avatarSeed: 'avatar_seed-1',
    });
    assert.equal(response.status, 401);
  } finally {
    f.close();
  }
});
