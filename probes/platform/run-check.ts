import { parseArgs } from 'node:util';
import { checkAuthorization, checkCron, checkQueues, checkR2 } from './check.ts';

const { values } = parseArgs({ options: {
  url: { type: 'string' }, mode: { type: 'string', default: 'all' }, local: { type: 'boolean', default: false },
  'cron-timeout-ms': { type: 'string', default: '90000' }, cron: { type: 'string', default: '* * * * *' },
} });
const url = values.url ?? process.env.DINGBELL_PLATFORM_URL;
const token = process.env.DINGBELL_PLATFORM_TOKEN;
const timeoutMs = Number(values['cron-timeout-ms']);
if (!url || !token || !['all', 'queue-cron'].includes(values.mode!) || !Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1_200_000) {
  throw new Error('Set DINGBELL_PLATFORM_URL and DINGBELL_PLATFORM_TOKEN; --mode must be all or queue-cron; cron timeout must be 1000–1200000 ms.');
}
const baseURL = new URL(url);
if (values.local && !['127.0.0.1', 'localhost', '[::1]'].includes(baseURL.hostname)) {
  throw new Error('--local only invokes the development scheduled endpoint on loopback hosts.');
}

await checkAuthorization(url, token);
const r2 = values.mode === 'all' ? await checkR2(url, token) : { status: 'NOT_RUN', reason: 'Explicit queue-cron mode; R2 remains unverified.' };
const queues = await checkQueues(url, token);
const cron = await checkCron(url, token, { local: values.local, cron: values.cron, timeoutMs });
console.log(JSON.stringify({ environment: values.local ? 'local-workerd' : 'cloud', authorization: 'PASS', r2, queues, cron }, null, 2));
