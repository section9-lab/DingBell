import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runOzonOnce } from './src/ozon.ts';

test('Ozon cloud retries inspect the persisted result without reading the shop twice', async () => {
  let claimed = false;
  let result: unknown;
  let requests = 0;
  const controls = {
    async externalClaim() { if (claimed) return false; claimed = true; return true; },
    async externalInspect() { return { claimed, result }; },
    async externalRecordOzon(value: unknown) { result = value; },
  };
  const run = () => runOzonOnce(controls, { OZON_CLIENT_ID: 'fixture-client', OZON_API_KEY: 'fixture-key' }, async () => {
    requests++;
    return Response.json({ message: 'fixture-key' }, { status: 403 });
  });
  assert.deepEqual(await run(), await run());
  assert.equal(requests, 1);
  assert.equal(JSON.stringify(result).includes('fixture-key'), false);
});

test('missing cloud credentials do not claim the Ozon probe or access the network', async () => {
  let claimed = false;
  const controls = {
    async externalClaim() { claimed = true; return true; },
    async externalInspect() { return {}; },
    async externalRecordOzon() {},
  };
  await assert.rejects(runOzonOnce(controls, {}), /configuration/);
  assert.equal(claimed, false);
});
