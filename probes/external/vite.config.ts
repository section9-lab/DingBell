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
        if (command === 'build') config.secrets = { required: [] };
      },
      remoteBindings: false,
      inspectorPort: false,
    }),
  ],
}));
