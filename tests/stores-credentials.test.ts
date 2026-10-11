import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credentialConfig, CredentialError, decryptCredentials, encryptCredentials } from '../src/modules/stores/credentials.ts';

const key1 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const key2 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const env = { STORE_CREDENTIAL_KEYS: JSON.stringify({ v1: key1 }), STORE_CREDENTIAL_ACTIVE_KEY: 'v1' };
const scope = { orgId: 'company-a', storeId: 'store-a', platformStoreId: '123456', credentialVersion: 1 };
const credentials = { apiKey: 'synthetic-ozon-api-key' };

test('credential configuration requires an explicit active version and canonical 256-bit keys', () => {
  assert.equal(credentialConfig(env)?.activeKeyVersion, 'v1');
  for (const input of [
    {}, { ...env, STORE_CREDENTIAL_ACTIVE_KEY: '' }, { ...env, STORE_CREDENTIAL_ACTIVE_KEY: 'missing' },
    { ...env, STORE_CREDENTIAL_KEYS: 'not-json' }, { ...env, STORE_CREDENTIAL_KEYS: 'null' },
    { ...env, STORE_CREDENTIAL_KEYS: '[]' }, { ...env, STORE_CREDENTIAL_KEYS: '{}' },
    { ...env, STORE_CREDENTIAL_KEYS: '{"v1":null}' }, { ...env, STORE_CREDENTIAL_KEYS: '{"v1":32}' },
    ...[31, 33].map(length => ({ ...env, STORE_CREDENTIAL_KEYS: JSON.stringify({ v1: btoa('a'.repeat(length)) }) })),
    { ...env, STORE_CREDENTIAL_KEYS: JSON.stringify({ v1: `${key1}\n` }) },
    { ...env, STORE_CREDENTIAL_KEYS: '{"__proto__":"' + key1 + '"}', STORE_CREDENTIAL_ACTIVE_KEY: '__proto__' },
  ]) assert.equal(credentialConfig(input), null);
});

test('credentials round trip with an independent fresh 96-bit nonce for each encryption', async () => {
  const first = await encryptCredentials(env, scope, credentials);
  const second = await encryptCredentials(env, scope, credentials);
  assert.equal(first.keyVersion, 'v1');
  assert.equal(atob(first.nonce).length, 12);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(JSON.stringify(first).includes(credentials.apiKey), false);
  assert.deepEqual(await decryptCredentials(env, scope, first), credentials);
});

test('payload validation accepts its documented size boundary without creating unreadable ciphertext', async () => {
  const boundary = { apiKey: '\ud800'.repeat(4096) };
  const envelope = await encryptCredentials(env, scope, boundary);
  assert.deepEqual(await decryptCredentials(env, scope, envelope), boundary);
  await assert.rejects(encryptCredentials(env, scope, { apiKey: '' }), CredentialError);
  await assert.rejects(encryptCredentials(env, scope, { apiKey: 'a'.repeat(4097) }), CredentialError);
});

test('AAD binds the company, store, platform account, credential revision and encryption key version', async () => {
  const sealed = await encryptCredentials(env, scope, credentials);
  for (const different of [
    { ...scope, orgId: 'company-b' }, { ...scope, storeId: 'store-b' },
    { ...scope, platformStoreId: '654321' }, { ...scope, credentialVersion: 2 },
  ]) await assert.rejects(decryptCredentials(env, different, sealed), CredentialError);
  const aliasEnv = { STORE_CREDENTIAL_KEYS: JSON.stringify({ v1: key1, alias: key1 }), STORE_CREDENTIAL_ACTIVE_KEY: 'alias' };
  await assert.rejects(decryptCredentials(aliasEnv, scope, { ...sealed, keyVersion: 'alias' }), CredentialError);
});

test('key rotation reads retained old versions and encrypts new credentials with the active version', async () => {
  const old = await encryptCredentials(env, scope, credentials);
  const rotated = { STORE_CREDENTIAL_KEYS: JSON.stringify({ v1: key1, v2: key2 }), STORE_CREDENTIAL_ACTIVE_KEY: 'v2' };
  assert.deepEqual(await decryptCredentials(rotated, scope, old), credentials);
  const current = await encryptCredentials(rotated, { ...scope, credentialVersion: 2 }, credentials);
  assert.equal(current.keyVersion, 'v2');
  assert.deepEqual(await decryptCredentials(rotated, { ...scope, credentialVersion: 2 }, current), credentials);
  await assert.rejects(decryptCredentials({ ...rotated, STORE_CREDENTIAL_KEYS: JSON.stringify({ v2: key2 }) }, scope, old), CredentialError);
});

test('tampered envelopes and malformed configuration fail with a fixed secret-free error', async () => {
  const sealed = await encryptCredentials(env, scope, credentials);
  const changed = atob(sealed.ciphertext);
  const ciphertext = btoa(String.fromCharCode(changed.charCodeAt(0) ^ 1) + changed.slice(1));
  const wrongKey = { ...env, STORE_CREDENTIAL_KEYS: JSON.stringify({ v1: key2 }) };
  for (const operation of [
    () => decryptCredentials(env, scope, { ...sealed, ciphertext }),
    () => decryptCredentials(env, scope, { ...sealed, nonce: btoa('short') }),
    () => decryptCredentials(env, scope, { ...sealed, ciphertext: 'invalid' }),
    () => decryptCredentials(wrongKey, scope, sealed),
    () => encryptCredentials({}, scope, credentials),
    () => encryptCredentials(env, { ...scope, credentialVersion: 0 }, credentials),
  ]) await assert.rejects(operation, error => {
    assert.ok(error instanceof CredentialError);
    assert.equal(error.code, 'STORE_CREDENTIALS_UNAVAILABLE');
    assert.equal(error.message, 'Store credentials are unavailable.');
    assert.equal(error.cause, undefined);
    return true;
  });
});
