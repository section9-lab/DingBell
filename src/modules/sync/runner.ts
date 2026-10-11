import { listOzonChats, readOzonMessages, OzonReadError } from '../conversations/ozon.ts';
import { CredentialError, decryptCredentials } from '../stores/credentials.ts';
import { getDueProductWork } from '../products/storage.ts';
import { runProductPage } from '../products/runner.ts';
import { getDueFbsWork } from '../orders/storage.ts';
import { runFbsPage } from '../orders/runner.ts';
import type { SyncBindings, SyncBucket } from './bindings.ts';
import { claimSyncLease, commitSyncPage, finishSyncFailure, getDueSyncCursor, getSyncRuntime, releaseSyncLease } from './storage.ts';
import type { NormalizedMessage, SyncScope } from './types.ts';

export function checkCursorProgress(previous: string | null, next: string | null, recent: string[], hasNext: boolean): void {
  if (hasNext && (next === null || next === previous) || next !== null && next !== previous && recent.includes(next)) throw new Error('cursor_stalled');
}

export function historyCheckpoint(direction: 'Backward' | 'Forward', previous: string | null, messages: { id: string; createdAt?: string }[], hasNext: boolean): string | null {
  for (let index = 1; index < messages.length; index++) {
    const prior = messages[index - 1]!.createdAt, current = messages[index]!.createdAt;
    if (prior && current && (direction === 'Forward' ? Date.parse(prior) > Date.parse(current) : Date.parse(prior) < Date.parse(current))) throw new OzonReadError('invalid_response');
  }
  const next = messages.at(-1)?.id ?? previous;
  if (hasNext && (next === null || next === previous)) throw new Error('cursor_stalled');
  return next;
}

export function retrySyncFailure(error: { code: string; retryAfterMs?: number }, stream: string, failures: number, now: number, jitter = Math.random()): { code: string; nextDueAt: number; disable: boolean; blockedUntil?: number; disableAll?: boolean } {
  const permissions: Record<string, string> = { discovery: 'chat_list_permission_denied', 'product-list': 'product_list_permission_denied', 'product-details': 'product_details_permission_denied', 'fbs-list': 'fbs_list_permission_denied', 'fbs-detail': 'fbs_details_permission_denied' };
  const code = error.code === 'permission_denied'
    ? permissions[stream] ?? 'chat_history_permission_denied'
    : error.code;
  const wait = error.retryAfterMs ?? 0;
  if (wait > 86_400_000) return { code: 'retry_after_requires_review', nextDueAt: now, disable: true, blockedUntil: Math.min(8_640_000_000_000_000, now + wait) };
  const terminal = ['invalid_credentials', 'credentials_unavailable', 'chat_list_permission_denied', 'chat_history_permission_denied', 'product_list_permission_denied', 'product_details_permission_denied', 'fbs_list_permission_denied', 'fbs_details_permission_denied', 'invalid_request', 'redirect_refused', 'cursor_stalled'].includes(code);
  const delay = Math.max(wait, Math.min(300_000, 5_000 * 2 ** Math.min(failures, 6)) * (1 + Math.max(0, Math.min(1, jitter))));
  return { code, nextDueAt: now + delay, disable: terminal || failures >= 4,
    ...(['invalid_credentials', 'credentials_unavailable'].includes(code) ? { disableAll: true } : {}),
    ...(code === 'rate_limited' ? { blockedUntil: now + delay } : {}) };
}

export async function runSyncPage(env: SyncBindings & { DB: D1Database }, scope: SyncScope, options: {
  fetcher?: typeof fetch;
  reserve?: (bucket: SyncBucket, now: number) => Promise<number>;
  now?: () => number;
} = {}): Promise<void> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const lease = await claimSyncLease(env.DB, { ...scope, token: crypto.randomUUID(), leaseMs: 20_000 });
  if (!lease) return;
  let stream = lease.source === 'products' ? 'product-list' : lease.source === 'fbs_postings' ? 'fbs-list' : 'discovery', failures = 0;
  try {
    const runtime = await getSyncRuntime(env.DB, scope, lease.source);
    if (!runtime || runtime.state.epoch !== lease.epoch) return;
    failures = runtime.state.failures;
    const task = lease.source === 'products' ? { source:'products' as const, work:await getDueProductWork(env.DB, lease) }
      : lease.source === 'fbs_postings' ? { source:'fbs_postings' as const, work:await getDueFbsWork(env.DB, lease, now()) }
      : { source:'chat' as const, work:await getDueSyncCursor(env.DB, lease) };
    if (!task.work) {
      const waiting = await getSyncRuntime(env.DB, scope, lease.source);
      await releaseSyncLease(env.DB, lease, Math.max(now() + 30_000, waiting?.state.dueAt ?? 0));
      return;
    }
    let bucket: SyncBucket;
    if (task.source === 'chat') { stream = task.work.stream; bucket = stream === 'discovery' ? 'chat-list' : 'chat-history'; }
    else if (task.source === 'products') { stream = `product-${task.work.kind}`; bucket = task.work.kind === 'list' ? 'product-list' : 'product-details'; }
    else { stream = task.work.kind === 'list' ? 'fbs-list' : 'fbs-detail'; bucket = stream as 'fbs-list' | 'fbs-detail'; }
    const permitAt = await options.reserve?.(bucket, now()) ?? now();
    if (permitAt > now()) { await releaseSyncLease(env.DB, lease, permitAt); return; }
    const current = await getSyncRuntime(env.DB, scope, lease.source);
    if (!current || current.state.epoch !== lease.epoch || current.store.credentialVersion !== lease.credentialVersion || current.store.revision !== lease.storeRevision) return;
    const store = current.store;
    if (!store.credentialKeyVersion || !store.credentialNonce || !store.credentialCiphertext) throw new CredentialError();
    const { apiKey } = await decryptCredentials(env, { ...scope, platformStoreId: store.platformStoreId, credentialVersion: lease.credentialVersion },
      { keyVersion: store.credentialKeyVersion, nonce: store.credentialNonce, ciphertext: store.credentialCiphertext });
    const remaining = 10_000 - (now() - startedAt);
    if (remaining <= 0) throw new OzonReadError('timed_out');
    const signal = AbortSignal.timeout(remaining);
    const credentials = { clientId: store.platformStoreId, apiKey };
    if (task.source === 'products') { await runProductPage(env.DB, lease, task.work, credentials, { fetcher: options.fetcher, signal, now }); return; }
    if (task.source === 'fbs_postings') { await runFbsPage(env.DB, lease, task.work, credentials, { fetcher: options.fetcher, signal, now }); return; }
    const cursor = task.work;
    if (cursor.stream === 'discovery') {
      const page = await listOzonChats(credentials, { cursor: cursor.cursor ?? undefined }, options.fetcher, signal);
      checkCursorProgress(cursor.cursor, page.cursor, cursor.recentCursors, page.hasNext);
      const chats = page.chats.filter(chat => chat.type === 'BUYER_SELLER');
      await commitSyncPage(env.DB, lease, {
        cursor, nextCursor: page.cursor, nextDueAt: now() + (page.hasNext ? 10_000 : 60_000), completed: false, continuing: page.hasNext,
        chats: chats.map(chat => ({ platformThreadId: chat.id, type: chat.type, status: chat.status, createdAt: Date.parse(chat.createdAt), lastMessageId: chat.lastMessageId })),
        seeds: chats.flatMap(chat => [
          { threadId: chat.id, stream: 'backfill' as const, cursor: null, dueAt: now() },
          { threadId: chat.id, stream: 'incremental' as const, cursor: chat.lastMessageId, dueAt: now() + 60_000 },
        ]),
      });
    } else {
      const bootstrapSnapshot = cursor.stream === 'incremental' && cursor.cursor === null;
      const direction = cursor.stream === 'backfill' || bootstrapSnapshot ? 'Backward' : 'Forward';
      const page = await readOzonMessages(credentials, { chatId: cursor.threadId, direction, fromMessageId: cursor.cursor ?? undefined }, options.fetcher, signal);
      const oldestOrNext = historyCheckpoint(direction, cursor.cursor, page.messages, page.hasNext);
      const nextCursor = bootstrapSnapshot ? page.messages[0]?.id ?? null : oldestOrNext;
      checkCursorProgress(cursor.cursor, nextCursor, cursor.recentCursors, !bootstrapSnapshot && page.hasNext);
      const messages: NormalizedMessage[] = page.messages
        .filter(message => cursor.stream === 'backfill' || message.id !== cursor.cursor)
        .map(message => ({ platformThreadId: cursor.threadId, platformMessageId: message.id, senderId: message.senderId,
          senderType: message.senderType, content: message.content, isImage: message.isImage, isRead: message.isRead,
          orderNumber: message.orderNumber, sku: message.sku, eventAt: Date.parse(message.createdAt), liveObserved: cursor.stream === 'incremental' && !bootstrapSnapshot,
          direction: ['Customer', 'Сustomer'].includes(message.senderType) ? 'inbound' : message.senderType === 'Seller' ? 'outbound' : 'unknown' }));
      await commitSyncPage(env.DB, lease, { cursor, nextCursor,
        nextDueAt: now() + (!bootstrapSnapshot && page.hasNext ? 1_000 : 30_000), completed: cursor.stream === 'backfill' && !page.hasNext,
        continuing: !bootstrapSnapshot && page.hasNext, messages, bootstrapSnapshot,
        ...(bootstrapSnapshot && page.hasNext ? { restartBackfill: { cursor: oldestOrNext! } } : {}) });
    }
  } catch (error) {
    const failure = error instanceof OzonReadError ? error : { code: error instanceof CredentialError ? 'credentials_unavailable' : error instanceof Error && error.message === 'cursor_stalled' ? 'cursor_stalled' : 'sync_failed' };
    await finishSyncFailure(env.DB, lease, retrySyncFailure(failure, stream, failures, now()));
  }
}
