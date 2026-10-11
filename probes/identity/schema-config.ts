import { betterAuth } from 'better-auth';
import { authOptions } from './src/auth-options.ts';

// CLI only: no database, network delivery or deployment credentials are needed to generate a schema.
export const auth = betterAuth(authOptions({
  baseURL: 'http://localhost:8787',
  secret: 'schema-generation-only-not-a-runtime-secret',
  capture: async () => {},
}));
