import { sqlManagesCompany, NOW_MS } from '../../platform/database/sql.ts';
import type { Context, Hono } from 'hono';
import { apiError, jsonResponse, type ApplicationEnv } from '../../http.ts';
import type { DegradationView } from '../../shared/degradation.ts';
import { companySupportConfigurationView } from '../company-model/runtime.ts';
import { companyFor, configured, signedIn } from '../identity/http.ts';

const path = '/api/companies/:companyId/degradation';
const notFound = (c: Context<ApplicationEnv>) => apiError(c, 'NOT_FOUND', 'The company or degradation view is not available.', 404);
type Row = { snapshotAt: number; remainingMicros: number | null; remainingRuns: number | null };

export function registerDegradationRoutes(app: Hono<ApplicationEnv>) {
  app.get(path, configured, signedIn, async c => {
    if (new URL(c.req.url).search) return apiError(c, 'INVALID_REQUEST', 'The request is invalid.', 400);
    const identity = c.get('identitySession'), companyId = c.req.param('companyId')!;
    if (!await companyFor(c, companyId, identity.user.id)) return notFound(c);
    // Configuration and budget describe current admission, not historical fallback
    // ledgers. An ambiguous budget set is unavailable rather than chosen arbitrarily.
    const row = await c.env.DB!.prepare(`WITH viewer AS (
      SELECT actor.organization_id AS organizationId,${NOW_MS} AS snapshotAt
      FROM member actor JOIN user caller ON caller.id=actor.user_id JOIN session login ON login.user_id=actor.user_id
      WHERE actor.organization_id=? AND actor.user_id=? AND login.id=?
        AND login.expires_at>${NOW_MS}
        AND caller.email_verified=1 AND ${sqlManagesCompany('actor.role')}
    ), budgets AS (
      SELECT budget.* FROM ai_budget budget JOIN viewer ON viewer.organizationId=budget.organization_id
      WHERE budget.enabled=1 AND budget.starts_at<=viewer.snapshotAt AND budget.ends_at>viewer.snapshotAt
        AND budget.id NOT LIKE 'ai-unbounded-%'
    ) SELECT viewer.snapshotAt,
      CASE WHEN COUNT(budgets.id)=1 THEN MAX(0,MAX(budgets.limit_micros-budgets.spent_micros-budgets.reserved_micros)) END AS remainingMicros,
      CASE WHEN COUNT(budgets.id)=1 THEN MAX(0,MAX(budgets.max_runs-budgets.admitted_runs)) END AS remainingRuns
      FROM viewer LEFT JOIN budgets ON 1=1 GROUP BY viewer.organizationId,viewer.snapshotAt`)
      .bind(companyId, identity.user.id, identity.session.id).first<Row>();
    if (!row) return notFound(c);
    const config = await companySupportConfigurationView(c.env, companyId);
    const status: DegradationView['automation']['status'] = !config.pricesConfigured || config.runReservationMicros === null
      ? 'configuration_unavailable' : !config.enabled ? 'disabled'
      : row.remainingMicros === null || row.remainingRuns === null || row.remainingRuns < 1 || row.remainingMicros < config.runReservationMicros
        ? 'budget_unavailable' : 'available';
    const result: DegradationView = {
      companyId, snapshotAt: new Date(row.snapshotAt).toISOString(),
      automation: { status, newAiExecutions: status === 'available', onUnavailable: 'human_queue',
        runReservationMicros: config.runReservationMicros, remainingMicros: row.remainingMicros, remainingRuns: row.remainingRuns },
      manualHandling: { available: true, requiresCurrentAuthorization: true },
      syncCsvExport: { available: true, maxRows: 5000, maxBytes: 8388608, asyncObjectStorageAvailable: false },
      unknownSends: { automaticReplay: false, requiresOriginalEvidence: true },
      commercialBilling: { status: 'not_implemented' },
    };
    return jsonResponse(c, result);
  });
}
