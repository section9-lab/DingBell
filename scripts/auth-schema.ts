import { betterAuth } from 'better-auth/minimal';
import { authOptions } from '../src/modules/identity/config.ts';

// Schema generation only. These synthetic values are never used by the application.
export const auth = betterAuth(authOptions({
  baseURL: 'https://schema.invalid',
  secret: 'synthetic-schema-generation-only-secret',
}));
