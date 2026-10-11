import type { Hono } from 'hono';
import * as v from 'valibot';
import { apiError, jsonResponse, type ApplicationEnv } from '../../http.ts';
import { canonicalTimeZone } from '../../shared/time-zone.ts';
import { auditedChange, type AuditOutcome } from '../audit/operation.ts';
import { configured, limitedBody, signedIn } from '../identity/http.ts';
import { readCompanySettings, saveCompanyTimeZone, type SettingsRecord } from './storage.ts';

const bodySchema = v.strictObject({
  timeZone: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER - 1)),
});
const canManage = (row: SettingsRecord) => row.role === 'owner' || row.role === 'admin';
const dto = (row: SettingsRecord) => ({ companyId: row.companyId, timeZone: row.timeZone, version: row.version,
  updatedAt: row.updatedAt === null ? null : new Date(row.updatedAt).toISOString(), canManage: canManage(row) });

export function registerCompanySettingsRoutes(app: Hono<ApplicationEnv>) {
  const base = '/api/companies/:companyId/settings';
  for (const method of ['get', 'post'] as const) app[method](base, configured, limitedBody, signedIn, async c => {
    const identity = c.get('identitySession');
    const actor = { orgId: c.req.param('companyId'), actorUserId: identity.user.id, sessionId: identity.session.id };
    const unavailable = () => apiError(c, 'NOT_FOUND', 'The company settings are not available.', 404);
    const forbidden = () => apiError(c, 'FORBIDDEN', 'Only company owners and administrators can change settings.', 403);
    const conflict = () => apiError(c, 'SETTINGS_CHANGED', 'Settings changed. Read the current version before retrying.', 409);
    const current = await readCompanySettings(c.env.DB!, actor);
    if (!current) return unavailable();
    if (method === 'get') return jsonResponse(c, dto(current));
    if (!canManage(current)) return forbidden();
    const parsed = v.safeParse(bodySchema, await c.req.json().catch(() => null));
    const timeZone = parsed.success ? canonicalTimeZone(parsed.output.timeZone) : null;
    if (!parsed.success || !timeZone) return apiError(c, 'INVALID_REQUEST', 'Provide a named IANA time zone and the current settings version.', 400);
    if (parsed.output.expectedVersion !== current.version) return conflict();
    const record = async (outcome: AuditOutcome) => {
      await c.env.DB!.prepare(`INSERT INTO company_settings_audit_event
        (id,request_id,organization_id,actor_user_id,outcome,from_version,to_version,before_time_zone,requested_time_zone,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),c.get('requestId'),actor.orgId,actor.actorUserId,outcome,
        current.version,outcome === 'succeeded' ? current.version + 1 : null,current.timeZone,timeZone,Date.now()).run();
    };
    const result = await auditedChange(record, async () => {
      const changed = await saveCompanyTimeZone(c.env.DB!, actor, timeZone, current.version);
      const latest = await readCompanySettings(c.env.DB!, actor);
      if (!latest) return changed
        ? apiError(c, 'OPERATION_UNCONFIRMED', 'The setting was saved but access changed before confirmation.', 503)
        : unavailable();
      if (!changed) return canManage(latest) ? conflict() : forbidden();
      return jsonResponse(c, dto(latest));
    });
    return result.auditComplete ? result.response : apiError(c, 'OPERATION_UNCONFIRMED', 'The setting may have been saved. Read the current settings before retrying.', 503);
  });
}
