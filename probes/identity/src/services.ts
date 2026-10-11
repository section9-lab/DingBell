import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './auth-schema.ts';
import { authOptions } from './auth-options.ts';
import { probeMail } from './probe-schema.ts';

export interface IdentityBindings {
  DB: D1Database;
  PROBE_TOKEN?: string;
  BETTER_AUTH_SECRET?: string;
  BASE_URL?: string;
  BOOTSTRAP_SECRET?: string;
  BOOTSTRAP_TEST_HOOKS?: string;
}

export function services(env: IdentityBindings, expectedUserId?: string) {
  const db = drizzle(env.DB, { schema });
  const auth = betterAuth({
    ...authOptions({
      baseURL: env.BASE_URL!, secret: env.BETTER_AUTH_SECRET!,
      async capture(mail) {
        const values = { ...mail, createdAt: Date.now() };
        await db.insert(probeMail).values(values).onConflictDoUpdate({
          target: [probeMail.email, probeMail.kind], set: values,
        });
      },
    }),
    // D1 has no interactive transactions; do not pretend these auth operations are atomic.
    database: drizzleAdapter(db, { provider: 'sqlite', schema, transaction: false }),
    ...(expectedUserId ? { advanced: { database: {
      generateId: ({ model }: { model: string }) => model === 'user' ? expectedUserId : crypto.randomUUID(),
    } } } : {}),
  });
  return { db, auth };
}
