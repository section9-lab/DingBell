import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../lib/api';
import { readConversationMessages, readConversationMessageUpdates } from '../lib/conversations-api';
import {
  refreshMessageWindowMetadata, applyMessageUpdates, startMessageWindow, compareMessages,
  type MessageWindow, type MessagePage,
} from '../lib/conversation-message-window';

interface Reading { scope: string; live: MessageWindow }
const PAGE_LIMIT = 100;

/** Conversations are short, so the view reads every history page instead of exposing pagination. */
async function readWholeConversation(companyId: string, conversationId: string, signal: AbortSignal): Promise<MessagePage> {
  const latest = await readConversationMessages(companyId, conversationId, { limit: PAGE_LIMIT }, signal);
  const records = new Map(latest.messages.map(message => [message.id, message])), seen = new Set<string>();
  let cursor = latest.nextCursor;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const page = await readConversationMessages(companyId, conversationId, { cursor, limit: PAGE_LIMIT }, signal);
    for (const message of page.messages) records.set(message.id, message);
    cursor = page.nextCursor;
  }
  // A repeated cursor would mean a server-side loop; stop rather than refetch it forever.
  return { ...latest, messages: [...records.values()].sort(compareMessages), nextCursor: null };
}

/**
 * The conversation view holds every message plus every later update, applied as it arrives.
 * There is no pagination and no saved position to restore.
 */
export function useConversationMessages(userId: string, companyId: string, conversationId: string) {
  const scope = JSON.stringify([userId, companyId, conversationId]);
  const [saved, setSaved] = useState<Reading | null>(null);
  const [readVersion, setReadVersion] = useState(0);
  const invalidRecovered = useRef('');
  const statusDirty = useRef(false);
  const current = saved?.scope === scope ? saved : null;
  const state = useRef(current); state.current = current;
  const commit = useCallback((change: (value: Reading) => Reading) => {
    const value = state.current; if (!value || value.scope !== scope) return;
    const next = change(value); if (next === value) return;
    state.current = next; setSaved(next);
  }, [scope]);
  const bootstrap = useQuery({
    queryKey: ['message-window', scope, readVersion], enabled: !!conversationId && !current, gcTime: 0,
    refetchOnWindowFocus: false, refetchOnReconnect: false, staleTime: Infinity,
    queryFn: async ({ signal }): Promise<Reading> => ({ scope, live: startMessageWindow(await readWholeConversation(companyId, conversationId, signal)) }),
  });
  useEffect(() => {
    if (state.current || !bootstrap.data || bootstrap.isError || bootstrap.data.scope !== scope) return;
    state.current = bootstrap.data; commit(value => ({ ...value }));
  }, [bootstrap.data, bootstrap.isError, scope, commit]);

  // SSE invalidates this owned key. Retries are bounded; the stream is never replaced by polling.
  const updates = useQuery({
    queryKey: ['message-updates', scope, readVersion, current?.live.viewerMemberId], enabled: !!current,
    queryFn: async ({ signal }) => {
      const cursor = state.current!.live.updatesCursor;
      return { cursor, batch: await readConversationMessageUpdates(companyId, conversationId, { cursor, limit: 50 }, signal) };
    },
    gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
    refetchInterval: query => {
      if (query.state.status === 'error') {
        const error = query.state.error, terminal = error instanceof ApiError && ['NOT_FOUND', 'UNAUTHENTICATED', 'FORBIDDEN', 'INVALID_REQUEST', 'INVALID_RESPONSE'].includes(error.code);
        return !terminal && query.state.errorUpdateCount < 4 ? Math.min(5000, 1000 * 2 ** Math.max(0, query.state.errorUpdateCount - 1)) : false;
      }
      return false;
    }, refetchIntervalInBackground: false,
  });
  const status = useQuery({
    queryKey: ['message-status', scope, readVersion], enabled: false, gcTime: 0,
    queryFn: async ({ signal }) => {
      const reading = state.current; if (!reading) return null;
      const first = reading.live.messages[0];
      const page = await readConversationMessages(companyId, conversationId, { cursor: reading.live.historyCursor, limit: 100, ...(first ? { anchorId: first.id, direction: 'from' as const } : {}) }, signal);
      if (page.viewerMemberId !== reading.live.viewerMemberId) throw new ApiError('INVALID_REQUEST');
      return { scope: reading.scope, page };
    },
  });
  useEffect(() => {
    const refresh = () => { if (statusDirty.current && state.current) void status.refetch(); };
    const changed = (event: Event) => { if ((event as CustomEvent<{ companyId: string }>).detail?.companyId !== companyId) return; statusDirty.current = true; refresh(); };
    window.addEventListener('dingbell:message-status', changed); window.addEventListener('online', refresh);
    return () => { window.removeEventListener('dingbell:message-status', changed); window.removeEventListener('online', refresh); };
  }, [companyId, scope, status.refetch]);
  useEffect(() => {
    const result = status.data; if (!result || status.isError || result.scope !== scope) return;
    statusDirty.current = false;
    commit(value => ({ ...value, live: refreshMessageWindowMetadata(value.live, result.page) }));
  }, [status.data, status.dataUpdatedAt, status.isError, scope, commit]);
  useEffect(() => {
    const result = updates.data; if (!result || updates.isError) return;
    commit(value => {
      if (result.cursor !== value.live.updatesCursor || result.batch.viewerMemberId !== value.live.viewerMemberId) return value;
      invalidRecovered.current = '';
      const live = applyMessageUpdates(value.live, result.cursor, result.batch);
      return live === value.live ? value : { ...value, live };
    });
  }, [updates.data, updates.dataUpdatedAt, updates.isError, commit]);
  useEffect(() => {
    const error = updates.error ?? status.error;
    if (!current || !(error instanceof ApiError) || error.code !== 'INVALID_REQUEST' || invalidRecovered.current === scope) return;
    // Membership replacement invalidates old cursors. Reconfirm identity and load only the new member's window.
    invalidRecovered.current = scope; state.current = null; setSaved(null); setReadVersion(value => value + 1);
  }, [updates.error, status.error, current, scope]);
  function refresh() {
    if (!current) void bootstrap.refetch(); else void updates.refetch();
  }
  return {
    messages: current?.live.messages ?? [], pageKey: scope,
    isPending: !current, isFetching: bootstrap.isFetching || updates.isFetching || status.isFetching,
    error: bootstrap.error ?? updates.error ?? status.error, refresh,
  };
}
