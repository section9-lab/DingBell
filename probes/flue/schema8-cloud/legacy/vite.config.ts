import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig } from 'vite';
export default defineConfig(({ command }) => ({ plugins: [flue(), cloudflare({ config(config) { flueWorkerConfig()(config); if(command === 'serve' && process.env.DINGBELL_SCHEMA8_TOKEN) config.vars = { ...config.vars, PROBE_TOKEN: process.env.DINGBELL_SCHEMA8_TOKEN }; }, persistState: process.env.DINGBELL_SCHEMA8_STATE ? { path: process.env.DINGBELL_SCHEMA8_STATE } : true, remoteBindings:false, inspectorPort:false })] }));
