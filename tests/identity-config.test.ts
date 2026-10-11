import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { URL } from 'node:url';
import { authOptions, identityConfig } from '../src/modules/identity/config.ts';
import { services } from '../src/modules/identity/services.ts';
import type { IdentityBindings } from '../src/modules/identity/bindings.ts';

const valid: IdentityBindings = {
  DB: {} as D1Database,
  APP_BASE_URL: 'https://dingbell.example',
  BETTER_AUTH_SECRET: 'synthetic-identity-config-test-secret',
};

test('identity configuration requires a database, an explicit secret, and an application origin', () => {
  for (const input of [
    {}, { ...valid, DB: undefined }, { ...valid, BETTER_AUTH_SECRET: undefined },
    { ...valid, BETTER_AUTH_SECRET: 'short' }, { ...valid, BETTER_AUTH_SECRET: ' '.repeat(32) },
    { ...valid, APP_BASE_URL: undefined },
  ]) {
    assert.equal(identityConfig(input), null);
  }
});

test('identity configuration normalizes HTTPS origins and permits only explicit loopback HTTP', () => {
  for (const [url, expected] of [
    ['https://DingBell.example:443/', 'https://dingbell.example'],
    ['https://dingbell.example:8443', 'https://dingbell.example:8443'],
    ['http://localhost:5173', 'http://localhost:5173'],
    ['http://127.0.0.1:5173/', 'http://127.0.0.1:5173'],
    ['http://[::1]:5173', 'http://[::1]:5173'],
  ]) {
    assert.deepEqual(identityConfig({ ...valid, APP_BASE_URL: url }), {
      baseURL: expected, secret: valid.BETTER_AUTH_SECRET,
    });
  }
});

test('invalid origins remain unconfigured without throwing or returning sensitive input', () => {
  for (const url of [
    'invalid', 'http://dingbell.example', 'http://localhost.evil.example',
    'http://127.0.0.2', 'http://2130706433', 'http://127.1',
    'https://user:password@dingbell.example', 'https://dingbell.example/app',
    'https://dingbell.example/?token=private', 'https://dingbell.example/#private',
    'ftp://localhost', '//dingbell.example', ' https://dingbell.example',
  ]) {
    assert.equal(identityConfig({ ...valid, APP_BASE_URL: url }), null);
  }
});

test('authentication requires verified accounts and has no cookie session cache or public onboarding', () => {
  const options = authOptions({ baseURL: 'https://dingbell.example', secret: valid.BETTER_AUTH_SECRET! });
  assert.equal(options.baseURL, 'https://dingbell.example');
  assert.deepEqual(options.trustedOrigins, ['https://dingbell.example']);
  assert.equal(options.emailAndPassword?.enabled, true);
  assert.equal(options.emailAndPassword?.disableSignUp, true);
  assert.equal(options.emailAndPassword?.requireEmailVerification, true);
  assert.equal(options.session?.cookieCache?.enabled, false);
  assert.equal(options.rateLimit?.enabled, true);
  assert.equal(options.rateLimit?.storage, 'database');
  assert.deepEqual(options.advanced?.ipAddress?.ipAddressHeaders, ['cf-connecting-ip']);
  assert.equal('emailVerification' in options, false);
  const plugin = options.plugins?.find(plugin => plugin.id === 'organization');
  assert.ok(plugin);
  const pluginOptions = plugin.options as Record<string, unknown>;
  assert.equal(pluginOptions.allowUserToCreateOrganization, false);
  assert.equal(pluginOptions.requireEmailVerificationOnInvitation, true);
  assert.equal(pluginOptions.sendInvitationEmail, undefined);
});

test('identity services fail closed until configured and construct the official adapter without a database read', () => {
  assert.equal(services({}), null);
  const configured = services({
    ...valid,
    DB: { prepare() { throw new Error('configuration must not query the database'); } } as unknown as D1Database,
  });
  assert.ok(configured?.db);
  assert.ok(configured?.auth);
});

test('the initial production migration creates only authentication tables and enforces key constraints', () => {
  const folder = new URL('../migrations/', import.meta.url);
  assert.ok(existsSync(folder), 'production authentication migration must exist');
  const migrations = readdirSync(folder).filter(file => file.endsWith('.sql')).sort();
  assert.ok(migrations.length > 0);
  const sql = readFileSync(new URL(migrations[0], folder), 'utf8');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(sql);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
    assert.deepEqual(names, ['account', 'invitation', 'member', 'organization', 'rate_limit', 'session', 'user', 'verification']);
    db.exec("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('user-a', 'A', 'a@example.invalid', 1, 1, 1)");
    assert.throws(() => db.exec("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('user-b', 'B', 'a@example.invalid', 1, 1, 1)"), /UNIQUE constraint failed/);
    assert.throws(() => db.exec("INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('member-a', 'missing', 'user-a', 'owner', 1)"), /FOREIGN KEY constraint failed/);
    for (const file of migrations.slice(1)) db.exec(readFileSync(new URL(file, folder), 'utf8'));
    assert.deepEqual(db.prepare('PRAGMA table_info(identity_audit_event)').all().map(row => row.name), [
      'id', 'request_id', 'action', 'outcome', 'actor_user_id', 'organization_id', 'created_at',
      'target_member_id', 'before_role', 'after_role',
    ]);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_list(identity_audit_event)').all(), []);
  } finally {
    db.close();
  }
});
