import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/d1';
import type { IdentityBindings } from './bindings.ts';
import { authOptions, identityConfig } from './config.ts';
import * as schema from './schema.ts';
import { createMailer } from '../mail/resend.ts';
import type { IdentityDependencies, MailScheduler } from '../mail/types.ts';

function createServices(env: IdentityBindings, deps: IdentityDependencies, grant: {
  signup?: boolean; createOrganization?: boolean;
  ids?: { user?: string; organization?: string; member?: string };
} = {}, schedule?: MailScheduler, beforeMutation?: () => Promise<void>) {
  const config = identityConfig(env);
  if (!config) return null;
  const db = drizzle(env.DB!, { schema });
  const auth = betterAuth({
    ...authOptions(config, { ...grant, mailer: deps.mailer ?? createMailer(env) ?? undefined, schedule, beforeMutation }),
    // Authentication and business writes are not one interactive transaction in D1.
    database: drizzleAdapter(db, { provider: 'sqlite', schema, transaction: false }),
  });
  return { db, auth };
}

export function services(env: IdentityBindings, deps: IdentityDependencies = {}, schedule?: MailScheduler, beforeMutation?: () => Promise<void>) {
  return createServices(env, deps, {}, schedule, beforeMutation);
}

// These factories are server-only capabilities. Their handlers are never mounted publicly.
export function bootstrapServices(env: IdentityBindings, ids: { userId: string; organizationId: string; memberId: string }, deps: IdentityDependencies = {}) {
  return createServices(env, deps, { signup: true, createOrganization: true,
    ids: { user: ids.userId, organization: ids.organizationId, member: ids.memberId } });
}

export function invitationServices(env: IdentityBindings, ids: { userId?: string; memberId?: string }, deps: IdentityDependencies = {}) {
  return createServices(env, deps, { signup: !!ids.userId, ids: { user: ids.userId, member: ids.memberId } });
}
