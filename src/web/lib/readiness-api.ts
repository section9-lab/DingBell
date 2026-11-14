import * as v from 'valibot';
import { request } from './api.ts';

const count = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));
const at = v.nullable(v.string());
const sourceSchema = v.picklist(['chat', 'products', 'fbs_postings', 'fbo_postings','fbp_postings']);
const syncSchema = v.object({
  source: sourceSchema, enabled: v.boolean(), epoch: count, failures: count,
  lastError: v.nullable(v.string()), lastSuccessAt: at, blockedUntil: at,
  running: v.boolean(), canEnable: v.boolean(),
});
const storeSchema = v.pipe(v.object({
  id: v.string(), name: v.string(), platformStoreId: v.string(), status: v.string(),
  hasCredentials: v.boolean(), checkedAt: at, sync: v.array(syncSchema),
}), v.check(value => value.sync.length === 5 && new Set(value.sync.map(item => item.source)).size === 5));
const readinessSchema = v.object({
  companyId: v.string(),
  role: v.string(),
  deployment: v.object({
    sync: v.boolean(),
    outbound: v.boolean(),
    ai: v.object({ enabled: v.boolean(), modelConfigured: v.boolean(), pricesConfigured: v.boolean() }),
    aiOutbound: v.boolean(),
    knowledge: v.object({ text: v.boolean() }),
  }),
  stores: v.array(storeSchema),
  knowledge: v.object({ total: count, published: count }),
  policies: v.object({ total: count, enabled: count }),
  limits: v.object({ stores: count, truncated: v.boolean() }),
});
export type Readiness = v.InferOutput<typeof readinessSchema>;
export type ReadinessStore = Readiness['stores'][number];
export type ReadinessSync = ReadinessStore['sync'][number];
export type SyncSourceKind = ReadinessSync['source'];

/** Read-only deployment and data readiness. Nothing here enables a capability by itself. */
export function readReadiness(companyId: string, signal?: AbortSignal) {
  return request(`/api/companies/${encodeURIComponent(companyId)}/readiness`, v.pipe(readinessSchema, v.check(value => value.companyId === companyId)), { signal });
}
