import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createNvidiaProvider, readConfig, runSyntheticProbe } from './probe.ts';

// The caller supplies environment variables. This script never reads a .env file.
const config = readConfig({ NVAPI_KEY: process.env.NVAPI_KEY, NVAPI_URL: process.env.NVAPI_URL, NVAPI_MODEL: process.env.NVAPI_MODEL });
const provider = createNvidiaProvider(config.modelId);
const directory = resolve(process.argv[2] ?? `test-results/nvidia-local-${Date.now()}`);
await mkdir(directory, { recursive: false, mode: 0o700 });
const deadline = setTimeout(() => {
  console.error('NVIDIA_PROBE_FAILED process_deadline');
  process.exit(1);
}, 150_000);
try {
  const result = await runSyntheticProbe(provider, config.modelId, join(directory, 'synthetic.sqlite'), config.apiKey);
  await writeFile(join(directory, 'result.json'), JSON.stringify({ checkedAt: new Date().toISOString(), ...result }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('NVIDIA_PROBE_RESULT ' + JSON.stringify(result));
} catch {
  // Never serialize provider errors, environment, request headers, or credentials.
  console.error('NVIDIA_PROBE_FAILED; no automatic retry or provider fallback was attempted.');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
