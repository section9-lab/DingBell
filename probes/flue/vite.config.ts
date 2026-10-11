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
        if (command === 'serve' && process.env.DINGBELL_PROBE_TOKEN) {
          config.vars = { ...config.vars, PROBE_TOKEN: process.env.DINGBELL_PROBE_TOKEN };
        }
        if (command === 'serve' && process.env.DINGBELL_PROBE_GATE_URL) {
          config.vars = { ...config.vars, PROBE_GATE_URL: process.env.DINGBELL_PROBE_GATE_URL };
        }
      },
      persistState: process.env.DINGBELL_PROBE_STATE_PATH
        ? { path: process.env.DINGBELL_PROBE_STATE_PATH }
        : true,
      remoteBindings: false,
      inspectorPort: false,
    }),
  ],
}));
