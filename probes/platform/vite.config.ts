import { fileURLToPath, URL } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    flue({ agents: 'agents/**/*.ts', providers: [], tracing: false }),
    cloudflare({
      configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)),
      config(config) {
        flueWorkerConfig()(config);
        const queue = process.env.DINGBELL_PLATFORM_QUEUE ?? 'dingbell-platform-probe';
        const dlq = process.env.DINGBELL_PLATFORM_DLQ ?? 'dingbell-platform-probe-dlq';
        if (queue === dlq) throw new Error('The probe queue and its DLQ must be different queues.');
        config.queues!.producers![0].queue = queue;
        config.queues!.consumers![0].queue = queue;
        config.queues!.consumers![0].dead_letter_queue = dlq;
        config.queues!.consumers![1].queue = dlq;
        config.vars = { ...config.vars, PROBE_QUEUE_NAME: queue, PROBE_DLQ_NAME: dlq };
        if (process.env.DINGBELL_PLATFORM_SKIP_R2 === '1') config.r2_buckets = [];
        else config.r2_buckets![0].bucket_name = process.env.DINGBELL_PLATFORM_BUCKET ?? 'dingbell-platform-probe';
        config.triggers = { crons: process.env.DINGBELL_PLATFORM_CRON ? [process.env.DINGBELL_PLATFORM_CRON] : [] };
        if (command === 'serve') config.vars.PROBE_TOKEN = process.env.DINGBELL_PLATFORM_TOKEN ?? '';
      },
      persistState: process.env.DINGBELL_PLATFORM_STATE_PATH
        ? { path: process.env.DINGBELL_PLATFORM_STATE_PATH }
        : true,
      remoteBindings: false,
      inspectorPort: false,
    }),
  ],
}));
