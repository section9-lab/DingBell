import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createNvidiaProvider } from './probe.ts';
import { readEvaluationConfig, runEvaluation } from './eval.ts';

// Explicit opt-in is checked before credentials or output directories are used.
// This runner never reads .env; its caller supplies the environment.
const config = readEvaluationConfig({
  DINGBELL_NVIDIA_EVAL: process.env.DINGBELL_NVIDIA_EVAL,
  DINGBELL_NVIDIA_EVAL_CASES: process.env.DINGBELL_NVIDIA_EVAL_CASES,
  NVAPI_KEY: process.env.NVAPI_KEY, NVAPI_MODEL: process.env.NVAPI_MODEL, NVAPI_URL: process.env.NVAPI_URL,
});
const directory = resolve(process.argv[2] ?? `test-results/nvidia-eval-${Date.now()}`);
await mkdir(directory, { recursive: false, mode: 0o700 });
const deadline = setTimeout(() => {
  console.error('NVIDIA_EVAL_FAILED process_deadline');
  process.exit(1);
}, config.caseIds.length * 60_000);
try {
  const result = await runEvaluation(createNvidiaProvider(config.modelId), config.modelId, join(directory, 'synthetic.sqlite'), config.apiKey, config.caseIds);
  await writeFile(join(directory, 'result.json'), JSON.stringify({ checkedAt: new Date().toISOString(), ...result }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('NVIDIA_EVAL_RESULT ' + JSON.stringify({
    cases: result.cases.map(item => ({ id: item.id, execution: item.execution, objectiveChecksPassed: item.objectiveChecksPassed, failures: item.failures })),
    modelCalls: result.modelCalls, httpRequests: result.httpRequests, reviewStatus: result.reviewStatus,
  }));
  if (result.cases.some(item => !item.objectiveChecksPassed)) process.exitCode = 1;
} catch {
  console.error('NVIDIA_EVAL_FAILED; no automatic retry or model fallback was attempted.');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
