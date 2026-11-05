import {readEndpoint} from '../ozon-push/storage.ts';
import {runPushPage} from '../ozon-push/worker.ts';
import { listOzonChats, readOzonMessages, OzonReadError } from '../conversations/ozon.ts';
import { CredentialError, decryptCredentials } from '../stores/credentials.ts';
import { getDueProductWork } from '../products/storage.ts';
import { runProductPage } from '../products/runner.ts';
import { getDueFbsWork, getDueFboWork,getDueFbpWork } from '../orders/storage.ts';
import { runFbsPage, runFboPage,runFbpPage } from '../orders/runner.ts';
import type { SyncBindings, SyncBucket } from './bindings.ts';
import { claimSyncLease, commitSyncPage, finishSyncFailure, getDueSyncCursor, getSyncRuntime, releaseSyncLease } from './storage.ts';
import type { SyncLease, NormalizedMessage, SyncScope } from './types.ts';
import { historyDueIn, retrySyncFailure } from './policy.ts';

// Preserve the existing public entry points for callers and tests.
export { historyDueIn, retrySyncFailure } from './policy.ts';

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

// Ozon 消息 id 是数字串；非数字或 '0'（平台用它表示「没有可用的最新消息」）
// 不能作为增量起点，必须退回引导快照，否则该会话会永远空转。
const validCursor = (value: string | null | undefined): value is string => typeof value === 'string' && /^\d+$/.test(value) && value !== '0';

/** 每个会话在库里已有的最新消息 id：增量从这里继续，而不是跳过平台最新一条。 */
async function lastSeenMessageIds(db: D1Database, lease: SyncLease, threadIds: string[]) {
  const map = new Map<string, string>();
  if (!threadIds.length || !db) return map;
  const rows = await db.prepare(`SELECT conversation.platform_thread_id AS threadId,message.platform_message_id AS lastSeen
    FROM message JOIN conversation ON conversation.id=message.conversation_id
      AND conversation.organization_id=message.organization_id AND conversation.store_id=message.store_id
    WHERE message.store_id=? AND message.organization_id=? AND conversation.platform_thread_id IN (${threadIds.map(() => '?').join(',')})
    ORDER BY message.event_at DESC,message.id DESC`).bind(lease.storeId, lease.orgId, ...threadIds)
    .all<{ threadId: string; lastSeen: string }>();
  for (const row of rows.results) if (!map.has(row.threadId)) map.set(row.threadId, row.lastSeen);
  return map;
}

export async function runSyncPage(env: SyncBindings & { DB: D1Database }, scope: SyncScope, options: {
  fetcher?: typeof fetch;
  onCommittedLive?: (scope:SyncScope)=>void;
  reserve?: (bucket: SyncBucket, now: number) => Promise<number>;
  now?: () => number;
} = {}): Promise<void> {
  const endpoint=await readEndpoint(env.DB,scope);
  if(endpoint?.cutoverAt!=null){if(endpoint.mode==='active')await runPushPage(env,scope,options);return;}
  const now = options.now ?? Date.now;
  const startedAt = now();
  const lease = await claimSyncLease(env.DB, { ...scope, token: crypto.randomUUID(), leaseMs: 20_000 });
  if (!lease) return;
  let stream = lease.source === 'products' ? 'product-list' : lease.source === 'fbs_postings' ? 'fbs-list' : lease.source === 'fbo_postings' ? 'fbo-list' :lease.source==='fbp_postings'?'fbp-list': 'discovery', failures = 0;
  try {
    const runtime = await getSyncRuntime(env.DB, scope, lease.source);
    if (!runtime || runtime.state.epoch !== lease.epoch) return;
    failures = runtime.state.failures;
    const task = lease.source === 'products' ? { source:'products' as const, work:await getDueProductWork(env.DB, lease) }
      : lease.source === 'fbs_postings' ? { source:'fbs_postings' as const, work:await getDueFbsWork(env.DB, lease, now()) }
      : lease.source === 'fbo_postings' ? { source:'fbo_postings' as const, work:await getDueFboWork(env.DB, lease, now()) }
      : lease.source === 'fbp_postings' ? {source:'fbp_postings' as const,work:await getDueFbpWork(env.DB,lease,now())}
      : { source:'chat' as const, work:await getDueSyncCursor(env.DB, lease) };
    if (!task.work) {
      const waiting = await getSyncRuntime(env.DB, scope, lease.source);
      await releaseSyncLease(env.DB, lease, Math.max(now() + 30_000, waiting?.state.dueAt ?? 0));
      return;
    }
    let bucket: SyncBucket;
    if (task.source === 'chat') { stream = task.work.stream; bucket = stream === 'discovery' ? 'chat-list' : 'chat-history'; }
    else if (task.source === 'products') { stream = `product-${task.work.kind}`; bucket = task.work.kind === 'list' ? 'product-list' : 'product-details'; }
    else { const mode=task.source==='fbs_postings'?'fbs':task.source==='fbo_postings'?'fbo':'fbp'; bucket = task.work.kind==='list'?`${mode}-list`:`${mode}-detail`; stream=bucket; }
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
    if (task.source === 'fbs_postings' || task.source === 'fbo_postings'||task.source==='fbp_postings') { await (task.source==='fbs_postings'?runFbsPage:task.source==='fbo_postings'?runFboPage:runFbpPage)(env.DB, lease, task.work, credentials, { fetcher: options.fetcher, signal, now }); return; }
    const cursor = task.work;
    if (cursor.stream === 'discovery') {
      const page = await listOzonChats(credentials, { cursor: cursor.cursor ?? undefined }, options.fetcher, signal);
      checkCursorProgress(cursor.cursor, page.cursor, cursor.recentCursors, page.hasNext);
      const chats = page.chats.filter(chat => chat.type === 'BUYER_SELLER');
      // 增量游标指向库里已有的最新消息：平台 list 的 lastMessageId 可能无效
      // （如 '0'），而且用它当起点会把刚刚发出的消息直接跳过、永远拉不回来。
      const seen = await lastSeenMessageIds(env.DB, lease, chats.map(chat => chat.id));
      const incrementalCursor = (chat: { id: string; lastMessageId: string | null }) => {
        const known = seen.get(chat.id);
        if (known !== undefined) return validCursor(known) ? known : null;
        return validCursor(chat.lastMessageId) ? chat.lastMessageId : null;
      };
      await commitSyncPage(env.DB, lease, {
        cursor, nextCursor: page.cursor, nextDueAt: now() + (page.hasNext ? 10_000 : 60_000), completed: false, continuing: page.hasNext,
        chats: chats.map(chat => ({ platformThreadId: chat.id, type: chat.type, status: chat.status, createdAt: Date.parse(chat.createdAt), lastMessageId: chat.lastMessageId })),
        seeds: chats.flatMap(chat => [
          { threadId: chat.id, stream: 'backfill' as const, cursor: null, dueAt: now() },
          { threadId: chat.id, stream: 'incremental' as const, cursor: incrementalCursor(chat), dueAt: now() + 60_000 },
        ]),
      });
    } else {
      // 存量坏游标自愈：重置为引导快照（null），下一轮从最新一页开始回填。
      if (cursor.stream === 'incremental' && cursor.cursor !== null && !validCursor(cursor.cursor)) {
        await env.DB.prepare(`UPDATE sync_cursor SET cursor=NULL,recent_cursors='[]',revision=revision+1,due_at=CAST(unixepoch('subsecond')*1000 AS INTEGER)
          WHERE store_id=? AND organization_id=? AND thread_id=? AND stream='incremental'`)
          .bind(lease.storeId, lease.orgId, cursor.threadId).run();
        await releaseSyncLease(env.DB, lease, now() + 2_000);
        return;
      }
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
      const humans=messages.filter(message=>message.direction==='inbound'||message.direction==='outbound');
      const canonicalHead=direction==='Backward'&&cursor.cursor===null?{canonicalHead:humans[0]?.platformMessageId??null}
        :direction==='Forward'&&page.hasNext?{canonicalHead:null}:direction==='Forward'&&humans.length?{canonicalHead:humans.at(-1)!.platformMessageId}:{};
      await commitSyncPage(env.DB, lease, { cursor, nextCursor,...canonicalHead,
        nextDueAt: now() + historyDueIn(!bootstrapSnapshot && page.hasNext, messages.length), completed: cursor.stream === 'backfill' && !page.hasNext,
        continuing: !bootstrapSnapshot && page.hasNext, messages, bootstrapSnapshot,
        ...(bootstrapSnapshot && page.hasNext ? { restartBackfill: { cursor: oldestOrNext! } } : {}) });
    }
  } catch (error) {
    const failure = error instanceof OzonReadError ? error : { code: error instanceof CredentialError ? 'credentials_unavailable' : error instanceof Error && error.message === 'cursor_stalled' ? 'cursor_stalled' : 'sync_failed' };
    await finishSyncFailure(env.DB, lease, retrySyncFailure(failure, stream, failures, now()));
  }
}
