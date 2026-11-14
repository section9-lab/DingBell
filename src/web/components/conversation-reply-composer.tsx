import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { REPLY_BODY_MAX } from '../../shared/reply-body.ts';
import { ApiError } from '../lib/api';
import {
  isValidConversationReplyBody, readConversationReplies, readConversationReply,
  type ConversationCommandReceipt, type ConversationControlView,
} from '../lib/conversation-control-api';
import { readPendingReply, savePendingReply, clearPendingReply, clearPendingReplies, type PendingReplyCommand } from '../lib/conversation-reply-pending';
import { readReplyDraft, saveReplyDraft, clearReplyDrafts } from '../lib/conversation-draft';
import { readStore, updateStore } from '../lib/stores-api';
import { ErrorNotice } from './identity-shared';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { Spinner } from './ui/spinner';

export type ReplySubmission =
  | { outcome: 'accepted'; receipt: ConversationCommandReceipt }
  | { outcome: 'rejected' | 'unconfirmed'; code?: string };

const reasons: Record<string, string> = {
  CONTROL_CHANGED: '会话处理状态发生变化。', ACCESS_REVOKED: '发送成员已无此店铺的访问权限。',
  CREDENTIAL_CHANGED: '店铺授权已更新。', CREDENTIALS_UNAVAILABLE: '店铺授权暂时不可用。', THREAD_CHANGED: '平台会话信息发生变化。',
  OUTBOUND_DISABLED: '工作区或店铺已关闭对外回复。', CAPABILITY_UNVERIFIED: '回复能力未验证或已过期。', REPLY_UNAVAILABLE: '店铺或会话当前不允许回复。',
  INVALID_CREDENTIALS: '平台未接受店铺授权，请检查 API 凭证。', PERMISSION_DENIED: '平台未授予发送权限。',
  RATE_LIMITED: '平台请求频率已达限制，请稍后核对。', NOT_FOUND: '平台未找到目标会话。', INVALID_REQUEST: '平台未接受消息格式。', REJECTED: '平台拒绝了这条消息。',
};
function storage() { try { return window.sessionStorage; } catch { return null; } }
const denied = (error: unknown): error is ApiError => error instanceof ApiError && ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND'].includes(error.code);

/**
 * 人工回复：原文直接发送。
 * 输入与发送分开判断：外发开关、会话归属没就绪时仍然可以写草稿，
 * 只是发不出去——否则用户连字都打不了，也就无从准备内容。
 */
export function ConversationReplyComposer({ userId, companyId, conversationId, storeId, view, pending, locked, onSubmit, onReadControl, onDenied }: {
  userId: string; companyId: string; conversationId: string; storeId?: string; view: ConversationControlView;
  pending: boolean; locked: boolean;
  onSubmit: (command: PendingReplyCommand, expectedMemberId: string) => Promise<ReplySubmission | undefined>;
  onReadControl: () => Promise<boolean>; onDenied: (error: ApiError) => void;
}) {
  const scope = { userId, companyId, conversationId, memberId: view.viewerMemberId };
  const [journal, setJournal] = useState(() => readPendingReply(storage(), scope));
  const [savedDraft] = useState(() => readReplyDraft(storage(), scope));
  const [body, setBody] = useState(savedDraft.state === 'saved' ? savedDraft.body : '');
  const [draftUnavailable, setDraftUnavailable] = useState(savedDraft.state === 'unavailable');
  const [checking, setChecking] = useState(false);
  const [canRetry, setCanRetry] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [outboundBusy, setOutboundBusy] = useState(false);
  const [outboundNotice, setOutboundNotice] = useState<string | null>(null);
  const draft = useRef({ body, revision: 0 }), identity = useRef(false);
  const active = useRef(true), busy = useRef(false), reported = useRef(false), changedMember = useRef<string | null>(null);
  const draftInput = useRef<HTMLTextAreaElement>(null);

  const replies = useQuery({
    queryKey: ['conversation-replies', companyId, conversationId],
    queryFn: ({ signal }) => readConversationReplies(companyId, conversationId, signal),
    enabled: !pending, gcTime: 0, refetchInterval: 5_000,
  });
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (denied(replies.error) && !reported.current) {
      reported.current = true; clearPendingReplies(storage(), { userId, companyId, conversationId });
      clearReplyDrafts(storage(), { userId, companyId, conversationId }); onDenied(replies.error);
    }
  }, [replies.error, userId, companyId, conversationId, onDenied]);
  const data = replies.isError ? undefined : replies.data;
  const identityConfirmed = !!data && data.viewerMemberId === view.viewerMemberId;
  identity.current = identityConfirmed;
  useEffect(() => {
    if (data && !identityConfirmed && changedMember.current !== data.viewerMemberId) {
      changedMember.current = data.viewerMemberId;
      void onReadControl();
    }
  }, [data, identityConfirmed, onReadControl]);

  const current = data?.viewerMemberId === view.viewerMemberId && data.controlVersion === view.state.version;
  const exhausted = [view.state.version, view.state.sequence].some(value => value >= Number.MAX_SAFE_INTEGER);
  // composing：可以在这里写草稿。sendable：还满足对外发送的全部条件。
  const composing = !!data && identityConfirmed && current && data.historyReady && view.state.lifecycle === 'open' && !exhausted
    && view.state.reception === 'human';
  const ready = composing && data!.readiness.allowed;
  const valid = isValidConversationReplyBody(body);
  const outbound = body;
  const blocked = pending || checking || locked || !ready || journal.state !== 'none';
  const gate = view.state.lifecycle === 'resolved' ? '会话已解决，无法回复。'
    : exhausted ? '会话版本已达到上限，请联系部署管理员。'
      : !data ? '正在确认回复条件。' : !current ? '会话状态已变化，请刷新回复状态。'
        : !data.historyReady ? '正在整理已有发送记录，完成后可继续回复。'
          : data.readiness.code === 'OUTBOUND_DISABLED' ? '尚未开启对外发送，消息发不出去；草稿和译文可以正常保留。'
            : data.readiness.code === 'CAPABILITY_UNVERIFIED' ? '店铺的回复能力尚未验证或已过期，请在店铺管理检查。'
              : data.readiness.code === 'REPLY_UNAVAILABLE' ? '当前店铺或会话暂时无法回复，请检查连接与会话状态。' : null;

  async function enableOutbound() {
    if (!storeId || outboundBusy) return;
    setOutboundBusy(true); setOutboundNotice(null);
    try {
      const { store } = await readStore(companyId, storeId);
      await updateStore(companyId, storeId, 'outbound', { expectedRevision: store.revision, enabled: true });
      await replies.refetch(); await onReadControl();
      if (active.current) setOutboundNotice('已允许此店铺向买家发送消息。');
    } catch (error) {
      if (!active.current) return;
      if (denied(error)) { onDenied(error); return; }
      setOutboundNotice('未能开启对外发送。若是部署级外发总闸已关闭，请联系部署管理员。');
    } finally { if (active.current) setOutboundBusy(false); }
  }

  function changeBody(value: string) {
    if (value !== draft.current.body) draft.current = { body: value, revision: draft.current.revision + 1 };
    setBody(value);
    setDraftUnavailable(!saveReplyDraft(storage(), scope, value));
    setNotice(null);
  }
  function release(command: PendingReplyCommand, discardDraft = false) {
    if (discardDraft && !saveReplyDraft(storage(), scope, '')) {
      setDraftUnavailable(true); setNotice('消息已提交，但本机草稿尚未清理。请恢复浏览器存储后再次核对。'); return false;
    }
    if (!clearPendingReply(storage(), scope, command)) {
      setNotice('结果已确认，但本机提交记录尚未清理。请再次核对，暂时不要创建新的发送。'); return false;
    }
    setJournal({ state: 'none' }); setCanRetry(false); return true;
  }
  async function submit(command: PendingReplyCommand) {
    // 重试原提交时本机仍持有待核对记录（journal.state === 'pending'），因此不能用 blocked
    // 判断；这里只挡真正会让提交冲突的并发状态。
    if (busy.current || pending || checking || locked || !ready || !identityConfirmed) return;
    busy.current = true;
    if (!savePendingReply(storage(), scope, command)) {
      setJournal(readPendingReply(storage(), scope)); setNotice('浏览器无法可靠保存本次提交，消息尚未提交。请检查浏览器存储设置。'); busy.current = false; return;
    }
    setJournal({ state: 'pending', command }); setCanRetry(false); setNotice(null);
    try {
      const result = await onSubmit(command, scope.memberId);
      if (!active.current || !result) return;
      if (result.outcome === 'accepted' && result.receipt.action === 'send_reply') {
        if (release(command, true)) { changeBody(''); setNotice('已提交发送，等待平台送达结果。'); }
        await replies.refetch();
      } else if (result.outcome === 'rejected' && result.code !== 'COMMAND_CONFLICT') {
        if (release(command)) {
          changeBody(command.body);
          setNotice(reasons[result.code ?? ''] ?? '这次发送未被接受，内容已保留，请核对后重试。');
        }
        await replies.refetch();
      } else setNotice(result.outcome === 'rejected' && result.code === 'COMMAND_CONFLICT'
        ? '提交编号与服务器记录冲突，请先核对提交，暂时不要重复发送。'
        : '发送结果尚未确认。原文和提交编号已保留，请先核对。');
    } catch { if (active.current) setNotice('发送结果尚未确认。请先核对提交，勿重复发送。'); }
    finally { busy.current = false; }
  }
  async function reconcile() {
    if (busy.current || pending || !identityConfirmed || journal.state !== 'pending') return;
    busy.current = true; setChecking(true); setCanRetry(false); setNotice(null);
    const command = journal.command;
    try {
      const result = await readConversationReply(companyId, conversationId, command.commandId);
      if (!active.current) return;
      if (result.reply.body !== command.body) {
        setNotice('服务器记录与本机确认内容不一致，已停止操作。请联系管理员核对提交编号。'); return;
      }
      if (release(command, true)) { changeBody(''); setNotice('已找到这条提交，没有再次发送。'); }
      await replies.refetch();
    } catch (error) {
      if (!active.current) return;
      if (error instanceof ApiError && error.code === 'NOT_FOUND') {
        const confirmed = await onReadControl();
        if (active.current && confirmed) { setCanRetry(true); setNotice('暂未找到原提交，可以重试；系统沿用同一编号，不会创建第二条记录。'); }
      } else if (denied(error)) {
        clearPendingReplies(storage(), { userId, companyId, conversationId });
        clearReplyDrafts(storage(), { userId, companyId, conversationId }); onDenied(error);
      } else setNotice('暂时无法核对提交。原文和编号已保留，请恢复连接后再核对。');
    } finally { busy.current = false; if (active.current) setChecking(false); }
  }
  function send() {
    if (blocked || !isValidConversationReplyBody(outbound)) return;
    void submit({
      commandId: crypto.randomUUID(), expectedVersion: view.state.version, action: 'send_reply', body: outbound,
    });
  }

  return <div role="group" aria-label="回复编辑器" className="flex shrink-0 flex-col gap-2 border-t border-border/60 px-4 py-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm font-medium">回复消费者</span>
      <span className="text-xs text-muted-foreground">消息会直接发送给 Ozon。</span>
    </div>
    {!identityConfirmed ? <p role="status" className="text-xs text-muted-foreground">正在确认当前成员身份，暂不展示本机提交内容。</p>
      : journal.state === 'blocked' ? <Alert variant="destructive"><AlertDescription>本机提交记录无法读取，已暂停新发送。请联系管理员核对已有消息，避免重复发送。</AlertDescription></Alert>
        : journal.state === 'pending' ? <Alert><AlertDescription className="flex flex-col gap-2">
          <p>{pending ? '正在提交这条回复，请稍候。' : '有一条提交尚待核对。请先确认结果，再编辑下一条回复。'}</p>
          <p dir="auto" className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{journal.command.body}</p>
          <p className="break-all text-xs">提交编号：{journal.command.commandId}</p>
          <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={pending || checking} onClick={() => void reconcile()}>{checking && <Spinner aria-hidden="true" />}核对提交</Button>
            {canRetry && <Button size="sm" disabled={pending || checking || locked} onClick={() => void submit(journal.command)}>重试原提交</Button>}</div>
          {!!notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
        </AlertDescription></Alert>
          : <form onSubmit={event => { event.preventDefault(); send(); }}>
            <Textarea ref={draftInput} id="conversation-reply-body" aria-label="回复原文" value={body} onChange={event => changeBody(event.target.value)}
              disabled={pending || checking || !composing} aria-invalid={!!body && !valid} maxLength={REPLY_BODY_MAX} rows={3} className="max-h-40 min-h-20" placeholder="输入要发送给消费者的内容…" />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{body.length} / {REPLY_BODY_MAX} 字符</span>
              <div className="flex flex-wrap items-center gap-2">
                {valid && <Button type="submit" size="sm" disabled={blocked || !isValidConversationReplyBody(outbound)}>
                  {pending ? <Spinner aria-hidden="true" /> : <Send data-icon="inline-start" />}发送
                </Button>}
              </div>
            </div>
            {gate && <div role="status" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{gate}</span>
              {data?.readiness.code === 'OUTBOUND_DISABLED' && !!storeId && view.state.reception === 'human' &&
                <Button type="button" size="xs" variant="outline" disabled={outboundBusy || pending || checking} onClick={() => void enableOutbound()}>
                  {outboundBusy && <Spinner aria-hidden="true" />}允许向买家发送</Button>}
            </div>}
            {!!outboundNotice && <p role="status" className="mt-2 text-xs text-muted-foreground">{outboundNotice}</p>}
            {draftUnavailable && <p role="status" className="mt-2 text-xs text-destructive">草稿自动保存不可用。当前输入仍保留，请勿关闭或刷新页面。</p>}
            {!!notice && <p role="status" className="mt-2 text-xs text-muted-foreground">{notice}</p>}
            {replies.isError && <ErrorNotice error={replies.error} />}
            {(replies.isError || (data && !current)) && <Button type="button" size="sm" variant="outline" className="mt-2" disabled={checking || replies.isFetching}
              onClick={() => { void onReadControl().then(() => replies.refetch()); }}>刷新回复状态</Button>}
          </form>}
  </div>;
}
