import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { assertBuildFresh, assertLegacyRunsDrained, deployArguments } from '../scripts/deploy-cloudflare.ts';
import { assertRetirementInventory } from '../src/platform/database/retirement.ts';

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

async function buildFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'dingbell-deploy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path: string, mtimeMs: number) => {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, '');
    await utimes(path, mtimeMs / 1000, mtimeMs / 1000);
  };
  const configPath = join(root, 'dist/dingbell/wrangler.json');
  await write(configPath, Date.now() - 60_000);
  return { root, configPath, write };
}

test('a build older than any bundled source file cannot be deployed', async t => {
  const { root, configPath, write } = await buildFixture(t);
  const builtAt = Date.now();
  await write(join(root, 'dist/dingbell/index.js'), builtAt);
  await write(join(root, 'src/web/app.tsx'), builtAt - 1_000);
  await assertBuildFresh({ root, configPath, config: { main: 'index.js' } });
  await write(join(root, 'src/web/app.tsx'), builtAt + 1_000);
  await assert.rejects(assertBuildFresh({ root, configPath, config: { main: 'index.js' } }),
    /src\/web\/app\.tsx is newer than the build.*npm run build/);
});

test('tests, dependencies and unrelated directories do not force a rebuild', async t => {
  const { root, configPath, write } = await buildFixture(t);
  const builtAt = Date.now();
  await write(join(root, 'dist/dingbell/index.js'), builtAt);
  await write(join(root, 'src/web/app.tsx'), builtAt - 1_000);
  for (const path of ['src/web/app.test.ts', 'node_modules/vite/index.js', 'tests/deploy.test.ts', 'migrations/9999_future.sql']) {
    await write(join(root, path), builtAt + 1_000);
  }
  await assertBuildFresh({ root, configPath, config: { main: 'index.js' } });
});

test('a missing worker entry or config without main is reported locally', async t => {
  const { root, configPath } = await buildFixture(t);
  await assert.rejects(assertBuildFresh({ root, configPath, config: { main: 'index.js' } }), /built worker entry is missing/);
  await assertBuildFresh({ root, configPath, config: { name: 'dingbell' } });
});

test('an upgrade requires a complete, valid zero-count drain proof', () => {
  assertLegacyRunsDrained([{ pending: 0 }, { pending: 0 }], 2);
  assert.throws(() => assertLegacyRunsDrained([{ pending: 1 }], 1), /remain unsettled/);
  for (const rows of [[], [{}], [{ pending: '0' }], [{ pending: -1 }], [{ pending: 0.5 }]]) {
    assert.throws(() => assertLegacyRunsDrained(rows, 1), /could not be confirmed/);
  }
  assert.throws(() => assertLegacyRunsDrained([{ pending: 0 }], 2), /could not be confirmed/);
});

test('retiring nonempty remote tables requires explicit approval and a complete, valid inventory', () => {
  const tables = ['reply_test_budget'] as const;
  assertRetirementInventory([{ name: 'reply_test_budget', records: 0 }], tables, false);
  assert.throws(() => assertRetirementInventory([{ name: 'reply_test_budget', records: 1 }], tables, false), /--archive-retired/);
  assertRetirementInventory([{ name: 'reply_test_budget', records: 1 }], tables, true);
  for (const rows of [[], [{}], [{ name: 'other', records: 0 }], [{ name: 'reply_test_budget', records: '0' }],
    [{ name: 'reply_test_budget', records: -1 }], [{ name: 'reply_test_budget', records: 0.5 }]]) {
    assert.throws(() => assertRetirementInventory(rows, tables, true), /could not be confirmed/);
  }
  assert.throws(() => assertRetirementInventory([{ name: 'reply_test_budget', records: 0 }, { name: 'reply_test_budget', records: 0 }],
    ['reply_test_budget', 'reply_test_run'], true), /could not be confirmed/);
});
