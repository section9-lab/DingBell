import { credentialConfig, type CredentialBindings } from '../stores/credentials.ts';
import type { StoreCoordinator } from './coordinator.ts';
import type { SyncScope } from './types.ts';

export type SyncBucket = 'chat-list' | 'chat-history' | 'product-list' | 'product-details' | 'fbs-list' | 'fbs-detail' | 'chat-send';
export interface SyncBindings extends CredentialBindings {
  DB?: D1Database;
  STORE_COORDINATOR?: DurableObjectNamespace<StoreCoordinator>;
}

export function syncConfigured(env: SyncBindings) {
  return !!env.DB && !!env.STORE_COORDINATOR && !!credentialConfig(env);
}

export async function wakeStoreSync(env: SyncBindings, scope: SyncScope): Promise<void> {
  if (!env.STORE_COORDINATOR) throw new Error('Sync coordinator is unavailable.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      env.STORE_COORDINATOR.getByName(JSON.stringify([scope.orgId, scope.storeId])).wake(scope),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Sync wake was not confirmed.')), 3_000); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function reserveReply(env: SyncBindings, scope: SyncScope): Promise<number> {
  if (!env.STORE_COORDINATOR) throw new Error('Send coordinator is unavailable.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      env.STORE_COORDINATOR.getByName(JSON.stringify([scope.orgId, scope.storeId])).reserveSend(scope),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Send permit was not confirmed.')), 3000); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function recordReplyRateLimit(env: SyncBindings, scope: SyncScope, until: number): Promise<void> {
  if (!env.STORE_COORDINATOR || !Number.isFinite(until) || !Number.isInteger(until) || until < 0) throw new Error('Invalid send cooldown.');
  const deadline = Math.min(until, 8_640_000_000_000_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      env.STORE_COORDINATOR.getByName(JSON.stringify([scope.orgId, scope.storeId])).recordSendRateLimit(scope, deadline),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Send cooldown was not confirmed.')), 3000); }),
    ]);
  } finally { clearTimeout(timer); }
}
