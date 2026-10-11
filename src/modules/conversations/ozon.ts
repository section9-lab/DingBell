import { OzonReadError, readOzonJSON, type Credentials } from '../ozon/read.ts';
export { OzonReadError };
export type { OzonReadCode, Credentials } from '../ozon/read.ts';

export interface OzonChat {
  id: string; type: string; status: string; createdAt: string;
  lastMessageId: string | null; firstUnreadMessageId: string | null; unreadCount: number;
}
export interface OzonMessage {
  id: string; createdAt: string; senderId: string | null; senderType: string;
  content: string[]; isImage: boolean; isRead: boolean; orderNumber: string | null; sku: string | null;
}
const decimal = /^(0|[1-9][0-9]{0,39})$/;
function invalid(): never { throw new OzonReadError('invalid_response'); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function text(value: unknown, maximum = 256): string { if (typeof value !== 'string' || !value || value.length > maximum) invalid(); return value; }
function id(value: unknown): string { const result = text(value, 40); if (!decimal.test(result)) invalid(); return result; }
function optionalId(value: unknown): string | null { return value === undefined || value === null || value === '' ? null : id(value); }
function optionalText(value: unknown): string | null { return value === undefined || value === null || value === '' ? null : text(value); }
function timestamp(value: unknown): string { const result = text(value, 64); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) invalid(); return result; }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function limit(value = 50): number { if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new OzonReadError('invalid_request'); return value; }
export async function listOzonChats(credentials: Credentials, options: { cursor?: string; limit?: number } = {}, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<{ chats: OzonChat[]; cursor: string | null; hasNext: boolean }> {
  const size = limit(options.limit);
  if (options.cursor !== undefined && (typeof options.cursor !== 'string' || !options.cursor || options.cursor.length > 4096)) throw new OzonReadError('invalid_request');
  const value = await readOzonJSON(credentials, '/v3/chat/list', JSON.stringify({ limit: size, ...(options.cursor ? { cursor: options.cursor } : {}) }), fetcher, signal);
  const hasNext = boolean(value.has_next);
  if (!Array.isArray(value.chats) || value.chats.length > size || hasNext && !value.chats.length) invalid();
  const chats = value.chats.map(item => {
    const row = object(item), chat = object(row.chat);
    if (typeof row.unread_count !== 'number' || !Number.isSafeInteger(row.unread_count) || row.unread_count < 0) invalid();
    return { id: text(chat.chat_id), type: text(chat.chat_type), status: text(chat.chat_status), createdAt: timestamp(chat.created_at), lastMessageId: optionalId(row.last_message_id), firstUnreadMessageId: optionalId(row.first_unread_message_id), unreadCount: row.unread_count };
  });
  return { chats, cursor: hasNext ? text(value.cursor, 4096) : null, hasNext };
}

export async function readOzonMessages(credentials: Credentials, options: { chatId: string; direction: 'Backward' | 'Forward'; fromMessageId?: string; limit?: number }, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<{ messages: OzonMessage[]; hasNext: boolean }> {
  const size = limit(options.limit);
  if (typeof options.chatId !== 'string' || !options.chatId || options.chatId.length > 256 || !['Backward', 'Forward'].includes(options.direction) || options.direction === 'Forward' && options.fromMessageId === undefined || options.fromMessageId !== undefined && (typeof options.fromMessageId !== 'string' || !decimal.test(options.fromMessageId))) throw new OzonReadError('invalid_request');
  const base = JSON.stringify({ chat_id: options.chatId, direction: options.direction, limit: size });
  // Only this validated decimal field needs a raw numeric token; no general JSON serializer.
  const body = options.fromMessageId === undefined ? base : `${base.slice(0, -1)},"from_message_id":${options.fromMessageId}}`;
  const value = await readOzonJSON(credentials, '/v3/chat/history', body, fetcher, signal);
  const hasNext = boolean(value.has_next);
  if (!Array.isArray(value.messages) || value.messages.length > size || hasNext && !value.messages.length) invalid();
  const messages = value.messages.map(item => {
    const row = object(item), user = object(row.user), context = row.context === undefined || row.context === null ? {} : object(row.context);
    if (!Array.isArray(row.data) || row.data.some(part => typeof part !== 'string')) invalid();
    return { id: id(row.message_id), createdAt: timestamp(row.created_at), senderId: optionalId(user.id), senderType: text(user.type), content: row.data as string[], isImage: boolean(row.is_image), isRead: boolean(row.is_read), orderNumber: optionalText(context.order_number), sku: optionalId(context.sku) };
  });
  return { messages, hasNext };
}
