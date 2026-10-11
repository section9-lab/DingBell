import { and, eq, gt, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { timingSafeEqual } from 'hono/utils/buffer';
import * as v from 'valibot';
import { apiError, jsonResponse, type ApplicationEnv } from '../../http.ts';
import { identityConfig } from '../identity/config.ts';
import { bootstrapServices } from '../identity/services.ts';
import type { IdentityBindings } from '../identity/bindings.ts';
import * as identitySchema from '../identity/schema.ts';
import { mailConfigured } from '../mail/config.ts';
import type { IdentityDependencies } from '../mail/types.ts';
import { auditedChange, type AuditOutcome } from '../audit/operation.ts';
import { identityAuditEvent } from '../audit/schema.ts';
import { bootstrapInstallation, type BootstrapJob } from './schema.ts';

const bootstrapSecret = (env: IdentityBindings) => typeof env.BOOTSTRAP_SECRET === 'string'
  && env.BOOTSTRAP_SECRET.trim().length >= 32 ? env.BOOTSTRAP_SECRET : null;

const claimSchema = v.strictObject({
  claimId: v.pipe(v.string(), v.uuid()),
  email: v.pipe(v.string(), v.trim(), v.email(), v.maxLength(254), v.toLowerCase()),
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  organizationName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
});
const resumeSchema = v.strictObject({
  claimId: v.pipe(v.string(), v.uuid()),
  password: v.pipe(v.string(), v.minLength(8), v.maxLength(128)),
});
const leaseMs = 120_000;
const verificationCooldownMs = 60_000;

class BootstrapConflict extends Error {}

const limitedBody = bodyLimit({ maxSize: 4096,
  onError: c => apiError(c, 'REQUEST_TOO_LARGE', 'The request is too large.', 413),
});

async function authorized(c: Context<ApplicationEnv>) {
  const secret = bootstrapSecret(c.env ?? {});
  const header = c.req.header('authorization') ?? '';
  return !!secret && header.length <= 512 && /^Bearer /i.test(header)
    && await timingSafeEqual(secret, header.slice(7));
}

async function currentJob(env: IdentityBindings) {
  return env.DB ? drizzle(env.DB).select().from(bootstrapInstallation).where(eq(bootstrapInstallation.id, 1)).get() : undefined;
}

async function progress(env: IdentityBindings, job: BootstrapJob) {
  if (job.state === 'initialized') return 'initialized';
  const db = drizzle(env.DB!);
  const user = await db.select().from(identitySchema.user).where(eq(identitySchema.user.email, job.email)).get();
  if (!user) return 'account_pending';
  if (user.id !== job.expectedUserId) return 'blocked';
  const credential = await db.select({ password: identitySchema.account.password }).from(identitySchema.account).where(and(
    eq(identitySchema.account.userId, user.id), eq(identitySchema.account.providerId, 'credential'),
  )).get();
  if (!credential?.password) return 'password_recovery_required';
  return user.emailVerified ? 'organization_pending' : 'email_verification_required';
}

async function status(c: Context<ApplicationEnv>, deps: IdentityDependencies, privileged: boolean) {
  const env = c.env ?? {};
  const job = await currentJob(env);
  return {
    state: env.DB ? job?.state ?? 'unclaimed' : 'unavailable',
    configured: !!identityConfig(env) && !!bootstrapSecret(env),
    emailConfigured: mailConfigured(env, deps),
    ...(privileged && job ? { claim: {
      claimId: job.claimId, email: job.email, name: job.name, organizationName: job.organizationName,
      step: await progress(env, job),
    } } : {}),
  };
}

async function audited(c: Context<ApplicationEnv>, action: string, operation: () => Promise<Response>) {
  const record = async (outcome: AuditOutcome) => {
    await drizzle(c.env.DB!).insert(identityAuditEvent).values({
      id: crypto.randomUUID(), requestId: c.get('requestId'), action, outcome, createdAt: new Date(),
    });
  };
  const result = await auditedChange(record, operation);
  return result.auditComplete ? result.response
    : apiError(c, 'OPERATION_UNCONFIRMED', 'Read installation progress before retrying.', 503, result.response);
}

export function registerBootstrapRoutes(app: Hono<ApplicationEnv>, deps: IdentityDependencies = {}) {
  const protectedWrite: MiddlewareHandler<ApplicationEnv> = async (c, next) => {
    const config = identityConfig(c.env ?? {});
    if (!config || !bootstrapSecret(c.env)) return apiError(c, 'BOOTSTRAP_NOT_CONFIGURED', 'Installation requires authentication and a bootstrap secret.', 503);
    if (new URL(c.req.url).search) return apiError(c, 'INVALID_REQUEST', 'Bootstrap credentials are accepted only in the authorization header.', 400);
    if (!await authorized(c)) return apiError(c, 'BOOTSTRAP_UNAUTHORIZED', 'The installation credential is invalid.', 401);
    if (c.req.header('origin') !== config.baseURL || c.req.header('sec-fetch-site') === 'cross-site') return apiError(c, 'ORIGIN_REJECTED', 'This request origin is not allowed.', 403);
    if (!mailConfigured(c.env, deps)) return apiError(c, 'MAIL_NOT_CONFIGURED', 'Configure verification email before starting installation.', 503);
    await next();
  };
  app.get('/api/bootstrap', async c => {
    if (new URL(c.req.url).search) return apiError(c, 'INVALID_REQUEST', 'Bootstrap credentials are accepted only in the authorization header.', 400);
    const privileged = await authorized(c);
    if (c.req.header('authorization') && !privileged) return apiError(c, 'BOOTSTRAP_UNAUTHORIZED', 'The installation credential is invalid.', 401);
    return jsonResponse(c, await status(c, deps, privileged));
  });

  app.post('/api/bootstrap/claim', protectedWrite, limitedBody, async c => {
    const parsed = v.safeParse(claimSchema, await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'INVALID_REQUEST', 'Provide a claim ID, email, name and company name.', 400);
    const input = parsed.output;
    return audited(c, 'bootstrap.claim', async () => {
      const db = drizzle(c.env.DB!);
      let job = await currentJob(c.env);
      let created = false;
      if (!job) {
        const existingUser = await db.select({ id: identitySchema.user.id }).from(identitySchema.user).limit(1).get();
        const existingCompany = await db.select({ id: identitySchema.organization.id }).from(identitySchema.organization).limit(1).get();
        if (existingUser || existingCompany) return apiError(c, 'BOOTSTRAP_ALREADY_POPULATED', 'Existing identities cannot be promoted by installation.', 409);
        const inserted = await db.insert(bootstrapInstallation).values({
          id: 1, ...input, expectedUserId: crypto.randomUUID(), expectedOrganizationId: crypto.randomUUID(),
          expectedMemberId: crypto.randomUUID(), state: 'provisioning', createdAt: Date.now(), updatedAt: Date.now(),
        }).onConflictDoNothing().returning().get();
        created = !!inserted;
        job = inserted ?? await currentJob(c.env);
      }
      if (job?.state === 'initialized') return apiError(c, 'BOOTSTRAP_CLOSED', 'Installation is already complete.', 410);
      if (!job || job.claimId !== input.claimId || job.email !== input.email
        || job.name !== input.name || job.organizationName !== input.organizationName) {
        return apiError(c, 'BOOTSTRAP_ALREADY_CLAIMED', 'Resume the existing installation claim.', 409);
      }
      return jsonResponse(c, await status(c, deps, true), created ? 201 : 200);
    });
  });

  app.post('/api/bootstrap/resume', protectedWrite, limitedBody, async c => {
    const parsed = v.safeParse(resumeSchema, await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'INVALID_REQUEST', 'Provide the existing claim ID and password.', 400);
    return audited(c, 'bootstrap.resume', async () => {
      const { claimId, password } = parsed.output;
      const db = drizzle(c.env.DB!);
      if ((await currentJob(c.env))?.state === 'initialized') return apiError(c, 'BOOTSTRAP_CLOSED', 'Installation is already complete.', 410);
      const executionId = crypto.randomUUID();
      const now = Date.now();
      const job = await db.update(bootstrapInstallation).set({ executionId, leaseUntil: now + leaseMs, updatedAt: now }).where(and(
        eq(bootstrapInstallation.id, 1), eq(bootstrapInstallation.claimId, claimId),
        eq(bootstrapInstallation.state, 'provisioning'), lte(bootstrapInstallation.leaseUntil, now),
      )).returning().get();
      if (!job) return apiError(c, 'BOOTSTRAP_BUSY', 'The claim is invalid or another installation attempt is running.', 409);
      const checkpoint = async (values: Partial<Pick<BootstrapJob, 'userId' | 'organizationId' | 'state' | 'executionId' | 'leaseUntil' | 'verificationRequestedAt'>>) => {
        const updated = await db.update(bootstrapInstallation).set({ ...values, updatedAt: Date.now() }).where(and(
          eq(bootstrapInstallation.id, 1), eq(bootstrapInstallation.claimId, claimId),
          eq(bootstrapInstallation.executionId, executionId), eq(bootstrapInstallation.state, 'provisioning'),
          gt(bootstrapInstallation.leaseUntil, Date.now()),
        )).returning().get();
        if (!updated) throw new BootstrapConflict('Installation lease was lost.');
      };
      const renew = () => checkpoint({ leaseUntil: Date.now() + leaseMs });
      const { auth } = bootstrapServices(c.env, {
        userId: job.expectedUserId, organizationId: job.expectedOrganizationId, memberId: job.expectedMemberId,
      }, deps)!;
      try {
        const findUser = () => db.select().from(identitySchema.user).where(eq(identitySchema.user.email, job.email)).get();
        let user = await findUser();
        if (!user) {
          await renew();
          await auth.api.signUpEmail({ body: { email: job.email, name: job.name, password } });
          user = await findUser();
        }
        // Duplicate-email signup may return a synthetic success. Only persisted IDs prove ownership.
        if (!user || user.id !== job.expectedUserId) throw new BootstrapConflict('The claimed identity does not match.');
        await checkpoint({ userId: user.id });
        const credentials = await db.select().from(identitySchema.account).where(and(
          eq(identitySchema.account.userId, user.id), eq(identitySchema.account.providerId, 'credential'),
        ));
        if (credentials.length > 1) throw new BootstrapConflict('Credential records are ambiguous.');
        const needsPassword = !credentials[0]?.password;
        if (!user.emailVerified) {
          if (!job.verificationRequestedAt || Date.now() - job.verificationRequestedAt >= verificationCooldownMs) {
            await renew();
            await auth.api.sendVerificationEmail({ body: { email: job.email } });
            await checkpoint({ verificationRequestedAt: Date.now() });
          }
          return jsonResponse(c, { state: 'provisioning', step: needsPassword ? 'password_recovery_required' : 'email_verification_required', verificationEmail: 'accepted' }, 202);
        }
        if (needsPassword) return jsonResponse(c, { state: 'provisioning', step: 'password_recovery_required' }, 202);

        await renew();
        const login = await auth.api.signInEmail({ body: { email: job.email, password }, asResponse: true });
        if (!login.ok) return apiError(c, 'INVALID_CREDENTIALS', 'The verified account password is required.', 401);
        const authenticated = await login.clone().json() as { user?: { id?: string; emailVerified?: boolean } };
        if (authenticated.user?.id !== job.expectedUserId || !authenticated.user.emailVerified) throw new BootstrapConflict('Verified login does not match the installation claim.');

        const slug = `setup-${job.claimId}`;
        const findCompany = () => db.select().from(identitySchema.organization).where(eq(identitySchema.organization.slug, slug)).get();
        let company = await findCompany();
        if (!company) {
          await renew();
          try { await auth.api.createOrganization({ body: { name: job.organizationName, slug, userId: user.id } }); }
          catch (error) { if (!await findCompany()) throw error; }
          company = await findCompany();
        }
        if (!company || company.id !== job.expectedOrganizationId || company.name !== job.organizationName) throw new BootstrapConflict('Company identity does not match the installation claim.');
        const findMembers = () => db.select().from(identitySchema.member).where(eq(identitySchema.member.organizationId, company!.id));
        let members = await findMembers();
        if (!members.length) {
          await renew();
          // The SDK may have created the reserved company before interruption at its member write.
          try { await auth.api.addMember({ body: { organizationId: company.id, userId: user.id, role: 'owner' } }); }
          catch (error) { if (!(await findMembers()).length) throw error; }
          members = await findMembers();
        }
        if (members.length !== 1 || members[0].id !== job.expectedMemberId
          || members[0].userId !== job.expectedUserId || members[0].role !== 'owner') throw new BootstrapConflict('Company ownership does not match the installation claim.');
        await checkpoint({ organizationId: company.id, state: 'initialized', executionId: null, leaseUntil: 0 });
        return jsonResponse(c, { state: 'initialized', organizationId: company.id }, 200, login);
      } catch (error) {
        return error instanceof BootstrapConflict
          ? apiError(c, 'BOOTSTRAP_CONFLICT', 'Installation ownership or its execution lease no longer matches. Read progress before retrying.', 409)
          : apiError(c, 'BOOTSTRAP_STEP_UNCONFIRMED', 'The installation step was interrupted. Read progress and resume the same claim.', 503);
      } finally {
        await db.update(bootstrapInstallation).set({ executionId: null, leaseUntil: 0, updatedAt: Date.now() }).where(and(
          eq(bootstrapInstallation.id, 1), eq(bootstrapInstallation.executionId, executionId), eq(bootstrapInstallation.state, 'provisioning'),
        )).catch(() => {});
      }
    });
  });
}
