import type { Context } from 'hono';
import type { IdentityBindings } from './modules/identity/bindings.ts';
import type { services } from './modules/identity/services.ts';
import type { StoreBindings } from './modules/stores/bindings.ts';
import type { SyncBindings } from './modules/sync/bindings.ts';
import type { ControlBindings } from './modules/conversations/control-bindings.ts';
import type { TranslationBindings } from './modules/translations/bindings.ts';
import type { KnowledgeBindings } from './modules/knowledge/bindings.ts';
import type { ReplyTestBindings } from './modules/reply-tests/execution.ts';
import type { ReplyTestHttpBindings } from './modules/reply-tests/http.ts';
import type { SupportBindings } from './modules/ai-runs/execution.ts';

export type IdentityServices = NonNullable<ReturnType<typeof services>>;
export type IdentitySession = NonNullable<Awaited<ReturnType<IdentityServices['auth']['api']['getSession']>>>;
export type ApplicationEnv = {
  Bindings: IdentityBindings & StoreBindings & SyncBindings & ControlBindings & TranslationBindings & KnowledgeBindings & ReplyTestBindings & ReplyTestHttpBindings & SupportBindings;
  Variables: { requestId: string; identity: IdentityServices; identitySession: IdentitySession };
};

export function jsonResponse(c: Context<ApplicationEnv>, body: unknown, status = 200, original?: Response) {
  const headers = new Headers(original?.headers);
  if (original) {
    headers.delete('set-cookie');
    for (const cookie of original.headers.getSetCookie()) headers.append('set-cookie', cookie);
  }
  headers.delete('content-length');
  headers.set('content-type', 'application/json; charset=UTF-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-request-id', c.get('requestId'));
  return new Response(JSON.stringify(body), { status, headers });
}

export function apiError(c: Context<ApplicationEnv>, code: string, message: string, status: number, original?: Response) {
  return jsonResponse(c, { error: { code, message }, requestId: c.get('requestId') }, status, original);
}

export function authError(c: Context<ApplicationEnv>, response: Response, mutating = false) {
  if (mutating && response.status >= 500) {
    return apiError(c, 'OPERATION_UNCONFIRMED', 'The operation may have completed. Refresh the session to confirm its state.', 503, response);
  }
  const errors: Record<number, [string, string]> = {
    400: ['INVALID_REQUEST', 'The request is invalid.'],
    401: ['INVALID_CREDENTIALS', 'The credentials are invalid or the session has expired.'],
    403: ['AUTHENTICATION_REJECTED', 'Authentication is not permitted. Verify your email before signing in.'],
    429: ['RATE_LIMITED', 'Too many requests. Try again later.'],
  };
  const [code, message] = errors[response.status] ?? ['IDENTITY_UNAVAILABLE', 'Identity service is temporarily unavailable.'];
  return apiError(c, code, message, errors[response.status] ? response.status : 503, response);
}
