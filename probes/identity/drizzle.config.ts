import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: ['./probes/identity/src/auth-schema.ts', './probes/identity/src/probe-schema.ts'],
  out: './probes/identity/migrations',
  dialect: 'sqlite',
});
