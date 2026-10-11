import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { RefreshCw, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { ApiError, type Company } from '../lib/api';
import { readStores } from '../lib/stores-api';
import { readConversations, readConversation } from '../lib/conversations-api';
import { cn } from '../lib/utils';
import { ErrorNotice } from '../components/identity-shared';
import { ConversationAside, ConversationHeader, MessageEmpty, MessageTimeline } from '../components/message-thread';
import { ConversationControlPanel } from '../components/conversation-control-panel';
import { ReplyTestPanel } from '../components/reply-test-panel';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Field, FieldGroup, FieldLabel } from '../components/ui/field';
import { NativeSelect, NativeSelectOption } from '../components/ui/native-select';
import { Spinner } from '../components/ui/spinner';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import { clearPendingReplies } from '../lib/conversation-reply-pending';
import { clearPendingPreviews } from '../lib/conversation-preview-pending';
import { clearAiResumptions } from '../lib/ai-reception-pending';
import { clearReplyDrafts } from '../lib/conversation-draft';
import { clearConversationPositions } from '../lib/conversation-position';
import { useConversationMessages } from '../hooks/use-conversation-messages';

import { useCompanySettings } from '../components/company-settings-provider';

const queues = [{ value: 'all', label: '全部', aria: '全部会话' }, { value: 'mine', label: '我负责', aria: '我负责' }, { value: 'unassigned', label: '未分配', aria: '未分配' }] as const;
const states = [{ value: 'all', label: '全部状态' }, { value: 'needs_reply', label: '待回复' }, { value: 'waiting_customer', label: '等待消费者' }, { value: 'waiting_internal', label: '等待内部' }, { value: 'resolved', label: '已解决' }] as const;

function Reading({ text }: { text: string }) {
  return <p role="status" className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground"><Spinner aria-hidden="true" />{text}</p>;
}

export function MessagesPage({ company, userId, refresh }: { company: Company; userId: string; refresh: (notice?: unknown) => Promise<void> }) {
  const { date: messageDate } = useCompanySettings();
  const [params, setParams] = useSearchParams();
  const selected = params.get('conversation') ?? '';
  const storeId = params.get('store') ?? '';
  const search = params.get('search') ?? '';
  const searchField = params.get('field') === 'order' ? 'order' : 'thread';
  const queue = queues.find(item => item.value === params.get('queue'))?.value ?? 'all';
  const state = states.find(item => item.value === params.get('state'))?.value ?? 'all';
  const listScope = JSON.stringify([company.id, storeId, searchField, search, queue, state]);
  const [draft, setDraft] = useState(search);
  const [draftField, setDraftField] = useState<'thread' | 'order'>(searchField);
  const [pagination, setPagination] = useState<{ scope: string; pages: string[] }>({ scope: '', pages: [] });
  const listPages = pagination.scope === listScope ? pagination.pages : [];
  function setListPages(value: string[] | ((pages: string[]) => string[])) {
    setPagination(current => ({ scope: listScope, pages: typeof value === 'function' ? value(current.scope === listScope ? current.pages : []) : value }));
  }
  const [revision, setRevision] = useState(0);
  const [controlDenied, setControlDenied] = useState<ApiError | null>(null);
  const clearing = useRef(false);
  const returnFocus = useRef<string | null>(null);
  const cursor = listPages.at(-1);
  // Each visible page is bounded. Old pages leave the cache when no longer used.
  const stores = useInfiniteQuery({
    queryKey: ['message-stores', company.id], initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => readStores(company.id, pageParam, signal),
    getNextPageParam: page => page.nextOffset ?? undefined, gcTime: 0, retry: false,
    refetchInterval: 10_000,
  });
  const conversations = useQuery({
    queryKey: ['conversations', company.id, storeId, searchField, search, queue, state, cursor, revision],
    queryFn: ({ signal }) => readConversations(company.id, { ...(storeId ? { storeId } : {}), ...(search ? { searchField, search } : {}), queue, state, cursor, limit: 50 }, signal),
    gcTime: 0, retry: false, refetchInterval: 10_000,
  });
  const detail = useQuery({
    queryKey: ['conversation', company.id, selected, revision],
    queryFn: ({ signal }) => readConversation(company.id, selected, signal), enabled: !!selected,
    gcTime: 0, retry: false, refetchInterval: 10_000,
  });
  const history = useConversationMessages(userId, company.id, selected);
  const denied = [stores.error, conversations.error, detail.error, history.error, controlDenied].find(error => error instanceof ApiError && ['NOT_FOUND', 'UNAUTHENTICATED', 'FORBIDDEN'].includes(error.code));
  useEffect(() => {
    if (!denied || clearing.current) return;
    clearing.current = true;
    try { clearPendingReplies(window.sessionStorage, { userId, companyId: company.id, ...(selected ? { conversationId: selected } : {}) }); clearPendingPreviews(window.sessionStorage, { userId, companyId: company.id, ...(selected ? { conversationId: selected } : {}) }); clearAiResumptions(window.sessionStorage, { userId, companyId: company.id, ...(selected ? { conversationId: selected } : {}) }); clearReplyDrafts(window.sessionStorage, { userId, companyId: company.id, ...(selected ? { conversationId: selected } : {}) }); clearConversationPositions(window.sessionStorage, { userId, companyId: company.id, ...(selected ? { conversationId: selected } : {}) }); } catch { /* Never expose drafts when access cannot be confirmed. */ }
    setParams({}, { replace: true });
    void refresh(denied);
  }, [denied, refresh, setParams, userId, company.id, selected]);
  useEffect(() => { setDraft(search); setDraftField(searchField); }, [search, searchField]);
  // List pagination is scoped during render, before a changed filter can start a request.
  useEffect(() => {
    if (!selected && returnFocus.current) {
      (document.getElementById(`conversation-${returnFocus.current}`) ?? document.getElementById('message-search'))?.focus();
      returnFocus.current = null;
    }
  }, [selected]);
  function choose(id: string) {
    if (!id) returnFocus.current = selected;
    const next = new URLSearchParams(window.location.search);
    if (id) next.set('conversation', id); else next.delete('conversation');
    setParams(next);
  }
  function changeFilter(changes: Partial<Record<'store' | 'field' | 'search' | 'queue' | 'state', string>>) {
    setListPages([]);
    // BrowserRouter updates history before a transition renders. Preserve the latest filters, not an old handler's closure.
    const next = new URLSearchParams(window.location.search);
    next.delete('conversation');
    for (const [key, value] of Object.entries(changes)) {
      if (!value || (key === 'queue' || key === 'state') && value === 'all') next.delete(key);
      else next.set(key, value);
    }
    if (!next.get('search')) next.delete('field');
    setParams(next);
  }
  function reload() { setListPages([]); setRevision(value => value + 1); if (selected) history.refresh(); }
  if (denied) return <ErrorNotice error={denied} />;
  const conversationPage = conversations.isError ? undefined : conversations.data;
  const conversation = !detail.isError ? detail.data?.conversation : undefined;
  const messages = !history.error ? history.messages : [];
  const conversationError = detail.error ?? history.error;
  const loading = detail.isPending || history.isPending;
  const refreshing = conversations.isFetching || (!!selected && (detail.isFetching || history.isFetching));
  const availableStores = stores.isError ? [] : stores.data?.pages.flatMap(page => page.stores) ?? [];

  return <>
    <div className="flex shrink-0 items-center justify-between gap-3">
      <div className="min-w-0"><h1 className="text-xl font-semibold tracking-tight sm:text-2xl">消息中心</h1><p className="mt-1 hidden text-sm text-muted-foreground sm:block">查看消费者会话，认领并跟进处理进度。</p></div>
      <Button variant="outline" disabled={refreshing} onClick={reload}><RefreshCw data-icon="inline-start" />刷新消息</Button>
    </div>
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border">
      <aside aria-label="会话列表" className={cn('w-full shrink-0 flex-col border-r md:flex md:w-72', selected ? 'hidden' : 'flex')}>
        <form className="shrink-0 p-4" onSubmit={event => { event.preventDefault(); changeFilter({ field: draftField, search: draft.trim() }); }}>
          <FieldGroup className="gap-3">
            <Field><FieldLabel className="sr-only">会话队列</FieldLabel><ToggleGroup aria-label="会话队列" variant="outline" size="sm" spacing={0} className="w-full" value={[queue]} onValueChange={values => {
              const next = queues.find(item => item.value === values[0]);
              if (next) changeFilter({ queue: next.value });
            }}>
              {queues.map(item => <ToggleGroupItem key={item.value} value={item.value} aria-label={item.aria} className="h-auto min-w-0 flex-1 flex-col py-2"><span>{item.label}</span><span className="max-w-full truncate text-xs text-muted-foreground" title={String(conversationPage?.counts[item.value] ?? '')}>{conversationPage?.counts[item.value] ?? '—'}</span></ToggleGroupItem>)}
            </ToggleGroup></Field>
            <Field><FieldLabel htmlFor="message-state" className="sr-only">筛选处理状态</FieldLabel><NativeSelect id="message-state" className="w-full" value={state} onChange={event => {
              const next = states.find(item => item.value === event.target.value);
              if (next) changeFilter({ state: next.value });
            }}>{states.map(item => <NativeSelectOption key={item.value} value={item.value}>{item.label}</NativeSelectOption>)}</NativeSelect></Field>
            <Field><FieldLabel htmlFor="message-store" className="sr-only">筛选店铺</FieldLabel><NativeSelect id="message-store" className="w-full" value={storeId} onChange={event => changeFilter({ store: event.target.value })}>
              <NativeSelectOption value="">全部授权店铺</NativeSelectOption>
              {storeId && !availableStores.some(store => store.id === storeId) && <NativeSelectOption value={storeId}>当前筛选店铺</NativeSelectOption>}
              {availableStores.map(store => <NativeSelectOption key={store.id} value={store.id}>{store.name}</NativeSelectOption>)}
            </NativeSelect></Field>
            {stores.hasNextPage && <Button type="button" variant="ghost" size="sm" disabled={stores.isFetchingNextPage} onClick={() => void stores.fetchNextPage()}>加载更多店铺</Button>}
            <Field><FieldLabel htmlFor="message-search-field" className="sr-only">查找方式</FieldLabel><NativeSelect id="message-search-field" className="w-full" value={draftField} onChange={event => setDraftField(event.target.value as 'thread' | 'order')}><NativeSelectOption value="thread">平台会话 ID</NativeSelectOption><NativeSelectOption value="order">订单号</NativeSelectOption></NativeSelect></Field>
            <Field><FieldLabel htmlFor="message-search" className="sr-only">精确标识</FieldLabel><div className="flex gap-2"><Input id="message-search" autoComplete="off" placeholder="输入完整标识" maxLength={256} value={draft} onChange={event => setDraft(event.target.value)} /><Button type="submit" variant="outline" size="icon" aria-label="查找"><Search /></Button></div></Field>
          </FieldGroup>
          {search && <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => changeFilter({ search: '' })}>清除搜索</Button>}
          <p className="mt-3 text-xs text-muted-foreground">计数按当前店铺、搜索和状态统计 · 仅精确匹配</p>
        </form>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2" tabIndex={0} aria-label="会话条目">
          {conversations.isPending ? <Reading text="正在读取会话…" /> : conversations.isError ? <div className="p-2"><ErrorNotice error={conversations.error} />{conversations.error instanceof ApiError && conversations.error.code === 'INVALID_REQUEST' && <Button variant="outline" className="mt-3" onClick={reload}>返回第一页会话</Button>}</div> : !conversations.data?.conversations.length ? <MessageEmpty title={storeId || search || queue !== 'all' || state !== 'all' ? '没有匹配的会话' : '暂无已导入会话'} description={storeId || search || queue !== 'all' || state !== 'all' ? '检查标识，或更换队列、状态与店铺筛选。' : '在店铺管理启用会话同步后，已导入的记录会显示在这里。'} /> : conversations.data.conversations.map(item => <Button key={item.id} id={`conversation-${item.id}`} variant={selected === item.id ? 'secondary' : 'ghost'} aria-current={selected === item.id ? 'true' : undefined} aria-label={`打开会话 ${item.platformThreadId}`} className="h-auto w-full shrink-0 justify-start px-3 py-4 text-left" onClick={() => choose(item.id)}><div className="flex min-w-0 flex-1 flex-col gap-2"><span className="truncate font-medium">会话 {item.platformThreadId}</span><span className="truncate text-xs text-muted-foreground">{item.store.name}</span><span className="flex flex-wrap items-center gap-1"><Badge variant="outline">{states.find(value => value.value === (item.workflow.lifecycle === 'resolved' ? 'resolved' : item.workflow.workStatus))?.label}</Badge>{item.workflow.assignedMemberId === conversationPage?.viewerMemberId && <Badge variant="secondary">我负责</Badge>}</span><span className="break-words whitespace-normal text-xs text-muted-foreground [overflow-wrap:anywhere]">{item.workflow.assignedMemberId === null ? '未分配' : item.workflow.assigneeName === null ? '负责人已移除' : `负责人：${item.workflow.assigneeName.trim() || '未填写姓名'}`}</span><span className="line-clamp-2 whitespace-normal break-words font-normal [overflow-wrap:anywhere]">{item.latestMessage ? item.latestMessage.isImage ? '图片消息' : item.latestMessage.content.join(' ') + (item.latestMessage.previewTruncated ? '…' : '') : '尚无已导入消息'}</span><span className="text-xs font-normal text-muted-foreground">{messageDate(item.lastMessageAt)}</span></div></Button>)}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t p-3"><Button variant="ghost" size="icon-sm" aria-label="上一页会话" disabled={!listPages.length || conversations.isFetching} onClick={() => setListPages(pages => pages.slice(0, -1))}><ChevronLeft /></Button><span className="text-xs text-muted-foreground">第 {listPages.length + 1} 页</span><Button variant="ghost" size="icon-sm" aria-label="下一页会话" disabled={!conversations.data?.nextCursor || conversations.isFetching} onClick={() => setListPages(pages => [...pages, conversations.data!.nextCursor!])}><ChevronRight /></Button></div>
      </aside>
      <section aria-label="会话内容" className={cn('min-h-0 min-w-0 flex-1 flex-col md:flex', selected ? 'flex' : 'hidden')}>
        {!selected ? <MessageEmpty title="选择一个会话" description="从左侧选择会话，查看平台原文和同步范围。" /> : conversationError ? <div className="p-4"><ErrorNotice error={conversationError} /><Button variant="outline" className="mt-3" onClick={() => choose('')}>返回会话列表</Button></div> : <>
          {conversation && <ConversationHeader key={selected} companyId={company.id} viewerMemberId={conversationPage?.viewerMemberId} onDenied={setControlDenied} conversation={conversation} messages={messages} back={() => choose('')} />}
          {!conversation && loading && <Reading text="正在读取会话…" />}
          {conversation && <ConversationControlPanel key={`${company.id}:${selected}`} userId={userId} companyId={company.id} conversationId={selected}
            conversationLabel={`${conversation.store.name} · 会话 ${conversation.platformThreadId}`} onDenied={setControlDenied}>
          <div className="flex min-h-0 flex-1">{loading ? <Reading text="正在读取消息…" /> : <MessageTimeline messages={messages} pageKey={history.pageKey} earlier={history.earlier} anchorId={history.anchorId} view={history.view} onPosition={history.position} />}</div>
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-t px-3 py-1.5" aria-label="消息导航">
            {['owner','admin'].includes(company.role)&&conversationPage?.viewerMemberId&&<ReplyTestPanel key={`${company.id}:${conversationPage.viewerMemberId}:${selected}`} scope={{userId,companyId:company.id,memberId:conversationPage.viewerMemberId,conversationId:selected}} storeId={conversation.store.id}
              message={!loading&&!history.earlier&&!history.hasNew&&!history.catchingUp?messages.at(-1)??null:null} onDenied={setControlDenied} />}
            <Button variant="ghost" size="sm" disabled={!history.hasOlder || history.navigating} onClick={history.older}>查看更早消息</Button>
            <Button variant="ghost" size="sm" disabled={!history.hasNewer || history.navigating} onClick={history.newer}>返回较新消息</Button>
            {history.hasEarlierUpdate && <Button variant="outline" size="sm" disabled={history.navigating} onClick={history.earlierUpdate}>查看较早更新</Button>}
            {history.hasNew ? <Button size="sm" disabled={history.navigating} onClick={history.showLatest}>显示新消息</Button> : history.earlier && <Button variant="outline" size="sm" disabled={history.navigating} onClick={history.showLatest}>回到最新消息</Button>}
            {history.catchingUp && !history.earlier && <span role="status" className="text-xs text-muted-foreground">正在补读新消息…</span>}
            {history.positionWarning && <p role="status" className="w-full text-xs text-muted-foreground">阅读位置恢复不可用；当前消息仍可查看，请勿依赖刷新后恢复位置。</p>}
          </div>
          </ConversationControlPanel>}
        </>}
      </section>
      {conversation && !conversationError && <ConversationAside key={selected} companyId={company.id} viewerMemberId={conversationPage?.viewerMemberId} onDenied={setControlDenied} conversation={conversation} messages={messages} />}
    </div>
    {(stores.isError || conversations.isError) && <Alert><AlertDescription>读取未完成，已隐藏不可确认的数据。请检查网络并刷新消息。</AlertDescription></Alert>}
    {!availableStores.length && !stores.isPending && !stores.isError && <p className="shrink-0 text-xs text-muted-foreground">尚无可访问店铺。<Link to="/workspace/stores" className="underline underline-offset-4">前往店铺管理</Link></p>}
  </>;
}
