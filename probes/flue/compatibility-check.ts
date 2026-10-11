import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const legacyVersion = '2.0.0-nightly.202607240825';
const currentVersion = '2.2.2';
const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '../..');
// This genuine nightly predates the public idempotencyKey field.
const payload = { message: 'synthetic legacy schema8 message' };
const id = 'synthetic-schema8-instance';

async function hash(path: string) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function packageEvidence(project: string, name: string) {
  const packagePath = join(project, 'node_modules', name, 'package.json');
  const pkg = JSON.parse(await readFile(packagePath, 'utf8')) as { version: string };
  const lockPath = join(project, 'package-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const locked = lock.packages[`node_modules/${name}`];
  return { name, version: pkg.version, resolved: locked.resolved, integrity: locked.integrity, packageSha256: await hash(packagePath), lockSha256: await hash(lockPath) };
}

async function runChild(phase: string, project: string, database: string, receipt: string) {
  const child = spawn(process.execPath, ['--experimental-import-meta-resolve', script, '--child', phase, project, database, receipt], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' },
  });
  let output = '';
  let diagnostics = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8_000); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${phase} failed (${code}): ${diagnostics}`)));
    });
    const line = output.split('\n').find(line => line.startsWith('COMPATIBILITY_RESULT '));
    assert.ok(line, `${phase}: no result`);
    return JSON.parse(line.slice('COMPATIBILITY_RESULT '.length));
  } finally { clearTimeout(timer); }
}

if (process.argv[2] === '--child') {
  const [, , , phase, project, database, receiptPath] = process.argv;
  const parent = pathToFileURL(join(project!, 'package.json')).href;
  const load = (name: string) => import(import.meta.resolve(name, parent));
  const runtime = await load('@flue/runtime') as typeof import('@flue/runtime');
  const node = await load('@flue/runtime/node') as typeof import('@flue/runtime/node');
  const adapter = await load('@flue/runtime/adapter');
  const routing = await load('@flue/runtime/routing') as typeof import('@flue/runtime/routing');
  const pi = await load('@earendil-works/pi-ai') as typeof import('@earendil-works/pi-ai');
  const version = JSON.parse(await readFile(join(project!, 'node_modules/@flue/runtime/package.json'), 'utf8')).version;
  assert.equal(version, phase === 'upgrade' ? currentVersion : legacyVersion);
  const marker = phase === 'upgrade' ? adapter.FLUE_FORMAT_VERSION : adapter.FLUE_SCHEMA_VERSION;
  assert.equal(marker, phase === 'upgrade' ? 1 : 8);
  let modelCalls = 0;
  const faux = pi.fauxProvider({ api: 'compatibility-fixture', provider: 'compatibility-fixture', models: [{ id: 'reply' }] });
  faux.setResponses([() => {
    modelCalls++;
    return pi.fauxAssistantMessage(pi.fauxText('authentic schema8 fixture reply'));
  }]);
  function HistoricalProbe() {
    runtime.useModel('compatibility-fixture/reply');
    return 'Return only the deterministic fixture reply.';
  }
  HistoricalProbe.agentName = 'HistoricalProbe';
  let flue: Awaited<ReturnType<typeof node.start>> | undefined;
  try {
    flue = await node.start({ agents: [HistoricalProbe], db: node.sqlite(database), providers: [faux.provider], env: {} });
    assert.notEqual(phase, 'rollback', 'The old runtime unexpectedly opened the upgraded copy.');
    const handle = runtime.init(HistoricalProbe, { id });
    const saved = phase === 'seed' ? undefined : JSON.parse(await readFile(receiptPath!, 'utf8'));
    const receipt = saved?.receipt ?? await handle.dispatch(payload);
    const reply = await handle.read(receipt.submissionId, { signal: AbortSignal.timeout(30_000) });
    assert.equal(reply.submissionId, receipt.submissionId);
    assert.equal(reply.text, 'authentic schema8 fixture reply');
    const response = await routing.createAgentRouter(HistoricalProbe).request(`/${id}`);
    assert.equal(response.status, 200);
    const snapshot = await response.json() as { messages: ({ role: string } & Record<string, unknown>)[] };
    assert.equal(snapshot.messages.filter(message => message.role === 'user').length, 1);
    assert.equal(snapshot.messages.filter(message => message.role === 'assistant').length, 1);
    if (saved) {
      assert.deepEqual(reply, saved.reply);
      assert.equal(snapshot.messages.length, saved.messages.length);
      for (let index = 0; index < saved.messages.length; index++) {
        const before = saved.messages[index];
        const after = snapshot.messages[index]!;
        for (const key of Object.keys(before)) assert.deepEqual(after[key], before[key], `message ${index} ${key}`);
        for (const key of Object.keys(after).filter(key => !(key in before))) {
          // The current HTTP projection adds timestamps; persisted IDs/content must match.
          assert.equal(key, 'timestamp');
          assert.ok(Number.isFinite(Date.parse(String(after[key]))));
        }
      }
      const instance = await runtime.getAgentInstance(HistoricalProbe, id);
      assert.equal(instance?.uid, receipt.uid);
      assert.equal(modelCalls, 0, 'Reading the original result must not invoke the model.');
    } else {
      assert.equal(modelCalls, 1);
      await writeFile(receiptPath!, JSON.stringify({ receipt, reply, messages: snapshot.messages }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    await flue.stop();
    flue = undefined;
    console.log('COMPATIBILITY_RESULT ' + JSON.stringify({
      phase, version, marker, receipt, modelCalls, messages: snapshot.messages.length,
      projectedTimestamps: snapshot.messages.filter(message => 'timestamp' in message).length,
      legacySupportsIdempotencyKey: false,
    }));
  } catch (error) {
    if (phase !== 'rollback') throw error;
    let cause: unknown = error;
    const types: unknown[] = [];
    while (cause && typeof cause === 'object') {
      if ('type' in cause) types.push(cause.type);
      cause = 'cause' in cause ? cause.cause : undefined;
    }
    assert.ok(types.includes('persisted_schema_version_unsupported'), String(error));
    const type = 'persisted_schema_version_unsupported';
    console.log('COMPATIBILITY_RESULT ' + JSON.stringify({ phase, version, rejected: true, errorType: type }));
  } finally { await flue?.stop(); }
} else {
  const [legacyProject, outputDirectory] = process.argv.slice(2).map(path => resolve(path));
  assert.ok(legacyProject && outputDirectory, 'Use: compatibility-check.ts LEGACY_PROJECT NEW_OUTPUT_DIRECTORY');
  assert.notEqual(legacyProject, root, 'The legacy dependencies must be outside the shared project.');
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  const legacyPackage = await packageEvidence(legacyProject, '@flue/runtime');
  const legacyProvider = await packageEvidence(legacyProject, '@earendil-works/pi-ai');
  const currentPackage = await packageEvidence(root, '@flue/runtime');
  const currentProvider = await packageEvidence(root, '@earendil-works/pi-ai');
  assert.equal(legacyPackage.version, legacyVersion);
  assert.equal(legacyProvider.version, '0.81.1');
  assert.equal(currentPackage.version, currentVersion);
  assert.equal(currentProvider.version, '0.87.1');
  const original = join(outputDirectory, 'legacy-original.sqlite');
  const backup = join(outputDirectory, 'legacy-backup.sqlite');
  const upgraded = join(outputDirectory, 'upgrade.sqlite');
  const rollback = join(outputDirectory, 'rollback-copy.sqlite');
  const restored = join(outputDirectory, 'restored-backup.sqlite');
  const receipt = join(outputDirectory, 'original-receipt.json');
  const seed = await runChild('seed', legacyProject, original, receipt);
  const walSize = await stat(original + '-wal').then(info => info.size, error => {
    if (error.code === 'ENOENT') return 0;
    throw error;
  });
  assert.equal(walSize, 0, 'The old runtime must stop and checkpoint before backing up its database.');
  await copyFile(original, backup);
  const backupHash = await hash(backup);
  await copyFile(backup, upgraded);
  const upgrade = await runChild('upgrade', root, upgraded, receipt);
  await copyFile(upgraded, rollback);
  const rollbackResult = await runChild('rollback', legacyProject, rollback, receipt);
  await copyFile(backup, restored);
  const restore = await runChild('restore', legacyProject, restored, receipt);
  assert.equal(await hash(backup), backupHash, 'The original backup must remain unchanged.');
  const evidence = {
    checkedAt: new Date().toISOString(), node: process.version,
    scope: 'Authentic Node SQLite schema8 fixture; no direct private-table reads or writes; not a Cloudflare DO snapshot restore.',
    dependencies: [legacyPackage, legacyProvider, currentPackage, currentProvider],
    results: { seed, upgrade, rollback: rollbackResult, restore },
    sha256: { original: await hash(original), backup: backupHash, upgraded: await hash(upgraded), receipt: await hash(receipt) },
  };
  await writeFile(join(outputDirectory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: 'passed', evidence: join(outputDirectory, 'evidence.json'), checks: ['authentic schema8 seed', 'current-version original reply/history/receipt', 'old version rejects upgraded copy', 'original backup restores under old version'] }));
}
