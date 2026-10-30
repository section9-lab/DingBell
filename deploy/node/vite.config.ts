import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { artifactGate } from '../artifact-gate.ts';

export default defineConfig(({ isSsrBuild }) => ({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  publicDir: isSsrBuild ? false : 'public',
  resolve: { alias: { '@': fileURLToPath(new URL('../../src/web', import.meta.url)),
     } },
  plugins: isSsrBuild ? [{ name: 'portable-runtime-only', enforce: 'pre', resolveId(source, importer) {
    if (source === '@earendil-works/pi-ai/providers/nvidia' && !importer?.endsWith('/packages/agent-runtime/nvidia.ts')) return fileURLToPath(new URL('../../packages/agent-runtime/nvidia.ts', import.meta.url));
    if (source.endsWith('/runtime-flue.ts') || source === './runtime-flue.ts') return fileURLToPath(new URL('../../src/platform/node/legacy-unavailable.ts', import.meta.url));
  } },artifactGate()] : [react(), tailwindcss()],
  ssr: { noExternal: true },
  build: { outDir: isSsrBuild ? 'dist/node/server' : 'dist/node/client', target: isSsrBuild ? 'node24' : 'es2022',
    rollupOptions: isSsrBuild ? { input: {server:fileURLToPath(new URL('../../src/platform/node/main.ts',import.meta.url)),application:fileURLToPath(new URL('../../src/platform/node/application.ts',import.meta.url))},output: { entryFileNames: '[name].mjs' } } : undefined },
}));
