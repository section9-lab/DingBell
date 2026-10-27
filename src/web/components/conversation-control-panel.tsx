import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { ApiError } from '../lib/api';
import { readConversationControl, readConversationTransferTargets, sendConversationCommand, type ConversationCommand } from '../lib/conversation-control-api';
import { ErrorNotice } from './identity-shared';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { NativeSelect, NativeSelectOption } from './ui/native-select';
import { Spinner } from './ui/spinner';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from './ui/popover';
import { ConversationNotesDialog, type NoteSubmissionResult } from './conversation-notes-dialog';
import { ConversationReplyComposer } from './conversation-reply-composer';
import { AiReceptionControl } from './ai-reception-control';
import { ConversationHandoffBrief } from './conversation-handoff-brief';
import {ConversationActivityDialog} from './conversation-activity-dialog';
import {ConversationTimelineDialog} from './conversation-timeline-dialog';
import type {ConversationMessage} from '../lib/conversations-api';

type ControlResponse = Awaited<ReturnType<typeof readConversationControl>>;
const workLabels = { needs_reply: '待回复', waiting_customer: '等待消费者', waiting_internal: '等待内部' } as const;
const denied = (error: unknown): error is ApiError => error instanceof ApiError && ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND'].includes(error.code);

export function ConversationControlPanel({ userId, companyId, conversationId, conversationLabel, messages, children, onDenied }: {
  userId: string; companyId: string; conversationId: string; conversationLabel: string; messages:ConversationMessage[]; children: ReactNode; onDenied: (error: ApiError) => void;
}) {
  const cache = useQueryClient();
  const queryKey = ['conversation-control', companyId, conversationId];
  const [pending, setPending] = useState(false);
  const [locked, setLocked] = useState(false);
  const [confirmation, setConfirmation] = useState<ConversationCommand | null>(null);
  const [transfer, setTransfer] = useState<{ commandId: string; expectedVersion: number; assignedMemberId: string | null; targetMemberId: string; reason: string } | null>(null);
  const [notice, setNotice] = useState<{ text: string; requestId?: string; saved?: boolean } | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [activityOpen,setActivityOpen]=useState(false);
  const [timelineOpen,setTimelineOpen]=useState(false);
  const busy = useRef(false), active = useRef(true), reported = useRef(false);
  const resolveButton = useRef<HTMLButtonElement>(null);
  const transferButton = useRef<HTMLButtonElement>(null);
  const notesButton = useRef<HTMLButtonElement>(null);
  const activityButton=useRef<HTMLButtonElement>(null);
  const timelineButton=useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const control = useQuery({
    queryKey, queryFn: ({ signal }) => readConversationControl(companyId, conversationId, signal),
    enabled: !pending && !locked, gcTime: 0, retry: false, refetchInterval: 10_000,
  });
  const targets = useInfiniteQuery({
    queryKey: ['conversation-transfer-targets', companyId, conversationId],
    initialPageParam: 0, queryFn: ({ pageParam, signal }) => readConversationTransferTargets(companyId, conversationId, pageParam, signal),
    getNextPageParam: page => page.nextOffset ?? undefined,
    enabled: !!transfer && !pending, gcTime: 0, retry: false,
  });
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (denied(control.error) && !reported.current) { reported.current = true; onDenied(control.error); }
  }, [control.error, onDenied]);
  useEffect(() => {
    if (denied(targets.error) && !reported.current) { reported.current = true; onDenied(targets.error); }
  }, [targets.error, onDenied]);

  async function reread() {
    const result = await control.refetch();
    if (!active.current) return false;
    if (denied(result.error)) { reported.current = true; onDenied(result.error); }
    const confirmed = !result.isError && !!result.data;
    setLocked(!confirmed);
    return confirmed;
  }
  async function submit(command: ConversationCommand, expectedMemberId?: string): Promise<NoteSubmissionResult | undefined> {
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
      void cache.invalidateQueries({ queryKey: ['handoff-brief', companyId, conversationId] });
      void cache.invalidateQueries({queryKey:['conversation-activity',companyId,conversationId]});
      void cache.invalidateQueries({queryKey:['conversation-timeline',companyId,conversationId]});
      setNotice(command.action === 'send_reply' ? null : { text: '处理状态已保存。', saved: true });
      return { outcome: 'accepted', receipt: result.receipt };
    } catch (error) {
      if (!active.current) return;
      setLocked(true);
      if (denied(error)) { reported.current = true; onDenied(error); return; }
      const confirmed = await reread();
      if (!active.current) return;
      if (command.action === 'transfer' && confirmed && error instanceof ApiError
        && ['TRANSFER_TARGET_UNAVAILABLE', 'CONVERSATION_CHANGED', 'COMMAND_CONFLICT'].includes(error.code)) {
        const refreshed = await targets.refetch();
        if (!active.current) return;
        if (denied(refreshed.error)) { reported.current = true; onDenied(refreshed.error); return; }
      }
      const uncertain = !(error instanceof ApiError) || error.code === 'OPERATION_UNCONFIRMED';
      if (command.action !== 'send_reply') setNotice({ text: uncertain
        ? confirmed ? '提交结果尚未确认，已重新读取会话状态。请核对后再操作。' : '提交结果尚未确认，暂时无法读取最新状态。请刷新会话状态后再操作。'
        : `${error.message}${confirmed ? ' 已读取最新会话状态。' : ' 请刷新会话状态后再操作。'}`,
        requestId: error instanceof ApiError ? error.requestId : undefined });
      return { outcome: uncertain ? 'unconfirmed' : 'rejected', ...(error instanceof ApiError ? { code: error.code } : {}) };
    } finally {
      if (active.current) { busy.current = false; setPending(false); setConfirmation(null); setTransfer(null); }
    }
  }
  const view = control.isError ? undefined : control.data?.control;
  const state = view?.state;
  const assigneeLabel = !view?.assignee ? '未分配' : view.assignee.status === 'removed' ? '负责人已移除' : `负责人：${view.assignee.name.trim() || '未填写姓名'}`;
  const exhausted = !!state && [state.version, state.controlEpoch, state.sequence].some(value => value >= Number.MAX_SAFE_INTEGER);
  const disabled = pending || locked || control.isFetching || !view || exhausted;
  function command(action: Exclude<ConversationCommand['action'], 'set_work_status' | 'transfer' | 'add_note' | 'send_reply' | 'cancel_reply'>): ConversationCommand {
    return { commandId: crypto.randomUUID(), expectedVersion: state!.version, action };
  }
  const candidates = [...new Map(targets.data?.pages.flatMap(page => page.targets).map(target => [target.memberId, target]) ?? []).values()]
    .filter(target => target.memberId !== transfer?.assignedMemberId);
  const transferValid = !!transfer && !!transfer.reason.trim() && transfer.reason.trim().length <= 500
    && candidates.some(target => target.memberId === transfer.targetMemberId);
  const transferDisabled = pending || locked || control.isError || targets.isFetching || targets.isError || !transferValid;

  return <><div ref={panel} tabIndex={-1} aria-label="会话处理" className="shrink-0 border-b px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
    {control.isPending ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner aria-hidden="true" />正在读取处理状态…</p> : <>
      {view && state && <div className="flex flex-wrap items-center justify-between gap-3">
        <div aria-label="当前处理状态" className="flex min-w-0 max-w-full flex-1 flex-wrap items-center gap-2 text-xs">
          <Badge variant={state.lifecycle === 'resolved' ? 'secondary' : 'outline'}>{state.lifecycle === 'resolved' ? '已解决' : state.workStatus && workLabels[state.workStatus]}</Badge>
          {state.lifecycle === 'open' && <span>{state.reception === 'human' ? '人工处理' : state.reception === 'ai' ? 'AI 接待' : '尚未接管'}</span>}
          {view.assignee && view.assignee.status !== 'removed' ? <Popover><PopoverTrigger render={<Button variant="ghost" size="xs" className="min-w-0 max-w-48 shrink" />}><span className="truncate">{assigneeLabel}</span><ChevronDown data-icon="inline-end" /></PopoverTrigger><PopoverContent className="max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] overflow-y-auto"><PopoverTitle>负责人信息</PopoverTitle><p className="break-all">{assigneeLabel}</p></PopoverContent></Popover> : <span className="text-muted-foreground">{assigneeLabel}</span>}
          {view.assignee && view.assignee.memberId === view.viewerMemberId && <Badge variant="secondary">我负责</Badge>}
          {view.assignee?.status === 'ineligible' && <Badge variant="outline">当前无法接手</Badge>}
        </div>
        {state.lifecycle === 'open' ? <div className="flex flex-wrap gap-2">
          {!state.assignedMemberId && <Button size="sm" disabled={disabled} onClick={() => void submit(command('claim'))}>认领并接管</Button>}
          {state.reception !== 'human' && <Button size="sm" variant="outline" disabled={disabled} onClick={() => void submit(command('takeover'))}>接管会话</Button>}
          <Button ref={transferButton} size="sm" variant="outline" disabled={disabled} onClick={() => setTransfer({ commandId: crypto.randomUUID(), expectedVersion: state.version, assignedMemberId: state.assignedMemberId, targetMemberId: '', reason: '' })}>{state.assignedMemberId ? '转交会话' : '分配负责人'}</Button>
          <Button ref={resolveButton} size="sm" variant="outline" disabled={disabled} onClick={() => setConfirmation(command('resolve'))}>标记已解决</Button>
        </div> : <Button size="sm" variant="outline" disabled={disabled} onClick={() => void submit(command('reopen'))}>重新打开</Button>}
      </div>}
      {view && <div className="mt-2 flex flex-wrap items-center gap-2"><Button ref={notesButton} size="sm" variant="ghost" disabled={pending || control.isFetching} onClick={() => setNotesOpen(true)}>内部备注</Button><Button ref={activityButton} size="sm" variant="ghost" disabled={pending||control.isFetching} onClick={()=>setActivityOpen(true)}>操作日志</Button><Button ref={timelineButton} size="sm" variant="ghost" disabled={pending||control.isFetching} onClick={()=>setTimelineOpen(true)}>业务时间线</Button>
      {state?.lifecycle === 'open' && <div aria-label="工作状态操作" className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">更新进度</span>
        {(Object.keys(workLabels) as (keyof typeof workLabels)[]).filter(status => status !== state.workStatus).map(workStatus =>
          <Button key={workStatus} size="sm" variant="ghost" disabled={disabled} onClick={() => void submit({ commandId: crypto.randomUUID(), expectedVersion: state.version, action: 'set_work_status', workStatus })}>
            {workStatus === 'needs_reply' ? '返回待回复' : workLabels[workStatus]}
          </Button>)}
      </div>}</div>}
      {control.isError && <ErrorNotice error={control.error} />}
      {(locked || control.isError) && <Button size="sm" variant="outline" className="mt-2" disabled={pending || control.isFetching} onClick={() => void reread().then(confirmed => { if (confirmed) setNotice({ text: '已重新读取会话状态，请核对后再操作。' }); })}>刷新会话状态</Button>}
      {exhausted && <p role="alert" className="mt-2 text-xs text-destructive">会话版本已达到上限，请联系部署管理员检查。</p>}
      {view?.projectionPending && !notice && <p className="mt-2 text-xs text-muted-foreground">处理状态已保存，日志同步中。</p>}
      {view && <AiReceptionControl key={`${userId}:${view.viewerMemberId}`} scope={{ userId, memberId: view.viewerMemberId, companyId, conversationId }} view={view} disabled={disabled} onChanged={reread} onDenied={onDenied} />}
      {view && <ConversationHandoffBrief companyId={companyId} conversationId={conversationId} messages={messages} onDenied={onDenied} />}
      {view?.projectionPending && <p className="mt-2 text-xs text-muted-foreground">列表状态和计数可能稍后更新，当前处理状态以此处为准。</p>}
      {notice && <div role="status" className="mt-2 text-xs text-muted-foreground"><p>{notice.saved && view?.projectionPending ? '处理状态已保存，日志同步中。' : notice.text}</p>{notice.requestId && <p className="mt-1 break-all">请求编号：{notice.requestId}</p>}</div>}
      {pending && <p role="status" className="mt-2 flex items-center gap-2 text-xs"><Spinner aria-hidden="true" />正在保存处理状态…</p>}
    </>}
    <ConversationNotesDialog companyId={companyId} conversationId={conversationId} open={notesOpen} onOpenChange={setNotesOpen} view={view}
      pending={pending} locked={locked || control.isFetching} onSubmit={submit} onDenied={onDenied} finalFocus={() => notesButton.current?.isConnected && !notesButton.current.disabled ? notesButton.current : panel.current} />
    <ConversationActivityDialog companyId={companyId} conversationId={conversationId} open={activityOpen} onOpenChange={setActivityOpen} onDenied={onDenied} finalFocus={()=>activityButton.current?.isConnected&&!activityButton.current.disabled?activityButton.current:panel.current} />
    <ConversationTimelineDialog companyId={companyId} conversationId={conversationId} open={timelineOpen} onOpenChange={setTimelineOpen} onDenied={onDenied} finalFocus={()=>timelineButton.current?.isConnected&&!timelineButton.current.disabled?timelineButton.current:panel.current} />
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !pending) setConfirmation(null); }}>
      <DialogContent showCloseButton={false} finalFocus={() => resolveButton.current?.isConnected && !resolveButton.current.disabled ? resolveButton.current : panel.current}>
        <DialogHeader><DialogTitle>标记会话已解决？</DialogTitle><DialogDescription>确认本次咨询已处理完成。此操作只更新团队的处理状态，不会向消费者发送消息或修改 Ozon 订单。</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setConfirmation(null)}>取消</Button><Button disabled={pending || locked || control.isError} onClick={() => { if (confirmation) void submit(confirmation); }}>{pending && <Spinner aria-hidden="true" />}确认解决</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={!!transfer} onOpenChange={open => { if (!open && !pending) setTransfer(null); }}>
      <DialogContent showCloseButton={false} finalFocus={() => transferButton.current?.isConnected && !transferButton.current.disabled ? transferButton.current : panel.current}>
        <DialogHeader><DialogTitle>{transfer?.assignedMemberId ? '转交会话' : '分配负责人'}</DialogTitle><DialogDescription>选择负责本次咨询的同事。转交后由人工处理，当前等待状态保持不变。</DialogDescription></DialogHeader>
        <form className="grid min-w-0 gap-4" onSubmit={event => {
          event.preventDefault();
          if (transfer && !transferDisabled) void submit({ commandId: transfer.commandId, expectedVersion: transfer.expectedVersion, action: 'transfer', targetMemberId: transfer.targetMemberId, reason: transfer.reason });
        }}>
          <div className="grid min-w-0 gap-2">
            <Label htmlFor="conversation-transfer-target">接手成员</Label>
            <NativeSelect id="conversation-transfer-target" className="w-full" value={transfer?.targetMemberId ?? ''} disabled={pending || targets.isFetching || targets.isError} onChange={event => { if (transfer) setTransfer({ ...transfer, targetMemberId: event.target.value }); }} required>
              <NativeSelectOption value="">请选择接手成员</NativeSelectOption>
              {candidates.map(target => <NativeSelectOption key={target.memberId} value={target.memberId}>{target.name} · {target.email}</NativeSelectOption>)}
            </NativeSelect>
            {targets.isPending && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner aria-hidden="true" />正在读取可接手的成员…</p>}
            {targets.isError && <><ErrorNotice error={targets.error} /><Button type="button" variant="outline" disabled={pending || targets.isFetching} onClick={() => void targets.refetch()}>重新读取成员</Button></>}
            {!targets.isPending && !targets.isError && !candidates.length && <p className="text-sm text-muted-foreground">暂无其他可接手的成员，请联系公司管理员检查店铺权限。</p>}
            {targets.hasNextPage && <Button type="button" variant="outline" disabled={pending || targets.isFetching} onClick={() => void targets.fetchNextPage()}>加载更多成员</Button>}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="conversation-transfer-reason">转交原因</Label>
            <Input id="conversation-transfer-reason" value={transfer?.reason ?? ''} maxLength={500} disabled={pending} onChange={event => { if (transfer) setTransfer({ ...transfer, reason: event.target.value }); }} placeholder="例如：需要同事协助处理退货" required />
            <p className="text-xs text-muted-foreground">说明接手原因，最多 500 字。</p>
          </div>
          <DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={() => setTransfer(null)}>取消</Button><Button type="submit" disabled={transferDisabled}>{pending && <Spinner aria-hidden="true" />}确认转交</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
    {children}
    {view && <ConversationReplyComposer key={view.viewerMemberId} userId={userId} companyId={companyId} conversationId={conversationId}
      conversationLabel={conversationLabel} view={view} pending={pending} locked={locked || control.isFetching}
      onSubmit={submit} onReadControl={reread} onDenied={onDenied} />}
  </>;
}
