import type { DurableObject } from 'cloudflare:workers';
import type { SyncBindings, SyncBucket } from './bindings.ts';
import type { SyncScope } from './types.ts';
import { getStoreCoordinatorRuntime, getStoreSendCooldown, recordStoreSendCooldown } from './storage.ts';
import { runSyncPage } from './runner.ts';

export function createStoreCoordinator(Base: typeof DurableObject<SyncBindings>) {
return class StoreCoordinator extends Base {
  async wake(scope: SyncScope): Promise<void> {
    if (!scope || ![scope.orgId, scope.storeId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)) throw new Error('Invalid sync scope.');
    await this.ctx.storage.transaction(async transaction => {
      const existing = await transaction.get<SyncScope>('scope');
      if (existing && (existing.orgId !== scope.orgId || existing.storeId !== scope.storeId)) throw new Error('Sync scope cannot change.');
      if (!existing) await transaction.put('scope', scope);
    });
    await this.schedule(scope);
  }

  private async sendScope(scope: SyncScope) {
    if (!scope || ![scope.orgId, scope.storeId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)
      || !this.env.DB || !this.env.STORE_COORDINATOR || !this.ctx.id.equals(this.env.STORE_COORDINATOR.idFromName(JSON.stringify([scope.orgId, scope.storeId])))) throw new Error('Invalid send scope.');
    const runtime = await getStoreSendCooldown(this.env.DB, scope);
    if (!runtime) throw new Error('Send store is unavailable.');
    await this.ctx.storage.transaction(async transaction => {
      const existing = await transaction.get<SyncScope>('scope');
      if (existing && (existing.orgId !== scope.orgId || existing.storeId !== scope.storeId)) throw new Error('Sync scope cannot change.');
      if (!existing) await transaction.put('scope', scope);
    });
    return runtime;
  }

  async reserveSend(scope: SyncScope): Promise<number> {
    const runtime = await this.sendScope(scope);
    if (runtime.status === 'paused' || runtime.status === 'disconnected') throw new Error('Send store is unavailable.');
    const now = Date.now();
    if (runtime.blockedUntil !== null && runtime.blockedUntil > now) return runtime.blockedUntil;
    return this.reserve('chat-send', now);
  }

  async recordSendRateLimit(scope: SyncScope, until: number): Promise<void> {
    if (!Number.isSafeInteger(until) || until < 0 || until > 8_640_000_000_000_000) throw new Error('Invalid send cooldown.');
    await this.sendScope(scope);
    await this.ctx.storage.transaction(async transaction => {
      const limits = await transaction.get<{ all: number; buckets: Record<string, number> }>('rate') ?? { all: 0, buckets: {} };
      await transaction.put('rate', { ...limits, all: Math.max(limits.all, until) });
    });
    if (!await recordStoreSendCooldown(this.env.DB!, scope, until)) throw new Error('Send store is unavailable.');
  }

  async alarm(): Promise<void> {
    const scope = await this.ctx.storage.get<SyncScope>('scope');
    if (!scope) return;
    await this.runPage(scope);
    await this.schedule(scope);
  }

  protected async runPage(scope: SyncScope): Promise<void> {
    if (!this.env.DB) throw new Error('Sync database is unavailable.');
    await runSyncPage({ ...this.env, DB: this.env.DB }, scope, { reserve: (bucket, now) => this.reserve(bucket, now) });
  }

  protected async reserve(bucket: SyncBucket, now: number): Promise<number> {
    return this.ctx.storage.transaction(async transaction => {
      const limits = await transaction.get<{ all: number; buckets: Record<string, number> }>('rate') ?? { all: 0, buckets: {} };
      const due = Math.max(limits.all, limits.buckets[bucket] ?? 0);
      if (due > now) return due;
      await transaction.put('rate', { all: now + 1_000, buckets: { ...limits.buckets, [bucket]: now + 1_000 } });
      return now;
    });
  }

  private async schedule(scope: SyncScope): Promise<void> {
    if (!this.env.DB) throw new Error('Sync database is unavailable.');
    const runtime = await getStoreCoordinatorRuntime(this.env.DB, scope);
    if (!runtime) { await this.ctx.storage.deleteAlarm(); return; }
    const rate = await this.ctx.storage.get<{ all: number }>('rate');
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, runtime.dueAt, runtime.leaseUntil ?? 0, rate?.all ?? 0));
  }
}

}
