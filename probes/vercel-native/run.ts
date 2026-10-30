import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { APIError, Drive, Sandbox } from '@vercel/sandbox';
import { getAuth } from '@vercel/sandbox/dist/auth/index.js';

if (!process.argv.includes('--isolated-cloud')) throw new Error('Pass --isolated-cloud; this probe creates and removes synthetic Sandbox/Drive resources.');
const linked = JSON.parse(await readFile(new URL('./.vercel/project.json', import.meta.url), 'utf8')) as { projectId: string; orgId: string; projectName: string };
if (!linked.projectName?.startsWith('dingbell-native-check-')) throw new Error('Link a new dingbell-native-check-* test project first.');
const auth = getAuth();
if (!auth?.token) throw new Error('Complete vercel login first. Never paste tokens into source or the command line.');
const credentials = { token: auth.token, projectId: linked.projectId, teamId: linked.orgId };
const name = `dingbell-sqlite-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
const output = resolve(import.meta.dirname, '../../test-results/vercel-native');
await mkdir(output, { recursive: true });
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), name, projectName: linked.projectName, sdk: '3.9.1', scope: 'native-drive-sqlite-only-not-the-application' };
const sandboxes = new Map<string, Sandbox>();
let drive: Drive | undefined;
const cleanup: Record<string, boolean> = {};
const cleanupErrors: Record<string, string> = {};

async function createSandbox(suffix: string) {
  assert.ok(drive);
  const sandbox = await Sandbox.create({ ...credentials, name: `${name}-${suffix}`, region: 'iad1',
    persistent: false, timeout: 120_000, resources: { vcpus: 1 },
    mounts: { '/data': drive }, signal: AbortSignal.timeout(60_000) });
  sandboxes.set(sandbox.name, sandbox);
  return sandbox;
}
async function run(sandbox: Sandbox, source: string, expectedCode = 0) {
  const result = await sandbox.runCommand('node', ['--input-type=module', '-e', source]);
  const stdout = await result.stdout();
  assert.equal(result.exitCode, expectedCode, `SQLite command failed: ${await result.stderr()}`);
  return stdout.trim() ? JSON.parse(stdout.trim()) as unknown : undefined;
}
const inspect = `
  import {DatabaseSync} from 'node:sqlite';
  const db=new DatabaseSync('/data/state.sqlite');
  const receipt=db.prepare('SELECT id,body FROM receipt ORDER BY id').all();
  const budget=db.prepare('SELECT amount FROM budget WHERE id=1').get();
  const integrity=db.prepare('PRAGMA integrity_check').get();
  console.log(JSON.stringify({receipt,budget,integrity}));db.close();
`;
try {
  console.log('Creating a synthetic-only Vercel Drive and single-writer Sandbox.');
  drive = await Drive.getOrCreate({ ...credentials, name, maxSize: 1024 * 1024 * 1024, region: 'iad1', signal: AbortSignal.timeout(30_000) });
  const first = await createSandbox('first');
  evidence.runtime = await run(first, `console.log(JSON.stringify({node:process.version,platform:process.platform}));`);
  await run(first, `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync('/data/state.sqlite');
    db.exec("PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE receipt(id TEXT PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE budget(id INTEGER PRIMARY KEY,amount INTEGER NOT NULL CHECK(amount>=0));BEGIN IMMEDIATE;INSERT INTO receipt VALUES('original','frozen');INSERT INTO budget VALUES(1,100);COMMIT;");db.close();
  `);
  const expected = await run(first, inspect);
  await run(first, `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync('/data/state.sqlite');
    db.exec("PRAGMA synchronous=FULL;BEGIN IMMEDIATE;UPDATE budget SET amount=0 WHERE id=1;INSERT INTO receipt VALUES('uncommitted','must-rollback');");
    process.kill(process.pid,'SIGKILL');
  `, 137);
  assert.deepEqual(await run(first, inspect), expected);
  evidence.processInterruption = { uncommittedTransactionRolledBack: true, originalReceiptPreserved: true };
  let secondWriterRejected = false;
  try { await createSandbox('contender'); }
  catch (error) {
    if (error instanceof APIError && error.response.status === 409) secondWriterRejected = true;
    else throw error;
  }
  assert.ok(secondWriterRejected, 'The platform must reject a second read-write mount.');
  evidence.singleWriter = true;
  await first.stop();
  const replacement = await createSandbox('replacement');
  assert.deepEqual(await run(replacement, inspect), expected);
  evidence.replacementSandbox = { originalReceiptPreserved: true, budgetPreserved: true, integrityCheckPassed: true };
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = error instanceof Error ? error.message.replaceAll(credentials.token, '[redacted]') : 'Unknown error';
  process.exitCode = 1;
} finally {
  for (const [sandboxName, sandbox] of sandboxes) {
    try { await sandbox.delete({ deleteOrphanSnapshots: true, signal: AbortSignal.timeout(30_000) }); cleanup[sandboxName] = true; }
    catch (error) { cleanup[sandboxName] = false; cleanupErrors[sandboxName] = error instanceof Error ? error.message.replaceAll(credentials.token, '[redacted]') : 'Unknown error'; process.exitCode = 1; }
  }
  if (drive) {
    try {
      // Sandbox deletion can finish before the drive mount is detached.
      const until = Date.now() + 30_000;
      let detached = false;
      while (Date.now() < until) {
        const current = await Drive.get({ ...credentials, name, signal: AbortSignal.timeout(10_000) });
        if (!current.currentSessionId && !current.currentSandboxName) { detached = true; break; }
        await delay(500);
      }
      assert.ok(detached, 'Temporary drive did not detach after Sandbox deletion.');
      await drive.delete({ signal: AbortSignal.timeout(30_000) }); cleanup.drive = true;
    } catch (error) { cleanup.drive = false; cleanupErrors.drive = error instanceof Error ? error.message.replaceAll(credentials.token, '[redacted]') : 'Unknown error'; process.exitCode = 1; }
  }
  if (Object.values(cleanup).some(value => !value)) evidence.status = 'cleanup_failed';
  evidence.cleanup = cleanup; evidence.cleanupErrors = cleanupErrors; evidence.finishedAt = new Date().toISOString();
  const evidencePath = resolve(output, `${name}.json`);
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ status: evidence.status, cleanup, evidencePath, error: evidence.error }));
}
