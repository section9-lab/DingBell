import { and, asc, desc, eq, isNull, lte, or } from 'drizzle-orm';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import * as v from 'valibot';
import { apiError, authError, jsonResponse, type ApplicationEnv } from '../../http.ts';
import { auditedChange } from '../audit/operation.ts';
import { configured, signedIn, limitedBody, companyFor, recorder } from '../identity/http.ts';
import { invitationServices, services } from '../identity/services.ts';
import * as schema from '../identity/schema.ts';
import { mailConfigured } from '../mail/config.ts';
import { createMailer } from '../mail/resend.ts';
import type { IdentityDependencies, MailMessage } from '../mail/types.ts';
import { invitationFlow } from './schema.ts';

type AppContext = Context<ApplicationEnv>;
type Invitation = typeof schema.invitation.$inferSelect;
const email = v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email(), v.maxLength(254));
const inviteInput = v.strictObject({ email, role: v.picklist(['member', 'admin']) });
const registrationInput = v.strictObject({ email, name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)), password: v.pipe(v.string(), v.minLength(8), v.maxLength(128)) });
const missing = (c: AppContext) => apiError(c, 'NOT_FOUND', 'The invitation or company is not available.', 404);
const unconfirmed = (c: AppContext, original?: Response) => apiError(c, 'OPERATION_UNCONFIRMED', 'Refresh the invitation state before retrying.', 503, original);
const normalize = (value: string) => value.trim().toLowerCase();
function offsetFor(c: AppContext) {
  const value = c.req.query('offset') ?? '0';
  return /^(0|[1-9]\d{0,4})$/.test(value) && Number(value) <= 10_000 ? Number(value) : null;
}
function trackedMail(c: AppContext, dependencies: IdentityDependencies) {
  const deliver = dependencies.mailer ?? createMailer(c.env)!;
  let attempted = 0;
  let accepted = 0;
  return {
    dependencies: { mailer: async (message: MailMessage) => { attempted++; const result = await deliver(message); accepted++; return result; } },
    // The SDK's runInBackgroundOrAwait swallows callback failures even when awaited.
    accepted: () => attempted === 1 && accepted === 1,
  };
}

function state(invitation: Invitation) {
  return invitation.status === 'pending' && invitation.expiresAt.getTime() <= Date.now() ? 'expired' : invitation.status;
}
function unavailable(c: AppContext, invitation: Invitation) {
  if (state(invitation) === 'expired' || invitation.expiresAt.getTime() <= Date.now()) return apiError(c, 'INVITATION_EXPIRED', 'The invitation has expired.', 410);
  if (state(invitation) === 'canceled') return apiError(c, 'INVITATION_REVOKED', 'The invitation was revoked.', 410);
  if (!['member', 'admin'].includes(invitation.role ?? '')) return apiError(c, 'INVITATION_INVALID', 'The invitation role is not supported.', 409);
  return null;
}
function dto(invitation: Invitation) {
  return { id: invitation.id, email: invitation.email, role: invitation.role, status: state(invitation), expiresAt: invitation.expiresAt.toISOString(), createdAt: invitation.createdAt.toISOString() };
}
const readInvitation = (c: AppContext, id: string) => c.get('identity').db.select().from(schema.invitation).where(eq(schema.invitation.id, id)).get();
const readFlow = (c: AppContext, id: string) => c.get('identity').db.select().from(invitationFlow).where(eq(invitationFlow.invitationId, id)).get();

async function ensureFlow(c: AppContext, invitation: Invitation) {
  const db = c.get('identity').db;
  if (invitation.status === 'pending') await db.insert(invitationFlow).values({
    invitationId: invitation.id, organizationId: invitation.organizationId, memberId: crypto.randomUUID(), createdAt: new Date(),
  }).onConflictDoNothing();
  return readFlow(c, invitation.id);
}
function nativeRequest(c: AppContext, path: string, body: unknown, anonymous = false) {
  const headers = new Headers(c.req.raw.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  if (anonymous) headers.delete('cookie');
  return new Request(new URL(`/api/auth/${path}`, c.req.url), { method: 'POST', headers, body: JSON.stringify(body) });
}
async function audited(c: AppContext, action: string, organizationId: string, operation: () => Promise<Response>) {
  const actor = c.get('identitySession')?.user.id;
  const result = await auditedChange(recorder(c, action, actor, organizationId), operation);
  return result.auditComplete ? result.response : unconfirmed(c, result.response);
}
const management: MiddlewareHandler<ApplicationEnv> = async (c, next) => {
  const company = await companyFor(c, c.req.param('companyId')!, c.get('identitySession').user.id);
  if (!company) return missing(c);
  if (!company.role.split(',').some(role => ['owner', 'admin'].includes(role.trim()))) return apiError(c, 'FORBIDDEN', 'Only company owners and administrators can manage invitations.', 403);
  await next();
};
const noFields: MiddlewareHandler<ApplicationEnv> = async (c, next) => {
  const text = (await c.req.text()).trim();
  if (text && text !== '{}') return apiError(c, 'INVALID_REQUEST', 'This operation accepts no additional fields.', 400);
  await next();
};

export function registerInvitationRoutes(app: Hono<ApplicationEnv>, dependencies: IdentityDependencies = {}) {
  const injected: MiddlewareHandler<ApplicationEnv> = async (c, next) => { c.set('identity', services(c.env, dependencies)!); await next(); };
  const mailReady: MiddlewareHandler<ApplicationEnv> = async (c, next) => {
    if (!mailConfigured(c.env, dependencies)) return apiError(c, 'MAIL_NOT_CONFIGURED', 'Email delivery is not configured.', 503);
    await next();
  };
  app.get('/api/companies/:companyId/members', configured, injected, signedIn, management, async c => {
    const offset = offsetFor(c);
    if (offset === null) return apiError(c, 'INVALID_REQUEST', 'Offset must be an integer between 0 and 10000.', 400);
    const members = await c.get('identity').db.select({ id: schema.member.id, userId: schema.user.id, name: schema.user.name, email: schema.user.email, role: schema.member.role }).from(schema.member)
      .innerJoin(schema.user, eq(schema.member.userId, schema.user.id)).where(eq(schema.member.organizationId, c.req.param('companyId'))).orderBy(asc(schema.user.name), asc(schema.member.id)).limit(101).offset(offset);
    return jsonResponse(c, { members: members.slice(0, 100), hasMore: members.length > 100, nextOffset: members.length > 100 ? offset + 100 : null });
  });
  app.get('/api/companies/:companyId/invitations', configured, injected, signedIn, management, async c => {
    const offset = offsetFor(c);
    if (offset === null) return apiError(c, 'INVALID_REQUEST', 'Offset must be an integer between 0 and 10000.', 400);
    const invitations = await c.get('identity').db.select().from(schema.invitation).where(eq(schema.invitation.organizationId, c.req.param('companyId')))
      .orderBy(desc(schema.invitation.createdAt), desc(schema.invitation.id)).limit(101).offset(offset);
    return jsonResponse(c, { invitations: invitations.slice(0, 100).map(dto), hasMore: invitations.length > 100, nextOffset: invitations.length > 100 ? offset + 100 : null });
  });
  app.post('/api/companies/:companyId/invitations', configured, injected, limitedBody, signedIn, management, mailReady, async c => {
    const input = v.safeParse(inviteInput, await c.req.json().catch(() => null));
    if (!input.success) return apiError(c, 'INVALID_REQUEST', 'Provide an email address and member or admin role.', 400);
    const organizationId = c.req.param('companyId');
    const db = c.get('identity').db;
    return audited(c, 'invitation.create', organizationId, async () => {
      // Expired pending rows no longer reserve the unique active invitation slot.
      await db.update(schema.invitation).set({ status: 'expired' }).where(and(eq(schema.invitation.organizationId, organizationId), eq(schema.invitation.email, input.output.email), eq(schema.invitation.status, 'pending'), lte(schema.invitation.expiresAt, new Date())));
      const prior = await db.select().from(schema.invitation).where(and(eq(schema.invitation.organizationId, organizationId), eq(schema.invitation.email, input.output.email))).orderBy(desc(schema.invitation.createdAt)).limit(10);
      if (prior.some(invitation => invitation.status === 'pending')) return apiError(c, 'INVITATION_ALREADY_PENDING', 'A pending invitation already exists. Use its resend action.', 409);
      for (const invitation of prior.filter(invitation => invitation.status === 'accepted' && invitation.expiresAt.getTime() > Date.now())) {
        const flow = await readFlow(c, invitation.id);
        if (flow && !flow.completedAt) return apiError(c, 'INVITATION_IN_PROGRESS', 'The prior invitation is still being accepted.', 409);
      }
      const mail = trackedMail(c, dependencies);
      const response = await services(c.env, mail.dependencies)!.auth.handler(nativeRequest(c, 'organization/invite-member', { ...input.output, organizationId }));
      if (!response.ok) return authError(c, response, true);
      if (!mail.accepted()) return unconfirmed(c, response);
      const value = await response.json() as { id: string };
      const invitation = await readInvitation(c, value.id);
      return invitation ? jsonResponse(c, { invitation: dto(invitation), mail: { status: 'accepted' } }, 200, response) : unconfirmed(c, response);
    });
  });
  for (const action of ['resend', 'revoke'] as const) app.post(`/api/companies/:companyId/invitations/:invitationId/${action}`, configured, injected, limitedBody, signedIn, management, noFields, async c => {
    const invitation = await readInvitation(c, c.req.param('invitationId'));
    if (!invitation || invitation.organizationId !== c.req.param('companyId')) return missing(c);
    if (action === 'revoke' && invitation.status === 'canceled') return jsonResponse(c, { invitation: dto(invitation) });
    const flow = await readFlow(c, invitation.id);
    if (flow?.completedAt || (invitation.status === 'accepted' && !flow)) return apiError(c, 'INVITATION_ACCEPTED', 'The invitation has already been accepted.', 409);
    const invalid = unavailable(c, invitation);
    if (invalid) return invalid;
    if (action === 'resend' && invitation.status !== 'pending') return apiError(c, 'INVITATION_IN_PROGRESS', 'The invitation is being accepted.', 409);
    if (action === 'resend' && !mailConfigured(c.env, dependencies)) return apiError(c, 'MAIL_NOT_CONFIGURED', 'Email delivery is not configured.', 503);
    return audited(c, `invitation.${action}`, invitation.organizationId, async () => {
      const mail = action === 'resend' ? trackedMail(c, dependencies) : null;
      const response = await (mail ? services(c.env, mail.dependencies)! : c.get('identity')).auth.handler(nativeRequest(c, action === 'resend' ? 'organization/invite-member' : 'organization/cancel-invitation', action === 'resend'
        ? { email: invitation.email, role: invitation.role, organizationId: invitation.organizationId, resend: true }
        : { invitationId: invitation.id }));
      if (!response.ok) return authError(c, response, true);
      if (mail && !mail.accepted()) return unconfirmed(c, response);
      const current = await readInvitation(c, invitation.id);
      return current ? jsonResponse(c, { invitation: dto(current), ...(action === 'resend' ? { mail: { status: 'accepted' } } : {}) }, 200, response) : unconfirmed(c, response);
    });
  });
  app.get('/api/invitations/:invitationId', configured, injected, signedIn, async c => {
    const invitation = await readInvitation(c, c.req.param('invitationId'));
    if (!invitation || normalize(invitation.email) !== normalize(c.get('identitySession').user.email)) return missing(c);
    const organization = await c.get('identity').db.select({ id: schema.organization.id, name: schema.organization.name }).from(schema.organization).where(eq(schema.organization.id, invitation.organizationId)).get();
    if (!organization) return missing(c);
    const flow = await readFlow(c, invitation.id);
    const userId = c.get('identitySession').user.id;
    const member = await c.get('identity').db.select({ id: schema.member.id }).from(schema.member).where(and(eq(schema.member.organizationId, invitation.organizationId), eq(schema.member.userId, userId))).get();
    const recoverable = invitation.status === 'accepted' && flow?.acceptingUserId === userId && !flow.completedAt;
    return jsonResponse(c, { invitation: { id: invitation.id, organization, role: invitation.role, status: state(invitation), expiresAt: invitation.expiresAt.toISOString() },
      membershipStatus: member ? 'active' : flow?.completedAt ? 'removed' : null,
      canAccept: !member && !flow?.completedAt && !unavailable(c, invitation) && (invitation.status === 'pending' || recoverable) });
  });
  app.post('/api/invitations/:invitationId/accept', configured, injected, limitedBody, signedIn, noFields, async c => {
    const invitation = await readInvitation(c, c.req.param('invitationId'));
    const user = c.get('identitySession').user;
    if (!invitation || normalize(invitation.email) !== normalize(user.email)) return missing(c);
    const db = c.get('identity').db;
    const completed = async () => {
      const flow = await readFlow(c, invitation.id);
      if (!flow?.completedAt || flow.acceptingUserId !== user.id) return null;
      const member = await db.select({ id: schema.member.id }).from(schema.member).where(and(eq(schema.member.id, flow.memberId), eq(schema.member.organizationId, invitation.organizationId), eq(schema.member.userId, user.id))).get();
      return member ? jsonResponse(c, { companyId: invitation.organizationId, status: 'accepted' }) : apiError(c, 'MEMBERSHIP_REMOVED', 'This membership was removed. A new invitation is required.', 403);
    };
    const previous = await completed();
    if (previous) return previous;
    const invalid = unavailable(c, invitation);
    if (invalid) return invalid;
    if (!['pending', 'accepted'].includes(invitation.status)) return apiError(c, 'INVITATION_INVALID', 'The invitation cannot be accepted.', 409);
    return audited(c, 'invitation.accept', invitation.organizationId, async () => {
      const flow = await ensureFlow(c, invitation);
      if (!flow) return apiError(c, 'INVITATION_UNCONFIRMED', 'The earlier invitation has no recovery record. Request a new invitation.', 409);
      await db.update(invitationFlow).set({ acceptingUserId: user.id }).where(and(eq(invitationFlow.invitationId, invitation.id), isNull(invitationFlow.completedAt), or(isNull(invitationFlow.acceptingUserId), eq(invitationFlow.acceptingUserId, user.id))));
      const claimed = await readFlow(c, invitation.id);
      if (claimed?.acceptingUserId !== user.id) return missing(c);
      const already = await completed();
      if (already) return already;
      const scoped = invitationServices(c.env, { memberId: flow.memberId }, dependencies)!;
      let response: Response | undefined;
      try {
        const current = await readInvitation(c, invitation.id);
        if (!current) return missing(c);
        const rejected = unavailable(c, current);
        if (rejected) return rejected;
        response = current.status === 'pending'
          ? await scoped.auth.api.acceptInvitation({ headers: c.req.raw.headers, body: { invitationId: invitation.id }, asResponse: true })
          : current.status === 'accepted'
            ? await scoped.auth.api.addMember({ body: { organizationId: invitation.organizationId, userId: user.id, role: invitation.role === 'admin' ? 'admin' : 'member' }, asResponse: true })
            : undefined;
      } catch { /* The member trigger is the receipt even if later SDK work fails. */ }
      const result = await completed();
      if (result) return result;
      return response && !response.ok ? authError(c, response, true) : unconfirmed(c, response);
    });
  });
  app.post('/api/invitations/:invitationId/register', configured, injected, limitedBody, mailReady, async c => {
    const input = v.safeParse(registrationInput, await c.req.json().catch(() => null));
    if (!input.success) return apiError(c, 'INVALID_REQUEST', 'Provide a valid name, email address and password.', 400);
    const invitation = await readInvitation(c, c.req.param('invitationId'));
    if (!invitation || normalize(invitation.email) !== input.output.email) return missing(c);
    const invalid = unavailable(c, invitation);
    if (invalid) return invalid;
    if (invitation.status !== 'pending') return apiError(c, 'INVITATION_INVALID', 'Registration requires a pending invitation.', 409);
    return audited(c, 'invitation.register', invitation.organizationId, async () => {
      const db = c.get('identity').db;
      await ensureFlow(c, invitation);
      await db.update(invitationFlow).set({ registrationUserId: crypto.randomUUID() }).where(and(eq(invitationFlow.invitationId, invitation.id), isNull(invitationFlow.registrationUserId)));
      const flow = (await readFlow(c, invitation.id))!;
      const findUser = () => db.select().from(schema.user).where(eq(schema.user.email, input.output.email)).get();
      let user = await findUser();
      if (user && user.id !== flow.registrationUserId) return apiError(c, 'ACCOUNT_EXISTS', 'Sign in with the existing account to accept this invitation.', 409);
      const mail = trackedMail(c, dependencies);
      const scoped = invitationServices(c.env, { userId: flow.registrationUserId! }, mail.dependencies)!;
      if (!user) {
        const response = await scoped.auth.handler(nativeRequest(c, 'sign-up/email', input.output, true));
        if (!response.ok) return authError(c, response, true);
        // A duplicate-email response can be synthetic. Only the actual persisted ID proves ownership.
        user = await findUser();
        if (!user || user.id !== flow.registrationUserId) return apiError(c, 'ACCOUNT_EXISTS', 'Sign in with the existing account to accept this invitation.', 409);
      }
      const account = await db.select({ password: schema.account.password }).from(schema.account).where(and(eq(schema.account.userId, user.id), eq(schema.account.providerId, 'credential'))).get();
      const credentialReady = typeof account?.password === 'string' && account.password.length > 0;
      if (user.emailVerified) return jsonResponse(c, { status: credentialReady ? 'sign_in_required' : 'password_recovery_required' });
      const response = await scoped.auth.handler(nativeRequest(c, 'send-verification-email', { email: user.email }, true));
      if (!response.ok) return authError(c, response, true);
      if (!mail.accepted()) return unconfirmed(c, response);
      return jsonResponse(c, { status: credentialReady ? 'verification_required' : 'password_recovery_required', mail: { status: 'accepted' } });
    });
  });
}
