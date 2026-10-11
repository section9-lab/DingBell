import { fileURLToPath, URL } from 'node:url';
import { cloudflare, type PluginConfig, type WorkerConfig } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type ConfigEnv, type UserConfig } from 'vite';

export function createApplicationConfig(command: ConfigEnv['command'], options: {
  envDir?: string;
  cloudflare?: Omit<PluginConfig, 'config'>;
  configureWorker?: (config: WorkerConfig) => void;
} = {}): UserConfig {
  return {
    envDir: options.envDir,
    resolve: { alias: { '@': fileURLToPath(new URL('./src/web', import.meta.url)) } },
    plugins: [flue(), react(), tailwindcss(), cloudflare({
      ...options.cloudflare,
      config(config) {
        flueWorkerConfig()(config);
        options.configureWorker?.(config);
        // Build artifacts must not contain local secrets copied for vite preview.
        if (command === 'build') config.secrets = { required: [] };
      },
    })],
  };
}

export default defineConfig(({ command }) => createApplicationConfig(command));
