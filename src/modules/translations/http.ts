import type { Context, Hono } from 'hono';
import * as v from 'valibot';
import { apiError, jsonResponse, type ApplicationEnv } from '../../http.ts';
import { replyBodySchema } from '../conversations/control-state.ts';
import { configured, limitedBody, signedIn } from '../identity/http.ts';
import { readReplyPreview, submitReplyPreview } from './service.ts';
import type { ReplyPreviewResult, TranslationServiceDeps } from './api-types.ts';
import type { TranslationActor } from './types.ts';

const path = '/api/companies/:companyId/conversations/:id/reply-previews';
const requestIdSchema = v.pipe(v.string(), v.uuid());
const inputSchema = v.strictObject({ requestId: requestIdSchema, source: replyBodySchema,
  sourceRevision: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)) });
const validId = (value: string | undefined): value is string => !!value && value.length <= 256
  && value === value.trim() && value.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(value);
function memberHeader(c: Context<ApplicationEnv>): string | null {
  const raw = c.req.header('X-DingBell-Member-Id');
  if (!raw) return null;
  try {
    const memberId = decodeURIComponent(raw);
    return validId(memberId) && encodeURIComponent(memberId) === raw ? memberId : null;
  } catch { return null; }
}
function validPath(c: Context<ApplicationEnv>) {
  return !new URL(c.req.url).search && validId(c.req.param('companyId')) && validId(c.req.param('id'));
}
function actorFor(c: Context<ApplicationEnv>): TranslationActor {
  const identity = c.get('identitySession');
  return { orgId: c.req.param('companyId')!, actorUserId: identity.user.id, sessionId: identity.session.id };
}
const invalid = (c: Context<ApplicationEnv>) => apiError(c, 'INVALID_REQUEST', 'Provide only the required reply preview fields and member identity.', 400);
function response(c: Context<ApplicationEnv>, result: ReplyPreviewResult, memberId: string) {
  if (result.outcome === 'found') {
    const preview = result.preview;
    return jsonResponse(c, { companyId: c.req.param('companyId'), conversationId: c.req.param('id'), viewerMemberId: memberId,
      preview: { requestId: preview.requestId, source: preview.source, sourceRevision: preview.sourceRevision,
        targetLanguage: preview.targetLanguage, status: preview.status, translation: preview.translation,
        reason: preview.reason, usageStatus: preview.usageStatus } });
  }
  if (result.outcome === 'rejected') {
    const errors = {
      TRANSLATION_DISABLED: [403, 'Reply translation is not enabled.'],
      BUDGET_UNAVAILABLE: [412, 'The reply translation budget is unavailable.'],
      PRICING_UNAVAILABLE: [503, 'Reply translation pricing is unavailable.'],
      RUNTIME_UNAVAILABLE: [503, 'The reply translation runtime is unavailable.'],
    } as const;
    const [status, message] = errors[result.code];
    return apiError(c, result.code, message, status);
  }
  return result.outcome === 'not_found'
    ? apiError(c, 'NOT_FOUND', 'The conversation or reply preview is not available.', 404)
    : apiError(c, 'PREVIEW_CONFLICT', 'This request identifier belongs to a different reply preview.', 409);
}

export function registerTranslationRoutes(app: Hono<ApplicationEnv>, deps: TranslationServiceDeps = {}) {
  app.post(path, configured, limitedBody, signedIn, async c => {
    const memberId = memberHeader(c);
    if (!validPath(c) || !memberId) return invalid(c);
    let body: unknown;
    try { body = await c.req.json(); } catch { return invalid(c); }
    const parsed = v.safeParse(inputSchema, body);
    if (!parsed.success) return invalid(c);
    try {
      return response(c, await submitReplyPreview(c.env, actorFor(c), {
        conversationId: c.req.param('id')!, expectedMemberId: memberId,
      }, parsed.output, deps), memberId);
    } catch { return apiError(c, 'OPERATION_UNCONFIRMED', 'The reply preview submission could not be confirmed. Read the original request before trying again.', 503); }
  });
  app.get(`${path}/:requestId`, configured, signedIn, async c => {
    const memberId = memberHeader(c), requestId = c.req.param('requestId');
    if (!validPath(c) || !memberId || !v.is(requestIdSchema, requestId)) return invalid(c);
    try {
      return response(c, await readReplyPreview(c.env, actorFor(c), {
        conversationId: c.req.param('id')!, expectedMemberId: memberId,
      }, requestId, deps), memberId);
    } catch { return apiError(c, 'TRANSLATION_UNAVAILABLE', 'The reply preview is temporarily unavailable.', 503); }
  });
}
