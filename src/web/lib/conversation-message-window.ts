import type { ConversationMessage, readConversationMessages, readConversationMessageUpdates } from './conversations-api.ts';

export type MessagePage = Awaited<ReturnType<typeof readConversationMessages>>;
export type MessageUpdates = Awaited<ReturnType<typeof readConversationMessageUpdates>>;
export type MessageLocator = Pick<ConversationMessage, 'id' | 'eventAt'>;
export interface MessageWindow {
  messages: ConversationMessage[]; viewerMemberId: string; historyCursor: string; updatesCursor: string;
  hasOlder: boolean; earlierUpdate: MessageLocator | null;
}
function compare(a: MessageLocator, b: MessageLocator) {
  const time = Date.parse(a.eventAt) - Date.parse(b.eventAt); if (time) return time;
  // SQLite BINARY sorts UTF-8 by code point; locale sorting changes equal-time page boundaries.
  const left = Array.from(a.id), right = Array.from(b.id);
  for (let i = 0; i < Math.min(left.length, right.length); i++) { const diff = left[i].codePointAt(0)! - right[i].codePointAt(0)!; if (diff) return diff; }
  return left.length - right.length;
}
export function startMessageWindow(page: MessagePage): MessageWindow {
  return { messages: page.messages, viewerMemberId: page.viewerMemberId, historyCursor: page.pageCursor, updatesCursor: page.updatesCursor, hasOlder: page.nextCursor !== null, earlierUpdate: null };
}
export function applyMessageUpdates(current: MessageWindow, requestedCursor: string, batch: MessageUpdates): MessageWindow {
  if (requestedCursor !== current.updatesCursor || batch.viewerMemberId !== current.viewerMemberId) return current;
  if (!batch.messages.length && batch.nextCursor === current.updatesCursor && batch.historyCursor === current.historyCursor) return current;
  const oldest = current.messages[0], records = new Map(current.messages.map(item => [item.id, item]));
  let earlierUpdate = current.earlierUpdate;
  for (const item of batch.messages) {
    if (oldest && compare(item, oldest) < 0) {
      if (!earlierUpdate || compare(item, earlierUpdate) < 0) earlierUpdate = { id: item.id, eventAt: item.eventAt };
    } else records.set(item.id, item);
  }
  const ordered = [...records.values()].sort(compare), messages: ConversationMessage[] = [];
  let bytes = 0;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const size = new TextEncoder().encode(JSON.stringify(ordered[i].content)).length;
    if (messages.length && (messages.length >= 100 || bytes + size > 1_843_200)) break;
    messages.push(ordered[i]); bytes += size;
  }
  messages.reverse();
  return { ...current, messages, historyCursor: batch.historyCursor, updatesCursor: batch.nextCursor,
    hasOlder: current.hasOlder || earlierUpdate !== null || messages.length < ordered.length, earlierUpdate };
}
