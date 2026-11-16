import type { Hono } from 'hono';
import * as v from 'valibot';
import { apiError, jsonResponse, type ApplicationEnv } from '../../http.ts';
import { canManageCompany } from '../../shared/roles.ts';
import { configured, limitedBody, signedIn, companyFor } from '../identity/http.ts';
import { logEvent } from '../../platform/log.ts';
import { writeDefaultAiReception } from './default-reception.ts';

const bodySchema = v.strictObject({ enabled: v.boolean() });

export function registerDefaultAiReceptionRoutes(app: Hono<ApplicationEnv>) {
  const base = '/api/companies/:companyId/ai-reception-default';
  for (const method of ['get', 'post'] as const) app[method](base, configured, limitedBody, signedIn, async c => {
    const identity = c.get('identitySession');
    const actor = { orgId: c.req.param('companyId'), actorUserId: identity.user.id };
    const company = await companyFor(c, actor.orgId, actor.actorUserId);
    if (!company) return apiError(c, 'NOT_FOUND', 'The company is not available.', 404);
    const dto = (enabled: boolean, updatedAt: number | null) => ({
      companyId: company.id, enabled, updatedAt: updatedAt === null ? null : new Date(updatedAt).toISOString(), canManage: canManageCompany(company.role),
    });
    if (method === 'get') {
      const row = await c.env.DB!.prepare('SELECT enabled,updated_at AS updatedAt FROM company_ai_reception_default WHERE organization_id=?')
        .bind(actor.orgId).first<{ enabled: number; updatedAt: number }>();
      return jsonResponse(c, dto(row === null || row.enabled === 1, row?.updatedAt ?? null));
    }
    if (!canManageCompany(company.role)) return apiError(c, 'FORBIDDEN', 'Only company owners and administrators can change AI reception defaults.', 403);
    const parsed = v.safeParse(bodySchema, await c.req.json().catch(() => null));
    if (!parsed.success) return apiError(c, 'INVALID_REQUEST', 'Provide a boolean default for AI reception.', 400);
    const saved = await writeDefaultAiReception(c.env.DB!, actor, parsed.output.enabled);
    if (!saved) return apiError(c, 'OPERATION_UNCONFIRMED', 'The default was not stored. Read it again before retrying.', 503);
    logEvent('ai.default_reception.saved', { orgId: actor.orgId, enabled: parsed.output.enabled, actorUserId: actor.actorUserId });
    return jsonResponse(c, dto(saved.enabled === 1, saved.updatedAt));
  });
}
