import type { Context, Hono } from 'hono';
import * as v from 'valibot';
import { apiError, jsonResponse, type ApplicationEnv } from '../../http.ts';
import { auditedChange, type AuditOutcome } from '../audit/operation.ts';
import { companyFor, configured, limitedBody, signedIn } from '../identity/http.ts';
import { storeDTO } from '../stores/http.ts';
import { findStore, type StoreActor } from '../stores/storage.ts';
import { getProductCounts } from '../products/storage.ts';
import { getFbsCounts } from '../orders/storage.ts';
import { syncConfigured, wakeStoreSync } from './bindings.ts';
import { getStoreSync, getSyncSource, setStoreSyncEnabled, setSyncSourceEnabled } from './storage.ts';
import type { StoreSyncRecord, SyncSourceRecord } from './types.ts';

const path = '/api/companies/:companyId/stores/:storeId/sync';
const changeSchema = v.strictObject({ enabled: v.boolean(), expectedEpoch: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)) });
const notFound = (c: Context<ApplicationEnv>) => apiError(c, 'NOT_FOUND', 'The company or store is not available.', 404);
function actorFor(c: Context<ApplicationEnv>): StoreActor {
  const identity = c.get('identitySession');
  return { orgId: c.req.param('companyId')!, actorUserId: identity.user.id, sessionId: identity.session.id };
}
type SyncView = StoreSyncRecord | (SyncSourceRecord & NonNullable<Awaited<ReturnType<typeof getProductCounts>>>)
  | (SyncSourceRecord & NonNullable<Awaited<ReturnType<typeof getFbsCounts>>>);
function syncDTO(state: SyncView, acknowledged?: SyncSourceRecord) {
  const current = acknowledged ?? state;
  return {
    storeId: current.storeId, enabled: current.enabled, epoch: current.epoch,
    dueAt: new Date(current.dueAt).toISOString(), lastSuccessAt: current.lastSuccessAt === null ? null : new Date(current.lastSuccessAt).toISOString(),
    blockedUntil: current.blockedUntil !== null && current.blockedUntil > 0 ? new Date(current.blockedUntil).toISOString() : null,
    lastError: current.lastError, failures: current.failures,
    running: current.leaseUntil !== null && current.leaseUntil > Date.now(),
    ...('postingCount' in state ? { source: 'fbs_postings', postingCount: state.postingCount, readyCount: state.readyCount, pendingCount: state.pendingCount, failedCount: state.failedCount,
      historyStart: state.historyStart === null ? null : new Date(state.historyStart).toISOString(),
      windowSince: state.windowSince === null ? null : new Date(state.windowSince).toISOString(),
      windowTo: state.windowTo === null ? null : new Date(state.windowTo).toISOString(),
      lastCompletedTo: state.lastCompletedTo === null ? null : new Date(state.lastCompletedTo).toISOString() }
      : 'productCount' in state ? { source: 'products', productCount: state.productCount, readyCount: state.readyCount, pendingCount: state.pendingCount, failedCount: state.failedCount }
      : { conversationCount: state.conversationCount, messageCount: state.messageCount }),
  };
}

export function registerSyncRoutes(app: Hono<ApplicationEnv>) {
  for (const source of ['chat', 'products', 'fbs_postings'] as const) {
    const endpoint = source === 'chat' ? path : `${path}/${source === 'products' ? 'products' : 'fbs-postings'}`;
    async function readState(c: Context<ApplicationEnv>, actor: StoreActor, storeId: string): Promise<SyncView | null> {
      if (source === 'chat') return getStoreSync(c.env.DB!, actor, storeId);
      const current = await getSyncSource(c.env.DB!, actor, storeId, source);
      const counts = current && await (source === 'products' ? getProductCounts : getFbsCounts)(c.env.DB!, actor, storeId);
      return current && counts ? { ...current, ...counts } : null;
    }
    app.get(endpoint, configured, signedIn, async c => {
      const state = await readState(c, actorFor(c), c.req.param('storeId')!);
      return state ? jsonResponse(c, { sync: syncDTO(state), configured: syncConfigured(c.env) }) : notFound(c);
    });
    app.post(endpoint, configured, limitedBody, signedIn, async c => {
      const actor = actorFor(c);
      const company = await companyFor(c, actor.orgId, actor.actorUserId);
      if (!company) return notFound(c);
      if (!['owner', 'admin'].includes(company.role)) return apiError(c, 'FORBIDDEN', 'Only company managers may change synchronization.', 403);
      const store = await findStore(c.env.DB!, actor, c.req.param('storeId')!, true);
      if (!store) return notFound(c);
      const parsed = v.safeParse(changeSchema, await c.req.json().catch(() => null));
      if (!parsed.success) return apiError(c, 'INVALID_REQUEST', 'Provide enabled and the displayed epoch only.', 400);
      const { enabled, expectedEpoch } = parsed.output;
      if (enabled && !syncConfigured(c.env)) return apiError(c, 'SYNC_NOT_CONFIGURED', 'Configure the synchronization runtime and credential encryption first.', 503);
      if (enabled) {
        const view = storeDTO(store);
        const capability = source === 'chat' ? 'chats_read' : source === 'products' ? 'products_read' : 'orders_fbs_read';
        if (!view.hasCredentials || !['verified', 'partial'].includes(view.status) || !['auth', capability].every(code => view.capabilities.some(item => item.code === code && item.status === 'available'))) {
          return apiError(c, source === 'chat' ? 'SYNC_CAPABILITY_REQUIRED' : source === 'products' ? 'PRODUCT_SYNC_CAPABILITY_REQUIRED' : 'FBS_SYNC_CAPABILITY_REQUIRED', 'Verify current credential and resource access before enabling synchronization.', 409);
        }
      }
      const record = async (outcome: AuditOutcome) => {
        await c.env.DB!.prepare(`INSERT INTO store_audit_event (id,request_id,organization_id,store_id,actor_user_id,action,outcome,from_revision,to_revision,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), c.get('requestId'), actor.orgId, store.id, actor.actorUserId,
          `store.sync.${source === 'chat' ? '' : `${source}.`}${enabled ? 'enable' : 'disable'}`, outcome, expectedEpoch, outcome === 'succeeded' ? expectedEpoch + 1 : null, Date.now()).run();
      };
      const result = await auditedChange(record, async () => {
        const changed = source === 'chat' ? await setStoreSyncEnabled(c.env.DB!, actor, store.id, expectedEpoch, enabled)
          : await setSyncSourceEnabled(c.env.DB!, actor, store.id, source, expectedEpoch, enabled);
        if (!changed) return apiError(c, 'SYNC_CHANGED', 'Synchronization or store access changed. Read the current state before retrying.', 409);
        let wakePending = false;
        if (c.env.STORE_COORDINATOR) {
          try { await wakeStoreSync(c.env, { orgId: actor.orgId, storeId: store.id }); }
          catch { wakePending = true; } // D1 intent persists; scheduled repair can wake the store.
        }
        const state = await readState(c, actor, store.id);
        // Acknowledge this command's committed transition. The client rereads the
        // current state, which background work may already have advanced.
        return state ? jsonResponse(c, { sync: syncDTO(source === 'chat' ? changed as StoreSyncRecord : state, changed), configured: syncConfigured(c.env), wakePending })
          : apiError(c, 'OPERATION_UNCONFIRMED', 'Synchronization changed but access was revoked before confirmation.', 503);
      });
      return result.auditComplete ? result.response : apiError(c, 'OPERATION_UNCONFIRMED', 'Read the current synchronization state before another change.', 503);
    });
  }
}
