export interface SyncScope { orgId: string; storeId: string }
export type SyncSource = 'chat' | 'products' | 'fbs_postings';
export interface SyncSourceRecord extends SyncScope {
  source: SyncSource; enabled: boolean; epoch: number; fence: number; credentialVersion: number | null;
  dueAt: number; lastSuccessAt: number | null; lastError: string | null; failures: number; lastAttemptAt: number | null;
  leaseUntil: number | null; blockedUntil: number | null;
}
export interface StoreSyncRecord extends SyncSourceRecord { conversationCount: number; messageCount: number }
export interface StoreCoordinatorRecord extends SyncScope { dueAt: number; leaseUntil: number | null; blockedUntil: number | null }
export interface SyncLease extends SyncScope {
  source: SyncSource; epoch: number; fence: number; token: string; storeRevision: number; credentialVersion: number;
}
export interface SyncSQL { sql: string; values: (string | number | null)[] }
export type SyncStream = 'discovery' | 'backfill' | 'incremental';
export interface SyncCursor {
  storeId: string; threadId: string; stream: SyncStream; cursor: string | null;
  revision: number; dueAt: number; completed: boolean; recentCursors: string[];
}
export interface CursorSeed {
  threadId: string; stream: SyncStream; cursor: string | null; dueAt: number; completed?: boolean;
}
export interface NormalizedChat {
  platformThreadId: string; type: string; status: string; createdAt: number; lastMessageId: string | null;
}
export interface NormalizedMessage {
  platformThreadId: string; platformMessageId: string; senderId: string | null; senderType: string;
  content: string[]; isImage: boolean; isRead: boolean; orderNumber: string | null; sku: string | null;
  eventAt: number; direction: 'inbound' | 'outbound' | 'unknown'; liveObserved?: boolean;
}
export interface SyncPage {
  cursor: SyncCursor; nextCursor: string | null; nextDueAt: number; completed: boolean; continuing?: boolean; bootstrapSnapshot?: boolean; restartBackfill?: {cursor:string};
  chats?: NormalizedChat[]; messages?: NormalizedMessage[]; seeds?: CursorSeed[];
}
