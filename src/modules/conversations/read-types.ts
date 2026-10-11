import type { StoreStatus } from '../stores/storage.ts';

export interface MessagePreview {
  id: string; platformMessageId: string; content: string[]; senderId: string | null; senderType: string;
  direction: 'inbound' | 'outbound' | 'unknown'; isImage: boolean; eventAt: number; previewTruncated: boolean;
}
export interface MessageView extends Omit<MessagePreview,'previewTruncated'> {
  sequence: number; receivedAt: number; ingestMode: 'backfill' | 'incremental'; orderNumber: string | null; sku: string | null;
}
export interface ConversationSummary {
  id: string; store: { id: string; name: string; status: StoreStatus };
  platformThreadId: string; platformType: string; platformStatus: string;
  platformCreatedAt: number; importedAt: number; lastMessageAt: number | null; latestMessage: MessagePreview | null;
}
export interface ConversationDetail extends ConversationSummary {
  sync: { enabled: boolean; lastSuccessAt: number | null; lastError: string | null; backfillComplete: boolean | null };
}
export type ConversationQueue = 'all' | 'mine' | 'unassigned';
export type ConversationStateFilter = 'all' | 'needs_reply' | 'waiting_customer' | 'waiting_internal' | 'resolved';
export interface ConversationWorkflow {
  version: number; lifecycle: 'open' | 'resolved'; workStatus: 'needs_reply' | 'waiting_customer' | 'waiting_internal' | null;
  assignedMemberId: string | null; assigneeName: string | null;
}
export interface ConversationListItem extends ConversationSummary { workflow: ConversationWorkflow }
export interface ConversationListResult {
  items: ConversationListItem[]; nextCursor: string | null; viewerMemberId: string;
  counts: { all: number; mine: number; unassigned: number };
}
export interface ConversationListOptions {
  storeId?: string; search?: { field: 'thread' | 'order'; value: string }; cursor?: string; limit: number;
  queue?: ConversationQueue; state?: ConversationStateFilter;
}
export interface MessageListOptions { cursor?: string; limit: number; anchorId?: string; direction?: 'older' | 'newer' | 'from' }
export interface MessageListResult {
  items: MessageView[]; nextCursor: string | null; newerCursor: string | null; pageCursor: string; updatesCursor: string; viewerMemberId: string;
}
export interface MessageUpdatesResult { items: MessageView[]; nextCursor: string; historyCursor: string; hasMore: boolean; viewerMemberId: string }
