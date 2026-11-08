import * as v from 'valibot';
import type { SyncBindings } from './bindings.ts';
import type { SyncScope, SyncSource } from './types.ts';
import { wakeStoreSync } from './bindings.ts';
import { readEndpoint, enqueueBootstrapReconcile } from '../ozon-push/storage.ts';
import { prepareProductSyncSeed } from '../products/sync-seed.ts';
import { prepareFbsSyncSeed, prepareFboSyncSeed, prepareFbpSyncSeed } from '../orders/sync-seed.ts';

const sources = ['chat', 'products', 'fbs_postings', 'fbo_postings', 'fbp_postings'] as const;
const capability = (source: SyncSource) => source === 'chat' ? 'chats_read' : source === 'products' ? 'products_read'
  : source === 'fbs_postings' ? 'orders_fbs_read' : source === 'fbo_postings' ? 'orders_fbo_read' : 'orders_fbp_read';
const capabilitySchema = v.array(v.strictObject({ code: v.string(), status: v.string() }));
const orderSeed = (source: SyncSource) => source === 'fbs_postings' ? prepareFbsSyncSeed : source === 'fbo_postings' ? prepareFboSyncSeed : prepareFbpSyncSeed;
const orderWindow = (source: SyncSource) => source === 'fbs_postings' ? 'fbs_sync_window' : source === 'fbo_postings' ? 'fbo_sync_window' : 'fbp_sync_window';
const nowValue = () => Date.now();

type Dependencies = { wake?: (env: SyncBindings, scope: SyncScope) => Promise<void>; now?: () => number; force?: boolean };
export type BootstrapResult = { status: 'completed' | 'skipped' | 'failed'; error?: string };

/**
 * Start the one-time initial read for one store. This only creates durable work and
 * wakes the coordinator; it never performs an Ozon request itself.
 */
export async function bootstrapStoreSync(env: SyncBindings, scope: SyncScope, deps: Dependencies = {}): Promise<BootstrapResult> {
  const db = env.DB;
  if (!db) return { status: 'failed', error: 'DB_UNAVAILABLE' };
  const now = deps.now?.() ?? nowValue();
  const store = await db.prepare(`SELECT platform,status,capabilities,credential_version AS credentialVersion,expires_at AS expiresAt,credential_ciphertext AS ciphertext
    FROM store WHERE id=? AND organization_id=?`).bind(scope.storeId, scope.orgId).first<{platform:string;status:string;capabilities:string;credentialVersion:number;expiresAt:number|null;ciphertext:string|null}>();
  if (!store || store.platform !== 'ozon' || !['verified', 'partial'].includes(store.status) || !store.ciphertext || (store.expiresAt ?? 0) <= now) return { status: 'skipped' };
  let capabilities: v.InferOutput<typeof capabilitySchema>;
  try { capabilities = v.parse(capabilitySchema, JSON.parse(store.capabilities ?? '[]')); } catch { return { status: 'failed', error: 'CAPABILITIES_INVALID' }; }
  const available = sources.filter(source => {
    const required = capability(source);
    return capabilities.some(item => item.code === 'auth' && item.status === 'available') && capabilities.some(item => item.code === required && item.status === 'available');
  });
  const saved = await db.prepare('SELECT completed_at AS completedAt FROM sync_bootstrap WHERE id=?').bind(scope.storeId).first<{ completedAt: number | null }>();
  const existingSources = (await db.prepare('SELECT source FROM store_sync_source WHERE store_id=? AND organization_id=?').bind(scope.storeId, scope.orgId).all<{ source: string }>()).results;
  const missing = available.filter(source => !existingSources.some(row => row.source === source));
  if (saved?.completedAt != null && (!deps.force || !missing.length)) return { status: 'completed' };
  const active = saved?.completedAt != null ? missing : available;
  await db.prepare(`INSERT INTO sync_bootstrap(id,started_at) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET started_at=excluded.started_at,last_error=NULL`).bind(scope.storeId, now).run();
  if (!active.length) {
    await db.prepare('UPDATE sync_bootstrap SET completed_at=?,last_error=NULL WHERE id=?').bind(now, scope.storeId).run();
    return { status: 'completed' };
  }
  const endpoint = await readEndpoint(db, scope), push = endpoint?.mode === 'active' && endpoint.cutoverAt != null;
  for (const source of active) {
    const existing = await db.prepare('SELECT epoch FROM store_sync_source WHERE store_id=? AND organization_id=? AND source=?')
      .bind(scope.storeId, scope.orgId, source).first<{ epoch: number }>();
    const epoch = Math.max(existing?.epoch ?? 0, 1);
    await db.prepare(`INSERT INTO store_coordinator(store_id,organization_id) VALUES(?,?) ON CONFLICT DO NOTHING`).bind(scope.storeId, scope.orgId).run();
    await db.prepare(`INSERT INTO store_sync_source(store_id,organization_id,source,enabled,epoch,credential_version,due_at,updated_at)
      VALUES(?,?,?,1,?,?,?,?) ON CONFLICT(store_id,organization_id,source) DO UPDATE SET enabled=1,
      epoch=MAX(store_sync_source.epoch,excluded.epoch),credential_version=excluded.credential_version,due_at=MIN(store_sync_source.due_at,excluded.due_at),updated_at=excluded.updated_at`)
      .bind(scope.storeId, scope.orgId, source, epoch, store.credentialVersion, now, now).run();
    if (push) {
      await enqueueBootstrapReconcile(db, scope, source);
      continue;
    }
    if (source === 'chat') {
      await db.prepare(`INSERT INTO sync_cursor(organization_id,store_id,thread_id,stream,cursor,revision,due_at,completed)
        VALUES(?,?,?,'discovery',NULL,0,?,0) ON CONFLICT(store_id,stream,thread_id) DO UPDATE SET due_at=MIN(sync_cursor.due_at,excluded.due_at)`)
        .bind(scope.orgId, scope.storeId, '', now).run();
    } else if (source === 'products') {
      const seeded = await db.prepare('SELECT 1 FROM product_sync_cursor WHERE store_id=? AND organization_id=?').bind(scope.storeId, scope.orgId).first();
      if (!seeded) await db.batch(prepareProductSyncSeed(db, scope, epoch, { sql: '1', values: [] }));
      else await db.prepare('UPDATE product_sync_cursor SET due_at=? WHERE store_id=? AND organization_id=?').bind(now, scope.storeId, scope.orgId).run();
    } else {
      const table = orderWindow(source);
      const seeded = await db.prepare(`SELECT 1 FROM ${table} WHERE store_id=? AND organization_id=?`).bind(scope.storeId, scope.orgId).first();
      if (!seeded) await db.batch(orderSeed(source)(db, scope, epoch, { sql: '1', values: [] }));
      else await db.prepare(`UPDATE ${table} SET due_at=? WHERE store_id=? AND organization_id=?`).bind(now, scope.storeId, scope.orgId).run();
    }
  }
  try { await (deps.wake ?? wakeStoreSync)(env, scope); }
  catch { await db.prepare('UPDATE sync_bootstrap SET last_error=? WHERE id=?').bind('WAKE_FAILED', scope.storeId).run(); return { status: 'failed', error: 'WAKE_FAILED' }; }
  await db.prepare('UPDATE sync_bootstrap SET completed_at=?,last_error=NULL WHERE id=?').bind(now, scope.storeId).run();
  return { status: 'completed' };
}

/**
 * One-time startup pass. It is not a polling loop: after every eligible store has a
 * completed marker, subsequent scheduled ticks do no Ozon discovery. New stores call
 * bootstrapStoreSync after their capability check.
 */
export async function runStartupBootstrap(env: SyncBindings, deps: Dependencies = {}): Promise<void> {
  const db = env.DB;
  if (!db) return;
  const global = await db.prepare("SELECT completed_at AS completedAt FROM sync_bootstrap WHERE id='startup'").first<{ completedAt: number | null }>();
  if (global?.completedAt != null) return;
  const now = deps.now?.() ?? nowValue();
  await db.prepare("INSERT INTO sync_bootstrap(id,started_at) VALUES('startup',?) ON CONFLICT(id) DO UPDATE SET started_at=COALESCE(sync_bootstrap.started_at,excluded.started_at)").bind(now).run();
  const stores = (await db.prepare(`SELECT store.id AS storeId,store.organization_id AS orgId FROM store
    WHERE store.platform='ozon' AND store.status IN ('verified','partial') AND store.credential_ciphertext IS NOT NULL AND store.expires_at>?
     AND NOT EXISTS(SELECT 1 FROM sync_bootstrap AS marker WHERE marker.id=store.id AND marker.completed_at IS NOT NULL)
    ORDER BY store.id LIMIT 50`).bind(now).all<SyncScope>()).results;
  for (let offset = 0; offset < stores.length; offset += 5) await Promise.allSettled(stores.slice(offset, offset + 5).map(scope => bootstrapStoreSync(env, scope, deps)));
  const remaining = await db.prepare(`SELECT 1 FROM store WHERE store.platform='ozon' AND store.status IN ('verified','partial')
    AND store.credential_ciphertext IS NOT NULL AND store.expires_at>?
    AND NOT EXISTS(SELECT 1 FROM sync_bootstrap AS marker WHERE marker.id=store.id AND marker.completed_at IS NOT NULL) LIMIT 1`).bind(now).first();
  if (remaining) await db.prepare("UPDATE sync_bootstrap SET last_error='BOOTSTRAP_PENDING' WHERE id='startup'").run();
  else await db.prepare("UPDATE sync_bootstrap SET completed_at=?,last_error=NULL WHERE id='startup'").bind(now).run();
}
