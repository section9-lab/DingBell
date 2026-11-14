import { fileURLToPath, URL } from 'node:url';
import { cloudflare, type PluginConfig, type WorkerConfig } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { artifactGate } from './deploy/artifact-gate.ts';
import { resolveRuntime } from './deploy/resolve-runtime.ts';
import { defineConfig, type ConfigEnv, type UserConfig } from 'vite';

export function createApplicationConfig(command: ConfigEnv['command'], options: {
  envDir?: string;
  cloudflare?: Omit<PluginConfig, 'config'>;
  configureWorker?: (config: WorkerConfig) => void;
} = {}): UserConfig {
  return {
    envDir: options.envDir,
    resolve: { alias: { '@': fileURLToPath(new URL('./src/web', import.meta.url)) } },
    // The worker environment is named after the Wrangler worker. Prebundle this
    // CJS dependency so dev startup can evaluate @earendil-works/pi-ai.
    environments: { dingbell: { optimizeDeps: { include: ['partial-json'] } } },
    plugins: [{name:'cloudflare-pi-runtime',enforce:'pre' as const,resolveId(source:string,importer?:string){
      if(source==='@earendil-works/pi-ai/providers/nvidia'&&!importer?.endsWith('/packages/agent-runtime/nvidia.ts'))return fileURLToPath(new URL('./packages/agent-runtime/nvidia.ts',import.meta.url));
    }},resolveRuntime(),...(command==='build'?[artifactGate({cloudflare:true})]:[]), react(), tailwindcss(), cloudflare({
      ...options.cloudflare,
      // A production build may point at a deployment-specific Wrangler configuration that
      // carries the real D1 database ID. Local development keeps the checked-in local-only
      // placeholder so `demo:local` cannot seed a remote database.
      configPath: options.cloudflare?.configPath ?? (process.env.DINGBELL_WRANGLER_CONFIG
        ? fileURLToPath(new URL(process.env.DINGBELL_WRANGLER_CONFIG, import.meta.url))
        : undefined),
      config(config) {
        config.main=fileURLToPath(new URL('./src/platform/cloudflare/worker.ts',import.meta.url));
        options.configureWorker?.(config);
        // Build artifacts must not contain local secrets copied for vite preview.
        if (command === 'build') config.secrets = { required: [] };
      },
    })],
  };
}

export default defineConfig(({ command }) => createApplicationConfig(command));
