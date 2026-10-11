import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../lib/api';
import { readConversationReply, type ConversationCommand, type ConversationReply } from '../lib/conversation-control-api';
import type { NoteSubmissionResult } from './conversation-notes-dialog';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';

export type CancelReplyCommand = Extract<ConversationCommand, { action: 'cancel_reply' }>;

export function ConversationReplyCancel({ companyId, conversationId, memberId, version, reply, enabled, onSubmit, onRefresh, onDenied, onReturnFocus }: {
  companyId: string; conversationId: string; memberId: string; version: number; reply: ConversationReply; enabled: boolean;
  onSubmit: (command: CancelReplyCommand, memberId: string) => Promise<NoteSubmissionResult | undefined>;
  onRefresh: () => Promise<void>; onDenied: (error: ApiError) => void; onReturnFocus: () => void;
}) {
  const [command, setCommand] = useState<CancelReplyCommand | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false), [retry, setRetry] = useState(false), [waiting, setWaiting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const active = useRef(true), busy = useRef(false), ownsFocus = useRef(false);
  const reconcileButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (reply.status !== 'queued' && ownsFocus.current) { ownsFocus.current = false; onReturnFocus(); }
  }, [reply.status, onReturnFocus]);
  useEffect(() => {
    if (unconfirmed && !waiting && reply.status === 'queued') reconcileButton.current?.focus();
  }, [unconfirmed, waiting, reply.status]);
  function finish() { setCommand(null); setUnconfirmed(false); setRetry(false); ownsFocus.current = false; onReturnFocus(); }

  async function submit() {
    if (!command || busy.current || !enabled) return;
    busy.current = true; setWaiting(true); setNotice(null);
    try {
      const result = await onSubmit(command, memberId);
      if (!active.current || !result) return;
      if (result.outcome === 'unconfirmed' || (result.outcome === 'rejected' && result.code === 'COMMAND_CONFLICT')) {
        setUnconfirmed(true); setRetry(false); setNotice('取消结果尚待核对。请先刷新这条回复的状态。');
      } else {
        finish();
        if (result.outcome === 'rejected') setNotice(result.code === 'REPLY_NOT_CANCELABLE' ? '这条回复已开始发送或已结束，无法取消。' : '取消未生效，请核对最新状态后重新确认。');
      }
      await onRefresh();
    } catch {
      if (active.current) { setUnconfirmed(true); setRetry(false); setNotice('暂时无法确认取消结果，请先核对发送状态。'); }
    } finally { busy.current = false; if (active.current) setWaiting(false); }
  }
  async function reconcile() {
    if (!command || busy.current) return;
    busy.current = true; setWaiting(true);
    try {
      const result = await readConversationReply(companyId, conversationId, command.targetIntentId);
      if (!active.current) return;
      if (result.reply.status === 'queued') { setRetry(true); setNotice('这条回复仍在排队。你可以重试原取消请求。'); }
      else { finish(); setNotice(result.reply.status === 'canceled' ? '已取消，这条消息未发送给消费者。' : '这条回复已开始发送或已结束，无法取消。'); }
      await onRefresh();
    } catch (error) {
      if (!active.current) return;
      if (error instanceof ApiError && ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND'].includes(error.code)) onDenied(error);
      else setNotice('暂时无法核对取消结果，请恢复连接后再试。');
    } finally { busy.current = false; if (active.current) setWaiting(false); }
  }

  if (reply.status !== 'queued') return null;
  return <div className="flex flex-col gap-2">
    {notice && <p role="status">{notice}</p>}
    {!command ? <Button size="sm" variant="outline" disabled={!enabled || waiting} onClick={() => {
      ownsFocus.current = true; setCommand({ commandId: crypto.randomUUID(), action: 'cancel_reply', expectedVersion: version, targetIntentId: reply.intentId }); setNotice(null);
    }}>取消发送</Button> : <Alert><AlertDescription className="flex flex-col gap-2">
      <p>{unconfirmed ? '取消结果待核对' : '确认取消这条排队回复？'}</p>
      <p>仅能取消尚未开始发送的消息。平台请求开始后无法撤回。</p>
      {!unconfirmed && command.expectedVersion !== version && <p>会话已发生变化，请返回记录后重新确认。</p>}
      <div className="flex flex-wrap gap-2">
        {unconfirmed ? <>
          <Button ref={reconcileButton} size="sm" variant="outline" disabled={waiting} onClick={() => void reconcile()}>核对取消结果</Button>
          {retry && <Button size="sm" disabled={!enabled || waiting} onClick={() => void submit()}>重试原取消</Button>}
        </> : <>
          <Button size="sm" variant="outline" disabled={waiting} onClick={finish}>保留发送</Button>
          <Button size="sm" disabled={!enabled || waiting || command.expectedVersion !== version} onClick={() => void submit()}>{waiting ? '正在取消…' : '确认取消发送'}</Button>
        </>}
      </div>
    </AlertDescription></Alert>}
  </div>;
}
