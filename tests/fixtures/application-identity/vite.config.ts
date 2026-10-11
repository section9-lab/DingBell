import { fileURLToPath, URL } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  envDir: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [cloudflare({
    configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)),
    config(config) {
      config.secrets = { required: [] };
      config.vars = {
        APP_BASE_URL: process.env.DINGBELL_APPLICATION_IDENTITY_BASE_URL ?? '',
        BETTER_AUTH_SECRET: process.env.DINGBELL_APPLICATION_IDENTITY_SECRET ?? '',
      };
      if (process.env.DINGBELL_APPLICATION_IDENTITY_NO_DB === 'true') config.d1_databases = [];
    },
    persistState: { path: process.env.DINGBELL_APPLICATION_IDENTITY_STATE_PATH! },
    remoteBindings: false,
    inspectorPort: false,
  })],
});
