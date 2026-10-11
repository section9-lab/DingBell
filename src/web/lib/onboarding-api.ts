import * as v from 'valibot';
import { request } from './api.ts';

const accepted = v.object({ accepted: v.literal(true) });
const bootstrapSchema = v.object({
  state: v.picklist(['unavailable', 'unclaimed', 'provisioning', 'initialized']),
  configured: v.boolean(),
  emailConfigured: v.boolean(),
  claim: v.optional(v.nullable(v.object({
    claimId: v.string(), email: v.string(), name: v.string(),
    organizationName: v.string(), step: v.string(),
  }))),
});
export type BootstrapStatus = v.InferOutput<typeof bootstrapSchema>;

function authorization(secret: string) { return { authorization: `Bearer ${secret}` }; }
export function bootstrapStatus(secret?: string, signal?: AbortSignal) {
  return request('/api/bootstrap', bootstrapSchema, { signal, headers: secret ? authorization(secret) : {} });
}
export function claimBootstrap(secret: string, body: { claimId: string; email: string; name: string; organizationName: string }) {
  return request('/api/bootstrap/claim', bootstrapSchema, {
    method: 'POST', headers: authorization(secret), body: JSON.stringify(body),
  });
}
export function resumeBootstrap(secret: string, claimId: string, password: string) {
  return request('/api/bootstrap/resume', v.object({
    state: v.picklist(['provisioning', 'initialized']),
    step: v.optional(v.string()), organizationId: v.optional(v.string()),
  }), { method: 'POST', headers: authorization(secret), body: JSON.stringify({ claimId, password }) });
}
export function requestAccountEmail(kind: 'verification' | 'password', email: string) {
  const path = kind === 'verification' ? 'send-verification-email' : 'request-password-reset';
  return request(`/api/auth/${path}`, accepted, { method: 'POST', body: JSON.stringify({ email }) });
}
export function verifyEmail(token: string) {
  return request('/api/auth/verify-email', v.object({ verified: v.literal(true) }), {
    method: 'POST', body: JSON.stringify({ token }),
  });
}
export function resetPassword(token: string, newPassword: string) {
  return request('/api/auth/reset-password', v.object({ success: v.literal(true) }), {
    method: 'POST', body: JSON.stringify({ token, newPassword }),
  });
}

const invitationFields = {
  id: v.string(), email: v.string(), role: v.string(), status: v.string(),
  expiresAt: v.string(), createdAt: v.string(),
};
const invitationSchema = v.object(invitationFields);
const invitationSent = v.object({
  invitation: v.object({ ...invitationFields, status: v.literal('pending') }),
  mail: v.object({ status: v.literal('accepted') }),
});
const invitationRevoked = v.object({ invitation: v.object({ ...invitationFields, status: v.literal('canceled') }) });
const pageFields = { hasMore: v.boolean(), nextOffset: v.nullable(v.number()) };
const teamSchema = v.object({ ...pageFields, members: v.array(v.object({
  id: v.string(), userId: v.string(), name: v.string(), email: v.string(), role: v.string(),
})) });
export async function readTeam(companyId: string, signal?: AbortSignal, offsets = { members: 0, invitations: 0 }) {
  const prefix = `/api/companies/${encodeURIComponent(companyId)}`;
  const [members, invitations] = await Promise.all([
    request(`${prefix}/members?offset=${offsets.members}`, teamSchema, { signal }),
    request(`${prefix}/invitations?offset=${offsets.invitations}`, v.object({ ...pageFields, invitations: v.array(invitationSchema) }), { signal }),
  ]);
  return { members: members.members, invitations: invitations.invitations, nextMembersOffset: members.nextOffset, nextInvitationsOffset: invitations.nextOffset };
}
export function createInvitation(companyId: string, email: string, role: 'member' | 'admin') {
  return request(`/api/companies/${encodeURIComponent(companyId)}/invitations`, invitationSent, {
    method: 'POST', body: JSON.stringify({ email, role }),
  });
}
export function changeInvitation(companyId: string, invitationId: string, action: 'resend' | 'revoke') {
  return request(`/api/companies/${encodeURIComponent(companyId)}/invitations/${encodeURIComponent(invitationId)}/${action}`, action === 'revoke' ? invitationRevoked : invitationSent, {
    method: 'POST', body: '{}',
  });
}
export function readInvitation(id: string, signal?: AbortSignal) {
  return request(`/api/invitations/${encodeURIComponent(id)}`, v.object({
    invitation: v.object({
      id: v.string(), organization: v.object({ id: v.string(), name: v.string() }),
      role: v.string(), status: v.string(), expiresAt: v.string(),
    }), canAccept: v.boolean(), membershipStatus: v.nullable(v.picklist(['active', 'removed'])),
  }), { signal });
}
export function registerInvitedAccount(id: string, body: { email: string; name: string; password: string }) {
  return request(`/api/invitations/${encodeURIComponent(id)}/register`, v.object({ status: v.picklist(['verification_required', 'sign_in_required', 'password_recovery_required']) }), {
    method: 'POST', body: JSON.stringify(body),
  });
}
export function acceptInvitation(id: string) {
  return request(`/api/invitations/${encodeURIComponent(id)}/accept`, v.object({ companyId: v.string(), status: v.literal('accepted') }), {
    method: 'POST', body: '{}',
  });
}
