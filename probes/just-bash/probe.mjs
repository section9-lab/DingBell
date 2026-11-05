import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const directory = dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'dingbell-just-bash-'));
let worker;
try {
  const outfile = join(temporary, 'worker.mjs');
  await build({
    entryPoints: [join(directory, 'worker.ts')], bundle: true, platform: 'browser', format: 'esm',
    external: ['node:zlib'], outfile, logLevel: 'silent',
  });
  const script = await readFile(outfile, 'utf8');
  worker = new Miniflare({ modules: true, script, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'] });
  for (const [query, expected, code] of [
    ['退货', '2:退货政策：需要人工确认\n', 0],
    ['ВОЗВРАТ', '3:ВОЗВРАТ товара\n', 0],
    ['$(echo injected)', '4:$(echo injected)\n', 0],
    ['--not-an-option', '', 1],
  ]) {
    const response = await worker.dispatchFetch(`http://localhost/?query=${encodeURIComponent(query)}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { stdout: expected, stderr: '', exitCode: code });
  }
  const applicationCore = await worker.dispatchFetch('http://localhost/?applicationCore=1');
  assert.equal(applicationCore.status, 200);
  assert.deepEqual(await applicationCore.json(), {
    stdout: '2:退货政策：需要人工确认\n', stderr: '', exitCode: 0, canSend: false,
  });
  const readonly = await worker.dispatchFetch('http://localhost/?probeReadonly=1');
  assert.equal(readonly.status, 200);
  // Document the current dependency behavior, not a desired security property.
  assert.deepEqual(await readonly.json(), { writeExitCode: 0, stdout: 'modified\n' });
  console.log(`just-bash Workers probe passed; chmod does not enforce read-only; bundled bytes: ${Buffer.byteLength(script)}`);
} finally {
  await worker?.dispose();
  await rm(temporary, { recursive: true, force: true });
}
