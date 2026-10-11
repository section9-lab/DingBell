import assert from 'node:assert/strict';
import { checkIdentity } from './check.ts';
import { checkBootstrap } from './bootstrap-check.ts';

const baseURL = process.env.DINGBELL_IDENTITY_BASE_URL;
const token = process.env.DINGBELL_IDENTITY_TOKEN;
assert.ok(baseURL && token, 'Set DINGBELL_IDENTITY_BASE_URL and DINGBELL_IDENTITY_TOKEN for the isolated probe.');
assert.equal(new URL(baseURL).origin, baseURL, 'Use an origin without a trailing slash or path.');
const mode = process.argv[2] ?? 'identity';
assert.ok(['identity', 'bootstrap', 'bootstrap-occupied'].includes(mode), 'Use identity, bootstrap, or bootstrap-occupied mode.');
let result;
if (mode === 'identity') result = await checkIdentity(baseURL, token);
else {
  const secret = process.env.DINGBELL_IDENTITY_BOOTSTRAP_SECRET;
  assert.ok(secret, 'Set DINGBELL_IDENTITY_BOOTSTRAP_SECRET for bootstrap checks.');
  result = await checkBootstrap(baseURL, token, secret, mode === 'bootstrap-occupied');
}
console.log(JSON.stringify(result));
