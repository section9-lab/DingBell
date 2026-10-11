import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../lib/api';
import { readConversationMessages, readConversationMessageUpdates, type ConversationPageOptions } from '../lib/conversations-api';
import { applyMessageUpdates, startMessageWindow, type MessagePage, type MessageUpdates, type MessageWindow } from '../lib/conversation-message-window';
import { readConversationPosition, saveConversationPosition } from '../lib/conversation-position';

type Pending = { cursor: string; batch: MessageUpdates };
type Navigation = { id: number; options: ConversationPageOptions; live: boolean; clearEarlier?: boolean };
interface Reading {
  scope: string; live: MessageWindow; history: MessagePage | null; anchorId: string | null; following: boolean;
  pending: Pending | null; catchingUp: boolean; view: number; navigation: Navigation | null; positionWarning: boolean;
}
function storage() { try { return window.sessionStorage; } catch { return null; } }

export function useConversationMessages(userId: string, companyId: string, conversationId: string) {
  const scope = JSON.stringify([userId, companyId, conversationId]);
  const [saved, setSaved] = useState<Reading | null>(null);
  const [readVersion, setReadVersion] = useState(0);
  const invalidRecovered = useRef('');
  const current = saved?.scope === scope ? saved : null;
  const state = useRef(current); state.current = current;
  const navigationId = useRef(0);
  const commit = useCallback((change: (value: Reading) => Reading) => {
    const value = state.current; if (!value || value.scope !== scope) return;
    let next = change(value); if (next === value) return;
    const persisted = saveConversationPosition(storage(), { userId, companyId, conversationId, memberId: next.live.viewerMemberId }, {
      historyCursor: next.live.historyCursor, pageCursor: next.history?.pageCursor ?? null, anchorId: next.anchorId, earlierUpdate: next.live.earlierUpdate,
    });
    if (!persisted) next = { ...next, positionWarning: true };
    state.current = next; setSaved(next);
  }, [scope, userId, companyId, conversationId]);
  const bootstrap = useQuery({
    queryKey: ['message-position', scope, readVersion], enabled: !!conversationId && !current, gcTime: 0, retry: false,
    refetchOnWindowFocus: false, refetchOnReconnect: false, staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const fresh = await readConversationMessages(companyId, conversationId, { limit: 50 }, signal);
      const stored = readConversationPosition(storage(), { userId, companyId, conversationId, memberId: fresh.viewerMemberId });
      let live = startMessageWindow(fresh), history: MessagePage | null = null, anchorId: string | null = null, positionWarning = stored.state === 'unavailable';
      if (stored.state === 'saved') {
        try {
          const position = stored.position;
          live = { ...startMessageWindow(await readConversationMessages(companyId, conversationId, { cursor: position.historyCursor, limit: 50 }, signal)), earlierUpdate: position.earlierUpdate };
          if (position.pageCursor) history = await readConversationMessages(companyId, conversationId, { cursor: position.pageCursor, limit: 50 }, signal);
          else if (position.anchorId) history = await readConversationMessages(companyId, conversationId, { cursor: position.historyCursor, anchorId: position.anchorId, direction: 'from', limit: 50 }, signal);
          anchorId = position.anchorId;
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'INVALID_REQUEST') throw error;
          // An old format/boundary must trigger a fresh authorized read, never an earlier cached body.
          live = startMessageWindow(await readConversationMessages(companyId, conversationId, { limit: 50 }, signal));
          history = null; anchorId = null; positionWarning = true;
        }
      }
      return { scope, live, history, anchorId, following: !history && !anchorId, pending: null, catchingUp: false, view: 0, navigation: null, positionWarning } satisfies Reading;
    },
  });
  useEffect(() => {
    if (state.current || !bootstrap.data || bootstrap.isError || bootstrap.data.scope !== scope) return;
    state.current = bootstrap.data; commit(value => ({ ...value }));
  }, [bootstrap.data, bootstrap.isError, scope, commit]);

  // One owned polling key, one pending page. Changing the applied cursor must not launch an unbounded request loop.
  const updates = useQuery({
    queryKey: ['message-updates', scope, readVersion, current?.live.viewerMemberId], enabled: !!current && !current.navigation,
    queryFn: async ({ signal }) => {
      const cursor = state.current!.live.updatesCursor;
      return { cursor, batch: await readConversationMessageUpdates(companyId, conversationId, { cursor, limit: 50 }, signal) };
    },
    gcTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
    refetchInterval: current?.catchingUp && current.following && !current.history ? 1_000 : 5_000, refetchIntervalInBackground: false,
  });
  useEffect(() => {
    const result = updates.data; if (!result || updates.isError) return;
    commit(value => {
      if (value.navigation || result.cursor !== value.live.updatesCursor || result.batch.viewerMemberId !== value.live.viewerMemberId) return value;
      invalidRecovered.current = '';
      if (result.batch.messages.length && (value.history || !value.following)) return { ...value, pending: result };
      const live = applyMessageUpdates(value.live, result.cursor, result.batch);
      return live === value.live && !value.pending ? value : { ...value, live, pending: null, catchingUp: result.batch.hasMore };
    });
  }, [updates.data, updates.dataUpdatedAt, updates.isError, commit]);

  const navigation = current?.navigation;
  const page = useQuery({
    queryKey: ['message-navigation', scope, navigation?.id], enabled: !!navigation, gcTime: 0, retry: false,
    refetchOnWindowFocus: false, refetchOnReconnect: false,
    queryFn: async ({ signal }) => ({ id: navigation!.id, page: await readConversationMessages(companyId, conversationId, { ...navigation!.options, limit: 50 }, signal) }),
  });
  useEffect(() => {
    const result = page.data; if (!result || page.isError) return;
    commit(value => {
      const nav = value.navigation; if (!nav || nav.id !== result.id || result.page.viewerMemberId !== value.live.viewerMemberId) return value;
      const live = nav.live ? { ...startMessageWindow(result.page), earlierUpdate: value.live.earlierUpdate } : value.live;
      return { ...value, live: nav.clearEarlier ? { ...live, earlierUpdate: null } : live, history: nav.live ? null : result.page,
        anchorId: nav.options.direction === 'from' ? nav.options.anchorId! : null, following: nav.live, view: value.view + 1, navigation: null,
        pending: nav.live ? null : value.pending };
    });
  }, [page.data, page.isError, commit]);
  useEffect(() => {
    const error = page.error ?? updates.error;
    if (!current || !(error instanceof ApiError) || error.code !== 'INVALID_REQUEST' || invalidRecovered.current === scope) return;
    // Membership replacement invalidates old cursors. Reconfirm identity and load only the new member's position.
    // A persistently invalid server response stays visible instead of creating a reset/request loop.
    invalidRecovered.current = scope; state.current = null; setSaved(null); setReadVersion(value => value + 1);
  }, [page.error, updates.error, current, scope]);
  function navigate(options: ConversationPageOptions, live = false, clearEarlier = false) {
    commit(value => ({ ...value, following: false, navigation: { id: ++navigationId.current, options, live, clearEarlier } }));
  }
  function showLatest() {
    commit(value => ({ ...value, live: value.pending ? applyMessageUpdates(value.live, value.pending.cursor, value.pending.batch) : value.live,
      history: null, anchorId: null, following: true, pending: null, catchingUp: value.pending?.batch.hasMore ?? value.catchingUp, navigation: null, view: value.view + 1 }));
    void updates.refetch();
  }
  const position = useCallback((view: number, atEnd: boolean, anchorId: string | null) => {
    commit(value => {
      if (value.view !== view || value.navigation) return value;
      const anchor = value.history || !atEnd ? anchorId : null, following = !value.history && atEnd;
      if (following && value.pending) return { ...value, live: applyMessageUpdates(value.live, value.pending.cursor, value.pending.batch), anchorId: null, following, pending: null, catchingUp: value.pending.batch.hasMore };
      return anchor === value.anchorId && following === value.following ? value : { ...value, anchorId: anchor, following };
    });
  }, [commit]);
  return {
    messages: current?.history?.messages ?? current?.live.messages ?? [], earlier: !!current?.history,
    pageKey: `${scope}:${current?.view ?? 0}`, view: current?.view ?? 0, anchorId: current?.anchorId ?? null, position,
    isPending: !current, isFetching: bootstrap.isFetching || updates.isFetching || page.isFetching,
    error: bootstrap.error ?? page.error ?? updates.error, positionWarning: current?.positionWarning ?? false,
    hasNew: !!current?.pending?.batch.messages.length, hasEarlierUpdate: !!current?.live.earlierUpdate, catchingUp: current?.catchingUp ?? false,
    hasOlder: current?.history ? !!current.history.nextCursor : !!current?.live.hasOlder, hasNewer: !!current?.history,
    navigating: !!navigation, showLatest,
    older() { if (!current) return; if (current.history?.nextCursor) navigate({ cursor: current.history.nextCursor }); else if (!current.history && current.live.messages[0]) navigate({ cursor: current.live.historyCursor, anchorId: current.live.messages[0].id, direction: 'older' }); },
    newer() { if (current?.history?.newerCursor) navigate({ cursor: current.history.newerCursor }); else showLatest(); },
    earlierUpdate() { if (current?.live.earlierUpdate) navigate({ cursor: current.live.historyCursor, anchorId: current.live.earlierUpdate.id, direction: 'from' }, false, true); },
    refresh() { if (!current) { void bootstrap.refetch(); } else if (navigation) { void page.refetch(); } else navigate({ cursor: current.live.historyCursor }, true); },
  };
}
