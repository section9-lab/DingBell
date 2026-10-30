import { fileURLToPath, URL } from 'node:url';
import { cloudflare, type PluginConfig, type WorkerConfig } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { artifactGate } from './deploy/artifact-gate.ts';
import { resolveRuntime } from './deploy/resolve-runtime.ts';
import { defineConfig, type ConfigEnv, type UserConfig } from 'vite';

export function createApplicationConfig(command: ConfigEnv['command'], options: {
  envDir?: string;
  runtime?: 'pi' | 'legacy';
  cloudflare?: Omit<PluginConfig, 'config'>;
  configureWorker?: (config: WorkerConfig) => void;
} = {}): UserConfig {
  const pi=options.runtime==='pi';
  return {
    envDir: options.envDir,
    resolve: { alias: { '@': fileURLToPath(new URL('./src/web', import.meta.url)) } },
    plugins: [...(pi ? [{name:'cloudflare-pi-runtime',enforce:'pre' as const,resolveId(source:string,importer?:string){
      if(source==='@earendil-works/pi-ai/providers/nvidia'&&!importer?.endsWith('/packages/agent-runtime/nvidia.ts'))return fileURLToPath(new URL('./packages/agent-runtime/nvidia.ts',import.meta.url));
      if(source.endsWith('/runtime-flue.ts'))return fileURLToPath(new URL('./src/platform/node/legacy-unavailable.ts',import.meta.url));
    }},resolveRuntime(),...(command==='build'?[artifactGate({cloudflare:true})]:[])] : [flue()]), react(), tailwindcss(), cloudflare({
      ...options.cloudflare,
      config(config) {
        if(pi)config.main=fileURLToPath(new URL('./src/platform/cloudflare/worker.ts',import.meta.url));
        else {
          delete config.main;
          config.durable_objects={...config.durable_objects,bindings:config.durable_objects?.bindings?.filter(binding=>binding.name!=='PI_AGENT')??[]};
          config.migrations=config.migrations?.filter(migration=>migration.tag!=='v6');
          flueWorkerConfig()(config);
        }
        options.configureWorker?.(config);
        // Build artifacts must not contain local secrets copied for vite preview.
        if (command === 'build') config.secrets = { required: [] };
      },
    })],
  };
}

export default defineConfig(({ command }) => createApplicationConfig(command,{runtime:'pi'}));
