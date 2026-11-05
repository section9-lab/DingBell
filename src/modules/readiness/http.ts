import type { Context, Hono } from 'hono';
import { apiError, jsonResponse, type ApplicationEnv } from '../../http.ts';
import { companyFor, configured, signedIn } from '../identity/http.ts';
import { listStores, type StoreActor } from '../stores/storage.ts';
import { storeDTO } from '../stores/http.ts';
import { syncConfigured } from '../sync/bindings.ts';
import { canEnableSync, type SyncSourceKind } from '../sync/capability.ts';
import { companySupportConfigurationView } from '../company-model/runtime.ts';
import { readTranslationDeploymentConfig } from '../translations/deployment-config.ts';
import { translationApiKey } from '../translations/company-key.ts';

const path = '/api/companies/:companyId/readiness';
const sources: readonly SyncSourceKind[] = ['chat', 'products', 'fbs_postings', 'fbo_postings','fbp_postings'];

interface SyncRow {
  storeId: string; source: SyncSourceKind; enabled: number; epoch: number; failures: number;
  lastError: string | null; lastSuccessAt: number | null; blockedUntil: number | null; leaseUntil: number | null;
}

function actorFor(c: Context<ApplicationEnv>): StoreActor {
  const identity = c.get('identitySession');
  return { orgId: c.req.param('companyId')!, actorUserId: identity.user.id, sessionId: identity.session.id };
}
const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();

/** Deployment switches are read-only metadata; this grants no execution or spending permission. */
async function deployment(c: Context<ApplicationEnv>) {
  const env = c.env;
  const ai = await companySupportConfigurationView(env, c.req.param('companyId')!);
  const translationKey = await translationApiKey({ DB: env.DB, NVAPI_KEY: env.NVAPI_KEY }, c.req.param('companyId')!);
  return {
    sync: syncConfigured(env),
    outbound: env.OUTBOUND_ENABLED === 'true',
    translation: { enabled: env.TRANSLATION_ENABLED === 'true', configured: !!readTranslationDeploymentConfig(env), model: !!translationKey },
    ai: { enabled: ai.enabled, modelConfigured: ai.modelConfigured, pricesConfigured: ai.pricesConfigured },
    aiOutbound: env.AI_OUTBOUND_ENABLED === 'true',
    knowledge: { text: true },
  };
}

export function registerReadinessRoutes(app: Hono<ApplicationEnv>) {
  app.get(path, configured, signedIn, async c => {
    const actor = actorFor(c);
    const company = await companyFor(c, actor.orgId, actor.actorUserId);
    if (!company) return apiError(c, 'NOT_FOUND', 'The company or store is not available.', 404);
    const stores = await listStores(c.env.DB!, actor, 0);
    const ids = stores.map(store => store.id);
    const rows: SyncRow[] = ids.length
      ? (await c.env.DB!.prepare(`SELECT a.store_id AS storeId,a.source,a.enabled,a.epoch,a.failures,a.last_error AS lastError,
          a.last_success_at AS lastSuccessAt,coordinator.blocked_until AS blockedUntil,
          CASE WHEN coordinator.lease_source=a.source THEN coordinator.lease_until ELSE NULL END AS leaseUntil
          FROM store_sync_source AS a
          LEFT JOIN store_coordinator AS coordinator ON coordinator.store_id=a.store_id AND coordinator.organization_id=a.organization_id
          WHERE a.organization_id=? AND a.store_id IN (SELECT value FROM json_each(?))`)
        .bind(actor.orgId, JSON.stringify(ids)).all<SyncRow>()).results
      : [];
    const counts = await c.env.DB!.prepare(`SELECT
      (SELECT COUNT(*) FROM knowledge_document WHERE organization_id=?) AS knowledgeTotal,
      (SELECT COUNT(*) FROM knowledge_document WHERE organization_id=? AND active_revision IS NOT NULL) AS knowledgePublished,
      (SELECT COUNT(*) FROM reply_policy WHERE organization_id=?) AS policyTotal,
      (SELECT COUNT(*) FROM reply_policy WHERE organization_id=? AND enabled=1) AS policyEnabled`)
      .bind(actor.orgId, actor.orgId, actor.orgId, actor.orgId)
      .first<{ knowledgeTotal: number; knowledgePublished: number; policyTotal: number; policyEnabled: number }>();
    const now = Date.now();
    return jsonResponse(c, {
      companyId: actor.orgId,
      role: company.role,
      deployment: await deployment(c),
      stores: stores.map(store => {
        const view = storeDTO(store, now);
        return {
          id: store.id, name: store.name, platformStoreId: store.platformStoreId, status: view.status,
          hasCredentials: view.hasCredentials, checkedAt: view.checkedAt,
          sync: sources.map(source => {
            const row = rows.find(item => item.storeId === store.id && item.source === source);
            return {
              source,
              enabled: row?.enabled === 1,
              epoch: row?.epoch ?? 0,
              failures: row?.failures ?? 0,
              lastError: row?.lastError ?? null,
              lastSuccessAt: iso(row?.lastSuccessAt ?? null),
              blockedUntil: row?.blockedUntil ? iso(row.blockedUntil) : null,
              running: !!row?.leaseUntil && row.leaseUntil > now,
              canEnable: canEnableSync(view, source),
            };
          }),
        };
      }),
      knowledge: { total: counts?.knowledgeTotal ?? 0, published: counts?.knowledgePublished ?? 0 },
      policies: { total: counts?.policyTotal ?? 0, enabled: counts?.policyEnabled ?? 0 },
      limits: { stores: ids.length, truncated: ids.length > 100 },
    });
  });
}
