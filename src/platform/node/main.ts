import { resolve } from 'node:path';
import { serveNode } from './server.ts';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
const runtime = await serveNode({ port, hostname: process.env.HOST ?? '127.0.0.1', variables: process.env,
  dataDirectory: resolve(process.env.DINGBELL_DATA_DIR ?? './data'),
  migrationsDirectory: resolve(process.env.DINGBELL_MIGRATIONS_DIR ?? './migrations'),
  assetsDirectory: resolve(process.env.DINGBELL_ASSETS_DIR ?? './dist/node/client') });
process.stdout.write('DingBell HTTP server ready.\n');
let closing = false;
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, async () => {
  if (closing) return; closing = true; await runtime.close(); process.exitCode = 0;
});
