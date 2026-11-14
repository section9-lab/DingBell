import { and, asc, eq } from 'drizzle-orm';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { apiError, authError, jsonResponse, type ApplicationEnv, type IdentitySession } from '../../http.ts';
import { auditedChange, type AuditOutcome } from '../audit/operation.ts';
import { identityAuditEvent } from '../audit/schema.ts';
import { isMailbox, mailConfigured } from '../mail/config.ts';
import type { IdentityDependencies } from '../mail/types.ts';
import { identityConfig } from './config.ts';
import * as schema from './schema.ts';
import { services } from './services.ts';

export const configured: MiddlewareHandler<ApplicationEnv> = async (c, next) => {
  const config = identityConfig(c.env ?? {});
  if (!config) return apiError(c, 'IDENTITY_NOT_CONFIGURED', 'Identity service requires database and authentication configuration.', 503);
  if (c.req.method !== 'GET' && (c.req.header('origin') !== config.baseURL || c.req.header('sec-fetch-site') === 'cross-site')) {
    return apiError(c, 'ORIGIN_REJECTED', 'This request origin is not allowed.', 403);
  }
  c.set('identity', services(c.env)!);
  await next();
};

export const signedIn: MiddlewareHandler<ApplicationEnv> = async (c, next) => {
  const session = await c.get('identity').auth.api.getSession({
    headers: c.req.raw.headers, query: { disableCookieCache: true, disableRefresh: true },
  });
  if (!session || !session.user.emailVerified) return apiError(c, 'UNAUTHENTICATED', 'A verified account session is required.', 401);
  c.set('identitySession', session);
  await next();
};

export const limitedBody = bodyLimit({
  maxSize: 16 * 1024,
  onError: c => apiError(c, 'REQUEST_TOO_LARGE', 'The request is too large.', 413),
});

const companyFields = { id: schema.organization.id, name: schema.organization.name, slug: schema.organization.slug, role: schema.member.role };
export async function companyFor(c: Context<ApplicationEnv>, organizationId: string, userId: string) {
  return c.get('identity').db.select(companyFields).from(schema.organization).innerJoin(schema.member, and(
    eq(schema.member.organizationId, schema.organization.id), eq(schema.member.userId, userId),
  )).where(eq(schema.organization.id, organizationId)).get();
}

export function userDTO(user: IdentitySession['user']) {
  return { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified, image: user.image ?? null };
}

export function recorder(c: Context<ApplicationEnv>, action: string, actorUserId?: string, organizationId?: string,
  context: { targetMemberId?: string; beforeRole?: string; afterRole?: string | null } = {}) {
  return async (outcome: AuditOutcome) => {
    await c.get('identity').db.insert(identityAuditEvent).values({
      id: crypto.randomUUID(), requestId: c.get('requestId'), action, outcome,
      actorUserId: actorUserId ?? null, organizationId: organizationId ?? null, ...context, createdAt: new Date(),
    });
  };
}

function unconfirmed(c: Context<ApplicationEnv>, response: Response) {
  return apiError(c, 'OPERATION_UNCONFIRMED', 'The operation may have completed. Refresh the session to confirm its state.', 503, response);
}

type WorkspaceSetup = { identity: { configured: boolean }; registration: { enabled: boolean }; email: { configured: boolean } };

export function registerIdentityRoutes(app: Hono<ApplicationEnv>, workspaceSetup?: (c: Context<ApplicationEnv>) => WorkspaceSetup, dependencies: IdentityDependencies = {}) {
  if (workspaceSetup) app.get('/api/workspace-bootstrap', async c => {
    const setup = workspaceSetup(c);
    if (!setup.identity.configured) return jsonResponse(c, { setup, session: null, companies: null });
    const identity = services(c.env ?? {});
    if (!identity) return apiError(c, 'IDENTITY_NOT_CONFIGURED', 'Identity service requires database and authentication configuration.', 503);
    c.set('identity', identity);
    const value = await identity.auth.api.getSession({
      headers: c.req.raw.headers, query: { disableCookieCache: true, disableRefresh: true },
    });
    if (!value || !value.user.emailVerified) return jsonResponse(c, { setup, session: null, companies: null });
    const companies = await identity.db.select(companyFields).from(schema.organization).innerJoin(schema.member, and(
      eq(schema.member.organizationId, schema.organization.id), eq(schema.member.userId, value.user.id),
    )).orderBy(asc(schema.organization.name), asc(schema.organization.id));
    const activeCompanyId = companies.find(company => company.id === value.session.activeOrganizationId)?.id ?? null;
    return jsonResponse(c, {
      setup,
      session: { user: userDTO(value.user), session: { id: value.session.id, expiresAt: value.session.expiresAt, activeOrganizationId: activeCompanyId } },
      companies: { companies, activeCompanyId },
    });
  });

  app.get('/api/auth/get-session', configured, async c => {
    const response = await c.get('identity').auth.handler(c.req.raw);
    if (!response.ok) return authError(c, response);
    const value = await response.json() as IdentitySession | null;
    if (!value) return jsonResponse(c, null, 200, response);
    if (!value.user.emailVerified) return apiError(c, 'UNAUTHENTICATED', 'A verified account session is required.', 401, response);
    const active = value.session.activeOrganizationId;
    const activeCompany = active ? await companyFor(c, active, value.user.id) : null;
    return jsonResponse(c, {
      user: userDTO(value.user),
      session: { id: value.session.id, expiresAt: value.session.expiresAt, activeOrganizationId: activeCompany?.id ?? null },
    }, 200, response);
  });

  app.post('/api/auth/sign-in/email', configured, limitedBody, async c => {
    const body: unknown = await c.req.raw.clone().json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['email', 'password', 'rememberMe'].includes(key))) {
      return apiError(c, 'INVALID_REQUEST', 'Provide only email, password and optional rememberMe.', 400);
    }
    const response = await c.get('identity').auth.handler(c.req.raw);
    // Let the SDK enforce its persistent rate limit before adding audit writes.
    if (response.status === 429) return authError(c, response);
    try {
      const value = response.ok ? await response.json() as { user: IdentitySession['user'] } : null;
      const payload = value ? { user: userDTO(value.user), redirect: false } : null;
      await recorder(c, 'auth.sign_in', value?.user.id)(response.ok ? 'succeeded' : response.status < 500 ? 'rejected' : 'unknown');
      if (!response.ok) return authError(c, response, true);
      return jsonResponse(c, payload, 200, response);
    } catch { return unconfirmed(c, response); }
  });

  app.post('/api/auth/sign-in/email-otp', configured, limitedBody, async c => {
    const body: unknown = await c.req.raw.clone().json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 2
      || typeof (body as { email?: unknown }).email !== 'string'
      || !isMailbox((body as { email: string }).email)
      || typeof (body as { otp?: unknown }).otp !== 'string'
      || !/^\d{6}$/.test((body as { otp: string }).otp)) {
      return apiError(c, 'INVALID_REQUEST', 'Provide only the email address and the six-digit code.', 400);
    }
    const email = (body as { email: string }).email.trim().toLowerCase();
    const otp = (body as { otp: string }).otp;
    const identity = services(c.env, dependencies)!;
    c.set('identity', identity);
    const existing = await identity.db.select({ id: schema.user.id, emailVerified: schema.user.emailVerified })
      .from(schema.user).where(eq(schema.user.email, email)).get();
    if (existing && !existing.emailVerified) {
      // Prove the code before promoting a legacy unverified account. Better Auth
      // otherwise removes its credential account, which would break password sign-in.
      try {
        const api = identity.auth.api as typeof identity.auth.api & {
          checkVerificationOTP: (input: { body: { email: string; type: 'sign-in'; otp: string } }) => Promise<unknown>;
        };
        await api.checkVerificationOTP({ body: { email, type: 'sign-in', otp } });
      } catch {
        return apiError(c, 'INVALID_OTP', 'The code is invalid or expired.', 400);
      }
      await identity.db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, existing.id));
      const promoted = await identity.db.select({ emailVerified: schema.user.emailVerified })
        .from(schema.user).where(eq(schema.user.id, existing.id)).get();
      if (!promoted?.emailVerified) return apiError(c, 'IDENTITY_UNAVAILABLE', 'The account could not be verified safely.', 503);
    }
    const response = await identity.auth.handler(c.req.raw);
    if (response.status === 429) return authError(c, response);
    try {
      const value = response.ok ? await response.json() as { user: IdentitySession['user'] } : null;
      const payload = value ? { user: userDTO(value.user), redirect: false } : null;
      await recorder(c, 'auth.sign_in.otp', value?.user.id)(response.ok ? 'succeeded' : response.status < 500 ? 'rejected' : 'unknown');
      if (!response.ok) {
        if (response.status === 400) return apiError(c, 'INVALID_OTP', 'The code is invalid or expired.', 400, response);
        return authError(c, response, true);
      }
      return jsonResponse(c, payload, 200, response);
    } catch { return unconfirmed(c, response); }
  });

  app.post('/api/auth/email-otp/send-verification-otp', configured, limitedBody, async c => {
    if (!mailConfigured(c.env, dependencies)) return apiError(c, 'MAIL_NOT_CONFIGURED', 'Email service is not configured.', 503);
    const body: unknown = await c.req.raw.clone().json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 2
      || (body as { type?: unknown }).type !== 'sign-in'
      || typeof (body as { email?: unknown }).email !== 'string'
      || !isMailbox((body as { email: string }).email)) {
      return apiError(c, 'INVALID_REQUEST', 'Provide only a valid email address and the sign-in type.', 400);
    }
    let execution: Pick<ExecutionContext, 'waitUntil'>;
    try { execution = c.executionCtx; } catch { return apiError(c, 'IDENTITY_UNAVAILABLE', 'The request cannot safely schedule email delivery.', 503); }
    if (typeof execution.waitUntil !== 'function') return apiError(c, 'IDENTITY_UNAVAILABLE', 'The request cannot safely schedule email delivery.', 503);
    const identity = services(c.env, dependencies, delivery => {
      execution.waitUntil((async () => {
        const outcome = await delivery.then(() => 'succeeded' as const, () => 'rejected' as const);
        try { await recorder(c, 'mail.otp.submit')(outcome); } catch { /* The request audit remains the durable acceptance record. */ }
      })());
    })!;
    c.set('identity', identity);
    const response = await identity.auth.handler(c.req.raw);
    if (response.status === 429) return authError(c, response);
    if (!response.ok) return authError(c, response, true);
    try { await recorder(c, 'auth.otp.send')('succeeded'); }
    catch { return unconfirmed(c, response); }
    return jsonResponse(c, { accepted: true }, 202, response);
  });

  app.post('/api/auth/sign-out', configured, limitedBody, async c => {
    const session = await c.get('identity').auth.api.getSession({ headers: c.req.raw.headers, query: { disableCookieCache: true, disableRefresh: true } });
    const result = await auditedChange(recorder(c, 'auth.sign_out', session?.user.id), () => c.get('identity').auth.handler(c.req.raw), true);
    if (!result.auditComplete) return unconfirmed(c, result.response);
    if (!result.response.ok) return authError(c, result.response, true);
    return jsonResponse(c, { success: true }, 200, result.response);
  });

  app.get('/api/companies', configured, signedIn, async c => {
    const session = c.get('identitySession');
    const companies = await c.get('identity').db.select(companyFields).from(schema.organization).innerJoin(schema.member, and(
      eq(schema.member.organizationId, schema.organization.id), eq(schema.member.userId, session.user.id),
    )).orderBy(asc(schema.organization.name), asc(schema.organization.id));
    const activeCompanyId = companies.find(company => company.id === session.session.activeOrganizationId)?.id ?? null;
    return jsonResponse(c, { companies, activeCompanyId });
  });

  app.get('/api/companies/:companyId', configured, signedIn, async c => {
    const company = await companyFor(c, c.req.param('companyId'), c.get('identitySession').user.id);
    return company ? jsonResponse(c, { company }) : apiError(c, 'NOT_FOUND', 'The resource is not available.', 404);
  });

  app.post('/api/companies/:companyId/activate', configured, limitedBody, signedIn, async c => {
    const body = (await c.req.text()).trim();
    if (body && body !== '{}') return apiError(c, 'INVALID_REQUEST', 'This operation accepts no additional fields.', 400);
    const session = c.get('identitySession');
    const company = await companyFor(c, c.req.param('companyId'), session.user.id);
    if (!company) return apiError(c, 'NOT_FOUND', 'The resource is not available.', 404);
    const result = await auditedChange(recorder(c, 'company.activate', session.user.id, company.id), () => c.get('identity').auth.api.setActiveOrganization({
      headers: c.req.raw.headers, body: { organizationId: company.id }, asResponse: true,
    }));
    if (!result.auditComplete) return unconfirmed(c, result.response);
    if (!result.response.ok) return authError(c, result.response, true);
    return jsonResponse(c, { activeCompanyId: company.id }, 200, result.response);
  });
}
