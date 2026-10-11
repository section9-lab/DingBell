import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, History, Languages } from 'lucide-react';
import { ApiError } from '../lib/api';
import { isValidConversationReplyBody, readConversationReplies, readConversationReply, type ConversationControlView, type ConversationReply } from '../lib/conversation-control-api';
import { readPendingReply, savePendingReply, clearPendingReply, clearPendingReplies, type PendingReplyCommand } from '../lib/conversation-reply-pending';
import { readReplyPreview, submitReplyPreview, isReplyPreviewRejected, type ReplyPreview, type ReplyPreviewRequest } from '../lib/conversation-preview-api';
import { readPendingPreview, savePendingPreview, clearPendingPreview, clearPendingPreviews } from '../lib/conversation-preview-pending';
import { readReplyDraft, saveReplyDraft, clearReplyDrafts } from '../lib/conversation-draft';
import type { NoteSubmissionResult } from './conversation-notes-dialog';
import { ConversationReplyCancel, type CancelReplyCommand } from './conversation-reply-cancel';
import { ConversationAiDraft } from './conversation-ai-draft';
import { ErrorNotice } from './identity-shared';
import { useCompanySettings } from './company-settings-provider';
import { Alert, AlertDescription } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from './ui/field';
import { Textarea } from './ui/textarea';
import { Spinner } from './ui/spinner';
import { Message, MessageContent, MessageHeader, MessageFooter } from './ui/message';
import { Bubble, BubbleContent } from './ui/bubble';
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerItem } from './ui/message-scroller';

const labels = { queued: '已排队', sending: '发送中', sent: '平台已接收', failed: '发送失败', unknown: '结果待确认', skipped: '已跳过', canceled: '已取消' } as const;
const descriptions = {
  queued: '等待发送。发送前会再次检查会话和店铺权限。', sending: '正在向平台提交，请勿重复发送。',
  sent: 'Ozon 已确认接收这条消息，不代表消费者已经阅读。', failed: '平台未接受这次发送。请检查原因并核对平台会话。',
  unknown: '平台结果尚未确认，消息可能已经送达。请先在 Ozon 核对，系统不会自动重发。',
  skipped: '发送前条件已变化，这条消息未发出。请核对会话状态后重新编辑。',
  canceled: '这条排队回复已取消，未发送给消费者。',
} as const;
const reasons: Record<string, string> = {
  CONTROL_CHANGED: '会话处理状态发生变化。', ACCESS_REVOKED: '发送成员已无此店铺的访问权限。',
  CREDENTIAL_CHANGED: '店铺授权已更新。', CREDENTIALS_UNAVAILABLE: '店铺授权暂时不可用。', THREAD_CHANGED: '平台会话信息发生变化。',
  OUTBOUND_DISABLED: '工作区或店铺已关闭对外回复。', CAPABILITY_UNVERIFIED: '回复能力未验证或已过期。', REPLY_UNAVAILABLE: '店铺或会话当前不允许回复。',
  INVALID_CREDENTIALS: '平台未接受店铺授权，请检查 API 凭证。', PERMISSION_DENIED: '平台未授予发送权限。',
  RATE_LIMITED: '平台请求频率已达限制，请稍后核对。', NOT_FOUND: '平台未找到目标会话。', INVALID_REQUEST: '平台未接受消息格式。', REJECTED: '平台拒绝了这条消息。',
};
function storage() { try { return window.sessionStorage; } catch { return null; } }
const denied = (error: unknown): error is ApiError => error instanceof ApiError && ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND'].includes(error.code);

export function ConversationReplyComposer({ userId, companyId, conversationId, conversationLabel, view, pending, locked, onSubmit, onReadControl, onDenied }: {
  userId: string; companyId: string; conversationId: string; conversationLabel: string; view: ConversationControlView;
  pending: boolean; locked: boolean; onSubmit: (command: PendingReplyCommand | CancelReplyCommand, expectedMemberId: string) => Promise<NoteSubmissionResult | undefined>;
  onReadControl: () => Promise<boolean>; onDenied: (error: ApiError) => void;
}) {
  const { date: messageDate } = useCompanySettings();
  const scope = { userId, companyId, conversationId, memberId: view.viewerMemberId };
  const [journal, setJournal] = useState(() => readPendingReply(storage(), scope));
  const [savedDraft] = useState(() => readReplyDraft(storage(), scope));
  const [body, setBody] = useState(savedDraft.state === 'saved' ? savedDraft.body : '');
  const [draftUnavailable, setDraftUnavailable] = useState(savedDraft.state === 'unavailable');
  const [preview, setPreview] = useState<PendingReplyCommand | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoreCandidate, setRestoreCandidate] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [canRetry, setCanRetry] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [recovered, setRecovered] = useState<ConversationReply | null>(null);
  const [translationJournal, setTranslationJournal] = useState(() => readPendingPreview(storage(), scope));
  const [translation, setTranslation] = useState<ReplyPreview | null>(null);
  const [editedTranslation, setEditedTranslation] = useState<string | null>(null);
  const [translationBinding, setTranslationBinding] = useState<{ requestId: string; revision: number } | null>(null);
  const [translationConfirmation, setTranslationConfirmation] = useState<{ source: string; revision: number } | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translationRetry, setTranslationRetry] = useState(false);
  const [translationNotice, setTranslationNotice] = useState<string | null>(null);
  const draft = useRef({ body, revision: 0 }), translationBusy = useRef(false), identity = useRef(false);
  const active = useRef(true), busy = useRef(false), reported = useRef(false), changedMember = useRef<string | null>(null);
  const previewButton = useRef<HTMLButtonElement>(null), historyButton = useRef<HTMLButtonElement>(null);
  const historyCloseButton = useRef<HTMLButtonElement>(null);
  const draftInput = useRef<HTMLTextAreaElement>(null), historyReturnFocus = useRef<HTMLTextAreaElement | null>(null);
  const keepDraftButton = useRef<HTMLButtonElement>(null);
  const translationButton = useRef<HTMLButtonElement>(null), confirmationFocus = useRef<HTMLButtonElement | null>(null);
  const replies = useQuery({
    queryKey: ['conversation-replies', companyId, conversationId],
    queryFn: ({ signal }) => readConversationReplies(companyId, conversationId, signal),
    enabled: !pending, gcTime: 0, retry: false, refetchInterval: 5_000,
  });
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (restoreCandidate) keepDraftButton.current?.focus(); }, [restoreCandidate]);
  useEffect(() => {
    if (denied(replies.error) && !reported.current) {
      reported.current = true; clearPendingReplies(storage(), { userId, companyId, conversationId });
      clearPendingPreviews(storage(), { userId, companyId, conversationId }); clearReplyDrafts(storage(), { userId, companyId, conversationId }); onDenied(replies.error);
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
  const ready = current && data?.historyReady && data.readiness.allowed && view.state.lifecycle === 'open' && view.state.reception === 'human' && !exhausted;
  const disabled = pending || checking || locked || replies.isFetching || !ready || journal.state !== 'none';
  const canRestore = identityConfirmed && !!current && !exhausted && !pending && !checking && !locked && !replies.isFetching && journal.state === 'none';
  const valid = isValidConversationReplyBody(body);
  const translationRequest = translationJournal.state === 'pending' ? translationJournal.request : translation;
  const translationMatches = !!translationRequest && translationBinding?.requestId === translationRequest.requestId
    && translationBinding.revision === draft.current.revision && translationRequest.source === body;
  const translationDisabled = disabled || translating || !identityConfirmed;
  const translationStale = !!translationConfirmation && (translationConfirmation.revision !== draft.current.revision || translationConfirmation.source !== body);
  const rows = data ? recovered && !data.replies.some(row => row.intentId === recovered.intentId) ? [recovered, ...data.replies] : data.replies : [];
  const gate = view.state.lifecycle === 'resolved' ? '会话已解决。重新打开并接管后才可回复。'
    : view.state.reception !== 'human' ? '请先认领或接管会话，再回复消费者。'
      : exhausted ? '会话版本已达到上限，请联系部署管理员。'
        : !data ? '正在确认回复条件。' : !current ? '会话状态已变化，请刷新回复状态。'
          : !data.historyReady ? '正在整理已有发送记录，完成后可继续回复。'
            : data.readiness.code === 'OUTBOUND_DISABLED' ? '此工作区或店铺尚未开启对外回复。'
              : data.readiness.code === 'CAPABILITY_UNVERIFIED' ? '店铺的回复能力尚未验证或已过期，请在店铺管理检查。'
                : data.readiness.code === 'REPLY_UNAVAILABLE' ? '当前店铺或会话暂时无法回复，请检查连接与会话状态。' : null;

  function changeBody(value: string) {
    if (value !== draft.current.body) {
      draft.current = { body: value, revision: draft.current.revision + 1 };
      setBody(value); setPreview(null); setTranslationConfirmation(null); setEditedTranslation(null);
    }
    setDraftUnavailable(!saveReplyDraft(storage(), scope, value));
    setNotice(null);
  }
  function releaseTranslation(request: ReplyPreviewRequest) {
    if (!clearPendingPreview(storage(), scope, request)) {
      setTranslationJournal(readPendingPreview(storage(), scope));
      setTranslationNotice('翻译结果已返回，但本机记录未能清理。请再次核对，暂时不要创建新翻译。'); return false;
    }
    setTranslationJournal({ state: 'none' }); setTranslationRetry(false); return true;
  }
  function clearTranslationResult() {
    setTranslation(null); setEditedTranslation(null); setTranslationBinding(null); setTranslationNotice(null);
  }
  function restoreReply(reply: ConversationReply, replace = false) {
    if (!canRestore || busy.current || !['failed', 'skipped', 'canceled'].includes(reply.status)) return;
    if (draft.current.body && draft.current.body !== reply.body && !replace) { setRestoreCandidate(reply.intentId); return; }
    draft.current = { body: reply.body, revision: draft.current.revision + 1 };
    setBody(reply.body); setPreview(null); setTranslationConfirmation(null); clearTranslationResult();
    setDraftUnavailable(!saveReplyDraft(storage(), scope, reply.body));
    setRestoreCandidate(null); setNotice('已恢复为草稿。请核对内容，再预览并确认发送。');
    historyReturnFocus.current = draftInput.current; setHistoryOpen(false);
  }
  async function translate(request: ReplyPreviewRequest, operation: 'new' | 'retry' | 'read') {
    if (translationBusy.current || disabled || !identityConfirmed) return;
    const sourceRevision = draft.current.revision;
    translationBusy.current = true; setTranslating(true); setTranslationRetry(false); setTranslationNotice(null);
    if (operation !== 'read' && !savePendingPreview(storage(), scope, request)) {
      setTranslationJournal(readPendingPreview(storage(), scope));
      setTranslationNotice('浏览器无法可靠保存翻译请求，尚未提交。请检查浏览器存储设置。');
      translationBusy.current = false; setTranslating(false); return;
    }
    if (operation !== 'read') setTranslationJournal({ state: 'pending', request });
    if (operation === 'new') {
      setTranslation(null); setEditedTranslation(null); setTranslationBinding({ requestId: request.requestId, revision: draft.current.revision });
    }
    try {
      const result = operation === 'read' ? await readReplyPreview(companyId, conversationId, scope.memberId, request)
        : await submitReplyPreview(companyId, conversationId, scope.memberId, request);
      if (!active.current || !identity.current) return;
      setTranslation(result.preview.status === 'ready' && sourceRevision !== draft.current.revision ? null : result.preview);
      if (result.preview.status === 'ready') {
        if (releaseTranslation(request)) setTranslationNotice(sourceRevision === draft.current.revision
          ? '俄语预览已生成。请查看并核对，确认后才会发送。'
          : '原文已修改，旧译文未应用。请重新生成俄语预览。');
      } else if (result.preview.status === 'unavailable') {
        if (releaseTranslation(request)) setTranslationNotice('未能生成可用的俄语译文。请核对原文后再试，或发送原文。');
      } else {
        setTranslationRetry(operation === 'read' && result.preview.status === 'unconfirmed');
        setTranslationNotice(result.preview.status === 'pending' ? '俄语预览仍在生成，请稍后手动刷新。' : '翻译请求结果尚未确认，请先核对原请求。');
      }
    } catch (error) {
      if (!active.current || !identity.current) return;
      if (operation === 'read' && error instanceof ApiError && error.code === 'NOT_FOUND') {
        const confirmed = await onReadControl();
        if (active.current && identity.current && confirmed) {
          setTranslationRetry(true); setTranslationNotice('暂未找到原翻译请求。可显式重试原预览，继续使用相同编号和原文。');
        }
      } else if (denied(error)) {
        clearPendingPreviews(storage(), { userId, companyId, conversationId });
        clearPendingReplies(storage(), { userId, companyId, conversationId }); clearReplyDrafts(storage(), { userId, companyId, conversationId }); onDenied(error);
      } else if (operation !== 'read' && isReplyPreviewRejected(error)) {
        if (releaseTranslation(request)) setTranslationNotice(error instanceof ApiError && error.code === 'TRANSLATION_DISABLED'
          ? '此工作区尚未开启俄语预览。你仍可发送原文。'
          : error instanceof ApiError && error.code === 'BUDGET_UNAVAILABLE' ? '翻译预算暂不可用。你仍可发送原文。'
            : '俄语预览暂不可用，本次请求未被接受。你仍可发送原文。');
      } else setTranslationNotice(error instanceof ApiError && error.code === 'PREVIEW_CONFLICT'
        ? '翻译请求编号与服务器记录冲突。原请求已保留，请联系管理员核对，暂不创建新翻译。'
        : '翻译请求结果尚未确认。原文和编号已保留，请先核对俄语预览。');
    } finally { translationBusy.current = false; if (active.current) setTranslating(false); }
  }
  function restoreTranslationSource() {
    if (!translationRequest || translationDisabled) return;
    changeBody(translationRequest.source);
    setTranslationBinding({ requestId: translationRequest.requestId, revision: draft.current.revision });
  }
  function openTranslation() {
    if (translationDisabled || !translationMatches || translation?.status !== 'ready' || !translation.translation) return;
    confirmationFocus.current = translationButton.current;
    setTranslationConfirmation({ source: body, revision: draft.current.revision });
    setPreview({ commandId: crypto.randomUUID(), expectedVersion: view.state.version, action: 'send_reply', body: editedTranslation ?? translation.translation, previewRequestId: translation.requestId });
  }

  async function refresh() {
    await onReadControl();
    if (!active.current) return;
    await replies.refetch();
    if (recovered && active.current) {
      try {
        const result = await readConversationReply(companyId, conversationId, recovered.intentId);
        if (active.current) setRecovered(result.reply);
      } catch { if (active.current) setRecovered(null); }
    }
  }
  function release(command: PendingReplyCommand, discardDraft = false) {
    if (discardDraft && !saveReplyDraft(storage(), scope, '')) {
      setDraftUnavailable(true); setNotice('原提交已确认，但本机草稿尚未清理。请恢复浏览器存储后再次核对，暂时不要创建新回复。'); return false;
    }
    if (!clearPendingReply(storage(), scope, command)) {
      setNotice('结果已确认，但本机提交记录尚未清理。请再次核对，暂时不要创建新的发送。'); return false;
    }
    setJournal({ state: 'none' }); setCanRetry(false); return true;
  }
  async function submit(command: PendingReplyCommand, translated = false) {
    if (busy.current || pending || checking || locked || !identityConfirmed) return;
    if (translated && (!translationConfirmation || translationStale || !isValidConversationReplyBody(command.body))) return;
    const candidate = translated ? translation : null, confirmedSource = translationConfirmation?.source;
    busy.current = true;
    if (!savePendingReply(storage(), scope, command)) {
      setPreview(null); setJournal(readPendingReply(storage(), scope)); setNotice('浏览器无法可靠保存本次提交，消息尚未提交。请检查浏览器存储设置。'); busy.current = false; return;
    }
    draft.current = { ...draft.current, revision: draft.current.revision + 1 };
    setTranslationBinding(null); setTranslationConfirmation(null);
    setJournal({ state: 'pending', command }); setPreview(null); setCanRetry(false); setNotice(null);
    try {
      const result = await onSubmit(command, scope.memberId);
      if (!active.current || !result) return;
      if (result.outcome === 'accepted' && result.receipt.action === 'send_reply') {
        if (release(command, true)) { changeBody(''); clearTranslationResult(); setNotice('回复已进入发送队列，请查看发送结果。'); }
        await replies.refetch();
      } else if (result.outcome === 'rejected' && result.code !== 'COMMAND_CONFLICT') {
        if (release(command)) {
          if (!translated) changeBody(command.body);
          else if (candidate && draft.current.body === confirmedSource) {
            setEditedTranslation(command.body); setTranslationBinding({ requestId: candidate.requestId, revision: draft.current.revision });
          }
          setNotice(result.code === 'PREVIEW_UNAVAILABLE' ? '原翻译预览不可用于本次回复。原文和修改稿已保留，请核对原文并重新生成预览。'
            : translated ? '这次提交未被接受。原文和修改后的译文已保留，请核对最新状态后重新预览。' : '这次提交未被接受。原文已保留，请核对最新状态后重新预览。');
        }
        await replies.refetch();
      } else setNotice(result.outcome === 'rejected' && result.code === 'COMMAND_CONFLICT' ? '提交编号与服务器已有记录冲突，原记录可能已经发送。请核对原提交，暂时不要创建新的发送。' : '提交结果尚未确认。原文和提交编号已保留，请先核对提交。');
    } catch { if (active.current) setNotice('提交结果尚未确认。请先核对提交，勿重复创建新消息。'); }
    finally { busy.current = false; }
  }
  async function reconcile() {
    if (busy.current || pending || !identityConfirmed || journal.state !== 'pending') return;
    busy.current = true; setChecking(true); setCanRetry(false); setNotice(null);
    const command = journal.command;
    try {
      const result = await readConversationReply(companyId, conversationId, command.commandId);
      if (!active.current) return;
      if (result.reply.body !== command.body || result.reply.previewRequestId !== command.previewRequestId) { setNotice('服务器记录与本机确认内容或翻译来源不一致，已停止操作。请联系管理员核对提交编号。'); return; }
      setRecovered(result.reply);
      if (release(command, true)) { changeBody(''); clearTranslationResult(); setNotice(`原提交已找到：${labels[result.reply.status]}。没有再次发送。`); }
      await refresh();
    } catch (error) {
      if (!active.current) return;
      if (error instanceof ApiError && error.code === 'NOT_FOUND') {
        const confirmed = await onReadControl();
        if (active.current && confirmed) { setCanRetry(true); setNotice('暂未找到原提交。你可以重试原提交；系统沿用相同编号和原文，不会创建第二条记录。'); }
      } else if (denied(error)) {
        clearPendingReplies(storage(), { userId, companyId, conversationId });
        clearPendingPreviews(storage(), { userId, companyId, conversationId }); clearReplyDrafts(storage(), { userId, companyId, conversationId }); onDenied(error);
      } else setNotice('暂时无法核对提交。原文和编号已保留，请恢复连接后再核对。');
    } finally { busy.current = false; if (active.current) setChecking(false); }
  }

  return <div aria-label="回复编辑器" className="flex shrink-0 flex-col gap-2 border-t px-4 py-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm font-medium">回复消费者</span>
      <div className="flex flex-wrap gap-1">
      <ConversationAiDraft key={`${companyId}:${conversationId}:${view.viewerMemberId}`} companyId={companyId} conversationId={conversationId} memberId={view.viewerMemberId} conversationLabel={conversationLabel}
        canRead={identityConfirmed} canAdopt={!disabled && identityConfirmed && !translating} getEditor={() => ({ ...draft.current })} editorFocus={() => draftInput.current}
        onDenied={onDenied} onAdopt={(text, expected) => {
          if (!identity.current || disabled || translating || expected.revision !== draft.current.revision || expected.body !== draft.current.body) return false;
          changeBody(text); setNotice('已填入 AI 草稿，请核对并按需修改。预览确认后才会发送。'); return true;
        }} />
      <Button ref={historyButton} size="sm" variant="ghost" onClick={() => { historyReturnFocus.current = null; setRestoreCandidate(null); setHistoryOpen(true); }}><History data-icon="inline-start" />最近发送{rows[0] ? ` · ${labels[rows[0].status]}` : ''}</Button>
      </div>
    </div>
    {!identityConfirmed ? <p role="status" className="text-xs text-muted-foreground">正在确认当前成员身份，暂不展示本机提交内容。</p> : journal.state === 'none' ? <form onSubmit={event => {
      event.preventDefault();
      if (!disabled && valid) {
        confirmationFocus.current = previewButton.current; setTranslationConfirmation(null);
        setPreview({ commandId: crypto.randomUUID(), expectedVersion: view.state.version, action: 'send_reply', body });
      }
    }}>
      <FieldGroup className="gap-2"><Field data-invalid={!!body && !valid} data-disabled={pending || checking || !ready} className="gap-2">
        <FieldLabel htmlFor="conversation-reply-body" className="sr-only">回复原文</FieldLabel>
        <Textarea ref={draftInput} id="conversation-reply-body" aria-describedby="conversation-reply-help" value={body} onChange={event => changeBody(event.target.value)}
          disabled={pending || checking || !ready} aria-invalid={!!body && !valid} maxLength={1000} rows={2} className="max-h-28 min-h-16" placeholder="输入要发送给消费者的原文…" />
        <FieldDescription id="conversation-reply-help">{body && !valid ? '请输入有效的非空白文本，移除不支持的控制字符。' : draftUnavailable ? '核对预览并确认后才会发送。' : '草稿保存在当前标签页，刷新后可恢复。核对预览并确认后才会发送。'}</FieldDescription>
        {draftUnavailable && <p role="status" className="text-xs text-destructive">草稿自动保存不可用。当前输入仍保留，请勿关闭或刷新页面。</p>}
      </Field></FieldGroup>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{body.length} / 1000 字符</span><div className="flex flex-wrap gap-2">
        <Button size="sm" type="button" variant="outline" disabled={translationDisabled || !valid || translationJournal.state !== 'none'} onClick={() => void translate({ requestId: crypto.randomUUID(), source: body, sourceRevision: draft.current.revision }, 'new')}>
          {translating ? <Spinner aria-hidden="true" /> : <Languages data-icon="inline-start" />}生成俄语预览
        </Button>
        <Button ref={previewButton} size="sm" type="submit" disabled={disabled || !valid}><ArrowUpRight data-icon="inline-start" />预览回复</Button>
      </div></div>
    </form> : journal.state === 'pending' ? <Alert><AlertDescription className="flex flex-col gap-2">
      <p>{pending ? '正在提交这条回复，请稍候。' : '有一条提交尚待核对。请先确认结果，再编辑下一条回复。'}</p>
      <p dir="auto" className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{journal.command.body}</p>
      <p className="break-all text-xs">提交编号：{journal.command.commandId}</p>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={pending || checking} onClick={() => void reconcile()}>{checking && <Spinner aria-hidden="true" />}核对提交</Button>
        {canRetry && <Button size="sm" disabled={pending || checking || locked} onClick={() => void submit(journal.command)}>重试原提交</Button>}</div>
    </AlertDescription></Alert> : <Alert variant="destructive"><AlertDescription>本机提交记录无法读取，已暂停新发送。请联系管理员核对已有消息，避免重复发送。</AlertDescription></Alert>}
    {identityConfirmed && journal.state === 'none' && <>
      {translationJournal.state === 'blocked' && <Alert variant="destructive"><AlertDescription>本机翻译请求无法读取，已暂停新翻译。请联系管理员核对；原文发送仍可使用。</AlertDescription></Alert>}
      {translationNotice && <Alert><AlertDescription>{translationNotice}</AlertDescription></Alert>}
      {translationRequest && <div className="flex flex-wrap gap-2">
        {!translationMatches && <Button size="sm" variant="outline" disabled={translationDisabled} onClick={restoreTranslationSource}>恢复翻译原文</Button>}
        {translationJournal.state === 'pending' && <>
          <Button size="sm" variant="outline" disabled={translationDisabled} onClick={() => void translate(translationJournal.request, 'read')}>{translation?.status === 'pending' ? '刷新俄语预览' : '核对俄语预览'}</Button>
          {translationRetry && <Button size="sm" variant="outline" disabled={translationDisabled} onClick={() => void translate(translationJournal.request, 'retry')}>重试原预览</Button>}
        </>}
        {translationMatches && translation?.status === 'ready' && <Button ref={translationButton} size="sm" disabled={translationDisabled} onClick={openTranslation}>查看俄语预览</Button>}
      </div>}
    </>}
    {gate && journal.state === 'none' && <p role="status" className="text-xs text-muted-foreground">{gate}</p>}
    {replies.isError && <ErrorNotice error={replies.error} />}
    {(replies.isError || (data && !current)) && <Button size="sm" variant="outline" disabled={pending || checking || replies.isFetching} onClick={() => void refresh()}>刷新回复状态</Button>}
    {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
    <Dialog open={!!preview} onOpenChange={open => { if (!open && !pending) { setPreview(null); setTranslationConfirmation(null); } }}>
      <DialogContent showCloseButton={false} finalFocus={() => {
        const trigger = confirmationFocus.current ?? previewButton.current;
        if (trigger?.isConnected && !trigger.disabled) return trigger;
        return draftInput.current && !draftInput.current.disabled ? draftInput.current : historyButton.current;
      }} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>确认发送给消费者</DialogTitle><DialogDescription>{translationConfirmation ? '请核对并修改俄语译文。只有点击确认发送，才会将下方内容提交到 Ozon。' : '以下原文将发送到 Ozon。请核对收件会话与内容。'}</DialogDescription></DialogHeader>
        <p className="break-words text-sm [overflow-wrap:anywhere]">{conversationLabel}</p>
        {translationConfirmation ? <FieldGroup className="gap-4">
          <Field className="gap-2"><FieldLabel>翻译原文</FieldLabel><p dir="auto" className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground [overflow-wrap:anywhere]">{translationConfirmation.source}</p></Field>
          <Field data-invalid={!!preview && !isValidConversationReplyBody(preview.body)} className="gap-2">
            <FieldLabel htmlFor="conversation-reply-russian">俄语译文</FieldLabel>
            <Textarea id="conversation-reply-russian" lang="ru" value={preview?.body ?? ''} disabled={pending} maxLength={1000} rows={4} className="max-h-52 min-h-24"
              aria-describedby="conversation-reply-russian-help" aria-invalid={!!preview && !isValidConversationReplyBody(preview.body)}
              onChange={event => { const value = event.target.value; setEditedTranslation(value); setPreview(current => current ? { ...current, body: value } : null); }} />
            <FieldDescription id="conversation-reply-russian-help">{preview && !isValidConversationReplyBody(preview.body) ? '请输入有效的非空白俄语文本，最多 1000 字符。' : '请重点核对数量、否定表达和退款承诺。修改后的内容将原样发送。'}</FieldDescription>
          </Field>
          {translation?.usageStatus === 'held' && <p className="text-xs text-muted-foreground">本次翻译用量仍待核对，不代表免费。</p>}
        </FieldGroup> : <Message align="end"><MessageContent><Bubble variant="secondary" align="end"><BubbleContent><p dir="auto" className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{preview?.body}</p></BubbleContent></Bubble></MessageContent></Message>}
        {preview && preview.expectedVersion !== view.state.version && <Alert><AlertDescription>会话已发生变化，请返回编辑并重新预览。</AlertDescription></Alert>}
        {translationStale && <Alert><AlertDescription>原文已修改，请返回编辑并重新生成俄语预览。</AlertDescription></Alert>}
        <DialogFooter><Button variant="outline" disabled={pending} onClick={() => { setPreview(null); setTranslationConfirmation(null); }}>返回编辑</Button><Button disabled={disabled || preview?.expectedVersion !== view.state.version || translationStale || !preview || !isValidConversationReplyBody(preview.body)} onClick={() => { if (preview) void submit(preview, !!translationConfirmation); }}>确认发送</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
      <DialogContent finalFocus={() => historyReturnFocus.current && !historyReturnFocus.current.disabled ? historyReturnFocus.current : historyButton.current} className="max-h-[calc(100dvh-2rem)] sm:max-w-xl">
        <DialogHeader><DialogTitle>最近发送</DialogTitle><DialogDescription>当前会话最近 20 次提交及本次核对的结果。显示发送管道记录，不作为消费者已读凭证。</DialogDescription></DialogHeader>
        {replies.isError ? <ErrorNotice error={replies.error} /> : !data ? <p role="status">正在读取发送记录…</p> : !rows.length ? <p className="text-sm text-muted-foreground">暂无发送记录。</p> : <div className="h-[min(26rem,55dvh)] min-h-0">
          <MessageScrollerProvider autoScroll={false} defaultScrollPosition="start"><MessageScroller><MessageScrollerViewport role="region" aria-label="发送结果记录" tabIndex={0}><MessageScrollerContent className="p-1">
            {rows.map(reply => <MessageScrollerItem key={reply.intentId} messageId={reply.intentId}><Message align="end"><MessageContent>
              <MessageHeader><Badge variant={reply.status === 'failed' || reply.status === 'unknown' ? 'outline' : 'secondary'}>{labels[reply.status]}</Badge></MessageHeader>
              <Bubble variant="secondary" align="end"><BubbleContent><p dir="auto" className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{reply.body}</p></BubbleContent></Bubble>
              <MessageFooter><div className="flex flex-col gap-1"><time dateTime={reply.createdAt}>{messageDate(reply.createdAt)}</time><p>{descriptions[reply.status]}</p>
                {reply.reason && reasons[reply.reason] && <p>{reasons[reply.reason]}</p>}<p className="break-all">提交编号：{reply.intentId}</p>
                {['failed', 'skipped', 'canceled'].includes(reply.status) && (restoreCandidate === reply.intentId ? <Alert><AlertDescription className="flex flex-col gap-2">
                  <p>替换当前未发送的草稿？</p><p>当前草稿将被上方回复正文替换。恢复后仍需预览并确认发送。</p>
                  <div className="flex flex-wrap gap-2"><Button ref={keepDraftButton} size="sm" variant="outline" onClick={() => { setRestoreCandidate(null); historyCloseButton.current?.focus(); }}>保留当前草稿</Button>
                    <Button size="sm" disabled={!canRestore} onClick={() => restoreReply(reply, true)}>替换草稿</Button></div>
                </AlertDescription></Alert> : <Button size="sm" variant="outline" disabled={!canRestore} onClick={() => restoreReply(reply)}>恢复为草稿</Button>)}
                {!reply.intentId.startsWith('ai-reply:') && <ConversationReplyCancel companyId={companyId} conversationId={conversationId} memberId={view.viewerMemberId} version={view.state.version} reply={reply}
                  enabled={identityConfirmed && !!current && !exhausted && !pending && !locked && !checking && !replies.isFetching} onSubmit={onSubmit} onRefresh={refresh} onDenied={onDenied} onReturnFocus={() => historyCloseButton.current?.focus()} />}
              </div></MessageFooter>
            </MessageContent></Message></MessageScrollerItem>)}
          </MessageScrollerContent></MessageScrollerViewport></MessageScroller></MessageScrollerProvider>
        </div>}
        <DialogFooter><Button variant="outline" disabled={pending || replies.isFetching} onClick={() => void refresh()}>刷新发送结果</Button><Button ref={historyCloseButton} onClick={() => setHistoryOpen(false)}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
