import type { ConversationMessage, readConversationMessages, readConversationMessageUpdates } from './conversations-api.ts';

export type MessagePage = Awaited<ReturnType<typeof readConversationMessages>>;
export type MessageUpdates = Awaited<ReturnType<typeof readConversationMessageUpdates>>;
export type MessageLocator = Pick<ConversationMessage, 'id' | 'eventAt'>;
export interface MessageWindow {
  messages: ConversationMessage[]; viewerMemberId: string; historyCursor: string; updatesCursor: string;
}
export function compareMessages(a: MessageLocator, b: MessageLocator) {
  const time = Date.parse(a.eventAt) - Date.parse(b.eventAt); if (time) return time;
  // SQLite BINARY sorts UTF-8 by code point; locale sorting changes equal-time page boundaries.
  const left = Array.from(a.id), right = Array.from(b.id);
  for (let i = 0; i < Math.min(left.length, right.length); i++) { const diff = left[i].codePointAt(0)! - right[i].codePointAt(0)!; if (diff) return diff; }
  return left.length - right.length;
}
export function startMessageWindow(page: MessagePage): MessageWindow {
  return { messages: page.messages, viewerMemberId: page.viewerMemberId, historyCursor: page.pageCursor, updatesCursor: page.updatesCursor };
}
/** Mutable platform observations (read flags / verified echoes) do not advance the append-only stream. */
export function refreshMessageWindowMetadata(current:MessageWindow,page:MessagePage):MessageWindow{
  if(page.viewerMemberId!==current.viewerMemberId)return current;
  const facts=new Map(page.messages.map(item=>[item.id,item]));let changed=false;
  const messages=current.messages.map(item=>{const fresh=facts.get(item.id);if(!fresh||JSON.stringify(item)===JSON.stringify(fresh))return item;changed=true;return fresh;});
  return changed?{...current,messages:messages.sort(compareMessages)}:current;
}
/** The window holds the whole conversation, so later batches merge in place instead of trimming a suffix. */
export function applyMessageUpdates(current: MessageWindow, requestedCursor: string, batch: MessageUpdates): MessageWindow {
  if (requestedCursor !== current.updatesCursor || batch.viewerMemberId !== current.viewerMemberId) return current;
  if (!batch.messages.length && batch.nextCursor === current.updatesCursor && batch.historyCursor === current.historyCursor) return current;
  const records = new Map(current.messages.map(item => [item.id, item]));
  for (const item of batch.messages) records.set(item.id, item);
  return { ...current, messages: [...records.values()].sort(compareMessages), historyCursor: batch.historyCursor, updatesCursor: batch.nextCursor };
}
