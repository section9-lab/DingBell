import { and, eq } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import * as v from 'valibot';
import { apiError, authError, jsonResponse, type ApplicationEnv } from '../../http.ts';
import { auditedChange } from '../audit/operation.ts';
import { companyFor, configured, limitedBody, recorder, signedIn } from '../identity/http.ts';
import { member } from '../identity/schema.ts';
import { changeMember, type MemberChange } from './storage.ts';

const role = v.picklist(['owner', 'admin', 'member']);
const fields = { expectedRole: role, password: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))) };
const roleBody = v.strictObject({ ...fields, role });
const removeBody = v.strictObject(fields);

async function confirmPassword(c: Context<ApplicationEnv>, password?: string) {
  if (!password) return apiError(c, 'PASSWORD_CONFIRMATION_REQUIRED', 'Confirm your current password for this ownership change.', 403);
  const headers = new Headers(c.req.raw.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  // Use the official HTTP pipeline so password checks also consume its persistent limiter.
  // This SDK endpoint is never registered as a public DingBell route.
  const response = await c.get('identity').auth.handler(new Request(new URL('/api/auth/verify-password', c.env.APP_BASE_URL!), {
    method: 'POST', headers, body: JSON.stringify({ password }),
  }));
  if (response.ok) return null;
  if (response.status === 429) return authError(c, response);
  if (response.status === 400) return apiError(c, 'INVALID_PASSWORD', 'The current password is incorrect.', 403);
  if (response.status === 401 || response.status === 403) return apiError(c, 'UNAUTHENTICATED', 'A verified account session is required.', 401);
  return apiError(c, 'IDENTITY_UNAVAILABLE', 'Password confirmation is temporarily unavailable.', 503);
}

function lastOwnerError(error: unknown) {
  for (let depth = 0; depth < 5 && error instanceof Error; depth++, error = error.cause) {
    if (/\blast_owner_required\b/.test(error.message)) return true;
  }
  return false;
}

async function changedOrUnauthorized(c: Context<ApplicationEnv>, input: MemberChange) {
  const company = await companyFor(c, input.organizationId, input.actorUserId);
  if (!company) return apiError(c, 'NOT_FOUND', 'The company or member is not available.', 404);
  if (company.role !== 'owner' && (company.role !== 'admin' || input.expectedRole === 'owner' || input.role === 'owner')) {
    return apiError(c, 'FORBIDDEN', 'This member change is not permitted.', 403);
  }
  const target = await c.get('identity').db.select({ role: member.role }).from(member).where(and(eq(member.id, input.memberId), eq(member.organizationId, input.organizationId))).get();
  if (!target) return apiError(c, 'NOT_FOUND', 'The company or member is not available.', 404);
  return target.role !== input.expectedRole ? apiError(c, 'MEMBER_CHANGED', 'This member changed. Refresh the team before retrying.', 409) : null;
}

export function registerMembershipRoutes(app: Hono<ApplicationEnv>) {
  for (const action of ['role', 'remove'] as const) app.post(`/api/companies/:companyId/members/:memberId/${action}`, configured, limitedBody, signedIn, async c => {
    const parsed = v.safeParse(action === 'role' ? roleBody : removeBody, await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'INVALID_REQUEST', 'Provide a single expected role and the fields required for this operation.', 400);
    const input: MemberChange = {
      organizationId: c.req.param('companyId'), memberId: c.req.param('memberId'), expectedRole: parsed.output.expectedRole,
      role: 'role' in parsed.output ? parsed.output.role : null,
      actorUserId: c.get('identitySession').user.id, sessionId: c.get('identitySession').session.id,
    };
    const rejected = await changedOrUnauthorized(c, input);
    if (rejected) return rejected;
    if (input.expectedRole === 'owner' || input.role === 'owner') {
      const confirmation = await confirmPassword(c, parsed.output.password);
      if (confirmation) return confirmation;
    }
    const record = recorder(c, action === 'role' ? 'member.role.update' : 'member.remove', input.actorUserId, input.organizationId, {
      targetMemberId: input.memberId, beforeRole: input.expectedRole, afterRole: input.role,
    });
    const result = await auditedChange(record, async () => {
      let changed;
      try { changed = await changeMember(c.env.DB!, input); }
      catch (error) {
        if (lastOwnerError(error)) return apiError(c, 'LAST_OWNER_REQUIRED', 'A company must retain at least one owner.', 409);
        throw error;
      }
      if (!changed) return await changedOrUnauthorized(c, input) ?? apiError(c, 'MEMBER_CHANGED', 'The member or its authorization changed. Refresh before retrying.', 409);
      return jsonResponse(c, changed);
    });
    return result.auditComplete ? result.response : apiError(c, 'OPERATION_UNCONFIRMED', 'The member change may have completed. Refresh the team to confirm.', 503, result.response);
  });
}
