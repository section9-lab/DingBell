import type { Context, Hono } from 'hono';
import { APIError } from 'better-auth/api';
import { apiError, authError, jsonResponse, type ApplicationEnv } from '../../http.ts';
import { isMailbox, mailConfigured } from '../mail/config.ts';
import type { IdentityDependencies } from '../mail/types.ts';
import { configured, limitedBody, recorder } from './http.ts';
import { services } from './services.ts';

function nativeRequest(c: Context<ApplicationEnv>, path: string, body: Record<string, unknown>, method = 'POST') {
  const url = new URL(`/api/auth/${path}`, c.env.APP_BASE_URL!);
  const headers = new Headers(c.req.raw.headers);
  // Public recovery remains anonymous even if the browser holds another account's cookie.
  headers.delete('cookie'); headers.delete('content-length');
  if (method === 'GET') url.searchParams.set('token', String(body.token));
  return new Request(url, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
}

async function readBody(c: Context<ApplicationEnv>, keys: string[]) {
  const value: unknown = await c.req.raw.clone().json().catch(() => null);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) return null;
  return value as Record<string, unknown>;
}

export function registerVerificationRoutes(app: Hono<ApplicationEnv>, deps: IdentityDependencies = {}) {
  for (const [path, kind] of [['send-verification-email', 'verification'], ['request-password-reset', 'password_reset']] as const) {
    app.post(`/api/auth/${path}`, configured, limitedBody, async c => {
      if (!mailConfigured(c.env, deps)) return apiError(c, 'MAIL_NOT_CONFIGURED', 'Email service is not configured.', 503);
      let execution: Pick<ExecutionContext, 'waitUntil'>;
      try { execution = c.executionCtx; } catch { return apiError(c, 'IDENTITY_UNAVAILABLE', 'The request cannot safely schedule email delivery.', 503); }
      if (typeof execution.waitUntil !== 'function') return apiError(c, 'IDENTITY_UNAVAILABLE', 'The request cannot safely schedule email delivery.', 503);
      const body = await readBody(c, ['email']);
      if (!body || !isMailbox(body.email)) return apiError(c, 'INVALID_REQUEST', 'Provide only a valid email address.', 400);
      const requestAudit = recorder(c, `auth.${kind}.request`);
      const identity = services(c.env, deps, delivery => {
        execution.waitUntil((async () => {
          const outcome = await delivery.then(() => 'succeeded' as const, () => 'rejected' as const);
          // A missing completion event means unknown; never log addresses, links or provider errors.
          try { await recorder(c, `mail.${kind}.submit`)(outcome); } catch { /* Request audit remains the durable acceptance record. */ }
        })());
      })!;
      c.set('identity', identity);
      const response = await identity.auth.handler(nativeRequest(c, path, { email: body.email.toLowerCase() }));
      if (response.status === 429) return authError(c, response);
      if (response.status >= 400 && response.status < 500) return authError(c, response);
      await requestAudit(response.ok ? 'succeeded' : 'unknown');
      // This acknowledges the request, not delivery. waitUntil is not a durable retry queue.
      return jsonResponse(c, { accepted: true }, 202);
    });
  }

  for (const [path, keys] of [['verify-email', ['token']], ['reset-password', ['token', 'newPassword']]] as const) {
    app.post(`/api/auth/${path}`, configured, limitedBody, async c => {
      const body = await readBody(c, [...keys]);
      if (!body || typeof body.token !== 'string' || !body.token || body.token.length > 4096
        || (path === 'reset-password' && (typeof body.newPassword !== 'string' || body.newPassword.length < 8 || body.newPassword.length > 128))) {
        return apiError(c, 'INVALID_REQUEST', 'Provide the link token and required fields only.', 400);
      }
      const audit = recorder(c, path === 'verify-email' ? 'auth.email.verify' : 'auth.password.reset');
      let started = false;
      let intentFailed = false;
      const identity = services(c.env, deps, undefined, async () => {
        // The public SDK hook runs after its persistent request limiter.
        try { await audit('started'); started = true; }
        catch { intentFailed = true; throw new APIError('SERVICE_UNAVAILABLE', { message: 'Audit storage is unavailable.' }); }
      })!;
      c.set('identity', identity);
      const response = await identity.auth.handler(nativeRequest(c, path, body, path === 'verify-email' ? 'GET' : 'POST'));
      if (intentFailed) return apiError(c, 'AUDIT_UNAVAILABLE', 'The operation was not executed because its audit could not be stored.', 503);
      if (response.status === 429) return authError(c, response);
      if (started) {
        try { await audit(response.ok ? 'succeeded' : response.status < 500 ? 'rejected' : 'unknown'); }
        catch { return apiError(c, 'OPERATION_UNCONFIRMED', 'The operation may have completed. Confirm your account state before trying again.', 503, response); }
      }
      if (response.status >= 500) return authError(c, response, true);
      if (!response.ok) return apiError(c, 'INVALID_LINK', 'This link is invalid, expired, or already used.', 400);
      return jsonResponse(c, path === 'verify-email' ? { verified: true } : { success: true });
    });
  }
}
