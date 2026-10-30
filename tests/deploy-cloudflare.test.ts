import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLegacyRunsDrained, deployArguments } from '../scripts/deploy-cloudflare.ts';

const options = { config: '/built/wrangler.json', dryRun: false };
const config = { name: 'custom-worker', main: 'index.js', d1_databases: [
  { binding: 'DB', database_name: 'custom-database', database_id: 'd90fd9e6-a7f4-4d47-81c7-218c4bcc0adb' },
] };

test('deployment migrates the binding before uploading, using the same built config', () => {
  assert.deepEqual(deployArguments(options, config), [
    ['d1', 'migrations', 'apply', 'DB', '--remote', '--config', options.config],
    ['deploy', '--config', options.config],
  ]);
});

test('missing build or local-only database cannot produce a remote command', () => {
  for (const value of [null, {}, { name: 'dingbell' }]) assert.throws(() => deployArguments(options, value), /Build/);
  for (const database_id of ['', 'dingbell-local-only', 'some-database-name']) {
    assert.throws(() => deployArguments(options, { ...config, d1_databases: [{ binding: 'DB', database_id }] }), /provisioned/);
  }
  assert.throws(() => deployArguments(options, { ...config, d1_databases: [{ ...config.d1_databases[0], binding: 'OTHER' }] }), /provisioned/);
});

test('dry run only bundles and cannot apply remote migrations', () => {
  assert.deepEqual(deployArguments({ ...options, dryRun: true, secretsFile: '/private/secrets.json' }, { name: 'dingbell', main: 'index.js' }), [
    ['deploy', '--config', options.config, '--secrets-file', '/private/secrets.json', '--dry-run'],
  ]);
});

test('an upgrade requires a complete, valid zero-count drain proof', () => {
  assertLegacyRunsDrained([{ pending: 0 }, { pending: 0 }], 2);
  assert.throws(() => assertLegacyRunsDrained([{ pending: 1 }], 1), /remain unsettled/);
  for (const rows of [[], [{}], [{ pending: '0' }], [{ pending: -1 }], [{ pending: 0.5 }]]) {
    assert.throws(() => assertLegacyRunsDrained(rows, 1), /could not be confirmed/);
  }
  assert.throws(() => assertLegacyRunsDrained([{ pending: 0 }], 2), /could not be confirmed/);
});
