import { fileURLToPath, URL } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [cloudflare({
    configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)),
    config(config) {
      if (process.env.DINGBELL_IDENTITY_DB_ID) {
        config.d1_databases![0].database_id = process.env.DINGBELL_IDENTITY_DB_ID;
      }
      if (command === 'serve') {
        config.vars = {
          PROBE_TOKEN: process.env.DINGBELL_IDENTITY_TOKEN ?? '',
          BETTER_AUTH_SECRET: process.env.DINGBELL_IDENTITY_AUTH_SECRET ?? '',
          BASE_URL: process.env.DINGBELL_IDENTITY_BASE_URL ?? '',
          BOOTSTRAP_SECRET: process.env.DINGBELL_IDENTITY_BOOTSTRAP_SECRET ?? '',
          BOOTSTRAP_TEST_HOOKS: process.env.DINGBELL_IDENTITY_BOOTSTRAP_TEST_HOOKS ?? '',
        };
      }
    },
    persistState: process.env.DINGBELL_IDENTITY_STATE_PATH
      ? { path: process.env.DINGBELL_IDENTITY_STATE_PATH }
      : true,
    remoteBindings: false,
    inspectorPort: false,
  })],
}));
