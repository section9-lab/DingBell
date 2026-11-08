import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../lib/api';
import { readConversationControl, sendConversationCommand, type ConversationCommand, type ConversationControlState } from '../lib/conversation-control-api';
import { ErrorNotice } from './identity-shared';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';
import { cn } from '../lib/utils';
import { ConversationReplyComposer, type ReplySubmission } from './conversation-reply-composer';
import { AiReceptionControl } from './ai-reception-control';
import { AiLoopActivity } from './ai-loop-activity';

type ControlResponse = Awaited<ReturnType<typeof readConversationControl>>;
const denied = (error: unknown): error is ApiError => error instanceof ApiError && ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND'].includes(error.code);

/** 取消 AI 托管（或开始人工回复）：未分配时认领，已分配时接管。 */
function humanCommand(state: ConversationControlState): ConversationCommand {
  return { commandId: crypto.randomUUID(), expectedVersion: state.version, action: state.assignedMemberId === null ? 'claim' : 'takeover' };
}
function hostingText(state: ConversationControlState | undefined) {
  if (!state) return { label: '正在读取托管状态', description: '', tone: 'idle' as const };
  if (state.lifecycle === 'resolved') return { label: '会话已解决', description: '已解决的会话不能继续回复。', tone: 'idle' as const };
  if (state.reception === 'ai') return { label: 'AI 托管中', description: 'AI 会按回复策略起草回复，经人工确认后发送给消费者。', tone: 'ai' as const };
  if (state.reception === 'human') return { label: '人工回复中', description: '当前由你人工回复；开启 AI 托管后，AI 只处理此后的新消息。', tone: 'human' as const };
  return { label: '未接管', description: '会话尚未接管，暂不能发送。开始人工回复后可认领并发送，也可以交给 AI 托管。', tone: 'paused' as const };
}

export function ConversationControlPanel({ userId, companyId, conversationId, storeId, children, onDenied }: {
  userId: string; companyId: string; conversationId: string; storeId?: string; children: ReactNode; onDenied: (error: ApiError) => void;
}) {
  const cache = useQueryClient();
  const queryKey = ['conversation-control', companyId, conversationId];
  const [pending, setPending] = useState(false);
  const [locked, setLocked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useRef(false), active = useRef(true), reported = useRef(false);
  const control = useQuery({
    queryKey, queryFn: ({ signal }) => readConversationControl(companyId, conversationId, signal),
    enabled: !pending && !locked, gcTime: 0, refetchInterval: 10_000,
  });
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (denied(control.error) && !reported.current) { reported.current = true; onDenied(control.error); }
  }, [control.error, onDenied]);

  async function reread() {
    const result = await control.refetch();
    if (!active.current) return false;
    if (denied(result.error)) { reported.current = true; onDenied(result.error); }
    const confirmed = !result.isError && !!result.data;
    setLocked(!confirmed);
    return confirmed;
  }
  async function submit(command: ConversationCommand, expectedMemberId?: string): Promise<ReplySubmission | undefined> {
    if (busy.current || locked) return;
    busy.current = true; setPending(true); setNotice(null);
    // An in-flight read must not replace the newly accepted state with its older snapshot.
    await cache.cancelQueries({ queryKey, exact: true });
    if (!active.current) return;
    try {
      const result = await sendConversationCommand(companyId, conversationId, command, expectedMemberId);
      if (!active.current) return;
      cache.setQueryData<ControlResponse>(queryKey, current => current && current.control.state.version > result.control.state.version ? current : {
        companyId, conversationId, control: result.control,
      });
      void cache.invalidateQueries({ queryKey: ['conversations', companyId] });
      void cache.invalidateQueries({ queryKey: ['conversation-replies', companyId, conversationId] });
      if (command.action !== 'send_reply') setNotice(command.action === 'claim' ? '已认领会话，现在由你回复消费者。'
        : command.action === 'takeover' ? '已接管会话，现在由你回复消费者。' : '处理状态已保存。');
      return { outcome: 'accepted', receipt: result.receipt };
    } catch (error) {
      if (!active.current) return;
      setLocked(true);
      if (denied(error)) { reported.current = true; onDenied(error); return; }
      const confirmed = await reread();
      if (!active.current) return;
      const uncertain = !(error instanceof ApiError) || error.code === 'OPERATION_UNCONFIRMED';
      if (command.action !== 'send_reply') setNotice(uncertain
        ? confirmed ? '提交结果尚未确认，已重新读取会话状态。请核对后再操作。' : '提交结果尚未确认，暂时无法读取最新状态。请刷新后重试。'
        : `${error.message}${confirmed ? ' 已读取最新会话状态。' : ' 请刷新会话状态后再操作。'}`);
      return { outcome: uncertain ? 'unconfirmed' : 'rejected', ...(error instanceof ApiError ? { code: error.code } : {}) };
    } finally {
      if (active.current) { busy.current = false; setPending(false); }
    }
  }

  const view = control.isError ? undefined : control.data?.control;
  const state = view?.state;
  const exhausted = !!state && [state.version, state.controlEpoch, state.sequence].some(value => value >= Number.MAX_SAFE_INTEGER);
  const disabled = pending || locked || control.isFetching || !view || exhausted;
  const hosting = hostingText(state);

  return <>
    <div role="region" aria-label="AI 托管" className="shrink-0 border-b bg-background px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full',
            hosting.tone === 'ai' ? 'bg-emerald-500' : hosting.tone === 'human' ? 'bg-foreground' : 'bg-muted-foreground/40')} />
          <span className="text-sm font-medium">{hosting.label}</span>
          {state?.lifecycle === 'resolved' && <Badge variant="secondary">只读</Badge>}
          {control.isPending && <Spinner aria-hidden="true" />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {state?.lifecycle === 'open' && state.reception === 'ai' && <Button size="sm" variant="outline" disabled={disabled}
            onClick={() => void submit(humanCommand(state))}>{pending && <Spinner aria-hidden="true" />}取消 AI 托管</Button>}
          {state?.lifecycle === 'open' && state.reception === 'paused' && <Button size="sm" disabled={disabled}
            onClick={() => void submit(humanCommand(state))}>{pending && <Spinner aria-hidden="true" />}开始人工回复</Button>}
          {state?.lifecycle === 'open' &&
            <AiReceptionControl key={`${userId}:${view!.viewerMemberId}`} scope={{ userId, memberId: view!.viewerMemberId, companyId, conversationId }}
              view={view!} disabled={disabled} onChanged={reread} onDenied={onDenied} />}
        </div>
      </div>
      {state?.reception === 'ai' && view
        ? <AiLoopActivity key={`${companyId}:${conversationId}:${view.viewerMemberId}`} companyId={companyId} conversationId={conversationId} memberId={view.viewerMemberId} />
        : !!hosting.description && <p className="mt-1 text-xs text-muted-foreground">{hosting.description}</p>}
      {!!notice && <p role="status" className="mt-1 text-xs text-muted-foreground">{notice}</p>}
      {control.isError && <div className="mt-2 flex flex-wrap items-center gap-2"><ErrorNotice error={control.error} />
        <Button size="sm" variant="outline" disabled={pending || control.isFetching} onClick={() => void reread().then(confirmed => { if (confirmed) setNotice('已重新读取会话状态。'); })}>刷新托管状态</Button></div>}
      {locked && !control.isError && <Button size="sm" variant="outline" className="mt-2" disabled={pending || control.isFetching}
        onClick={() => void reread().then(confirmed => { if (confirmed) setNotice('已重新读取会话状态。'); })}>刷新托管状态</Button>}
      {exhausted && <p role="alert" className="mt-1 text-xs text-destructive">会话版本已达到上限，请联系部署管理员检查。</p>}
    </div>
    {children}
    {state?.lifecycle === 'open' && state.reception === 'human' && view &&
      <ConversationReplyComposer key={view.viewerMemberId} userId={userId} companyId={companyId} conversationId={conversationId} storeId={storeId}
        view={view} pending={pending} locked={locked || control.isFetching} onSubmit={submit} onReadControl={reread} onDenied={onDenied} />}
  </>;
}
