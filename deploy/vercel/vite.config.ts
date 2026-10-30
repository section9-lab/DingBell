import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import { artifactGate } from '../artifact-gate.ts';
import { resolveRuntime } from '../resolve-runtime.ts';
export default defineConfig({
  root:fileURLToPath(new URL('../..',import.meta.url)),publicDir:false,
  resolve:{alias:{'just-bash':fileURLToPath(new URL('./no-code-execution.ts',import.meta.url))}},
  plugins:[resolveRuntime(),artifactGate()],
  ssr:{noExternal:true},
  build:{ssr:true,outDir:'dist/vercel',target:'node24',minify:false,
    rollupOptions:{input:Object.fromEntries(['app','harness','flow','maintenance'].map(name=>[name,fileURLToPath(new URL('./'+name+'.ts',import.meta.url))])),output:{entryFileNames:'[name].mjs'}}},
});
