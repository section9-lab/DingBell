import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../lib/api';
import { isValidConversationNoteBody, readConversationNotes, type ConversationCommand, type ConversationCommandReceipt, type ConversationControlView } from '../lib/conversation-control-api';
import { ErrorNotice } from './identity-shared';
import { useCompanySettings } from './company-settings-provider';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from './ui/field';
import { Textarea } from './ui/textarea';
import { Spinner } from './ui/spinner';
import { Message, MessageContent, MessageHeader, MessageFooter } from './ui/message';
import { Bubble, BubbleContent } from './ui/bubble';
import { Marker, MarkerContent } from './ui/marker';
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerItem } from './ui/message-scroller';

export type NoteSubmissionResult = { outcome: 'accepted'; receipt: ConversationCommandReceipt } | { outcome: 'rejected' | 'unconfirmed'; code?: string };
type NoteCommand = Extract<ConversationCommand, { action: 'add_note' }>;

export function ConversationNotesDialog({ companyId, conversationId, open, onOpenChange, view, pending, locked, onSubmit, onDenied, finalFocus }: {
  companyId: string; conversationId: string; open: boolean; onOpenChange: (open: boolean) => void;
  view?: ConversationControlView; pending: boolean; locked: boolean;
  onSubmit: (command: NoteCommand) => Promise<NoteSubmissionResult | undefined>;
  onDenied: (error: ApiError) => void; finalFocus: () => HTMLElement | null;
}) {
  const { date: messageDate } = useCompanySettings();
  const cache = useQueryClient();
  const [body, setBody] = useState('');
  const [frozen, setFrozen] = useState<NoteCommand | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const active = useRef(true), busy = useRef(false), reported = useRef(false);
  const cursor = pages.at(-1);
  const queryKey = ['conversation-notes', companyId, conversationId];
  const notes = useQuery({
    queryKey: [...queryKey, cursor], queryFn: ({ signal }) => readConversationNotes(companyId, conversationId, { limit: 20, cursor }, signal),
    enabled: open && !pending, gcTime: 0, retry: false, refetchInterval: 10_000,
  });
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (notes.error instanceof ApiError && ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND'].includes(notes.error.code) && !reported.current) {
      reported.current = true; onDenied(notes.error);
    }
  }, [notes.error, onDenied]);
  const data = notes.isError ? undefined : notes.data;
  const valid = isValidConversationNoteBody(body);
  const exhausted = !!view && [view.state.version, view.state.sequence].some(value => value >= Number.MAX_SAFE_INTEGER);
  const disabled = pending || locked || !view || (!frozen && exhausted);

  async function save() {
    if (busy.current || disabled || (!frozen && !valid)) return;
    busy.current = true;
    const command: NoteCommand = frozen ?? { commandId: crypto.randomUUID(), expectedVersion: view!.state.version, action: 'add_note', body };
    setFrozen(command); setNotice(null);
    try {
      const result = await onSubmit(command);
      if (!active.current || !result) return;
      if (result.outcome === 'accepted' && result.receipt.action === 'add_note') {
        setBody(''); setFrozen(null); setPages([]); setNotice('内部备注已保存。');
        await cache.invalidateQueries({ queryKey });
      } else if (result.outcome === 'rejected') {
        setFrozen(null); setNotice('这次备注未保存。草稿已保留，请核对最新会话状态后再保存。');
      } else {
        setNotice('保存结果尚未确认，草稿已保留。重试保存会核对原记录，不会重复添加。');
      }
    } catch {
      if (active.current) setNotice('保存结果尚未确认，草稿已保留。请稍后重试保存。');
    } finally { busy.current = false; }
  }

  return <Dialog open={open} onOpenChange={value => { if (!pending) onOpenChange(value); }}>
    <DialogContent showCloseButton={false} finalFocus={finalFocus} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>内部备注</DialogTitle><DialogDescription>仅团队可见，记录处理线索与交接事项。备注不会发送给消费者。</DialogDescription></DialogHeader>
      {notes.isPending ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner aria-hidden="true" />正在读取内部备注…</p> : notes.isError ? <><ErrorNotice error={notes.error} /><Button variant="outline" disabled={pending || notes.isFetching} onClick={() => void notes.refetch()}>重新读取备注</Button></> : data && <>
        <div className="h-56 min-h-0">
          <MessageScrollerProvider key={cursor ?? 'latest'} autoScroll={false} defaultScrollPosition="start">
            <MessageScroller><MessageScrollerViewport role="region" aria-label="内部备注记录" tabIndex={0}>
              <MessageScrollerContent className="p-1">
                <MessageScrollerItem messageId="notes-marker"><Marker variant="separator"><MarkerContent>{data.notes.length ? '团队备注 · 最新在前' : '暂无内部备注'}</MarkerContent></Marker></MessageScrollerItem>
                {data.notes.map(note => <MessageScrollerItem key={note.commandId} messageId={note.commandId}>
                  <Message align="start"><MessageContent>
                    <MessageHeader><span className="break-all">{note.authorName.trim() || '未填写姓名'}</span></MessageHeader>
                    <Bubble variant="muted"><BubbleContent><p dir="auto" className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{note.body}</p></BubbleContent></Bubble>
                    <MessageFooter><time dateTime={note.createdAt}>{messageDate(note.createdAt)}</time></MessageFooter>
                  </MessageContent></Message>
                </MessageScrollerItem>)}
              </MessageScrollerContent>
            </MessageScrollerViewport></MessageScroller>
          </MessageScrollerProvider>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="ghost" size="sm" disabled={pending || notes.isFetching || !data.nextCursor} onClick={() => setPages(current => [...current, data.nextCursor!])}>查看更早备注</Button>
          <Button variant="ghost" size="sm" disabled={pending || notes.isFetching || !pages.length} onClick={() => setPages(current => current.slice(0, -1))}>返回较新备注</Button>
        </div>
      </>}
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <FieldGroup><Field data-invalid={!!body && !valid} data-disabled={pending || !!frozen}>
          <FieldLabel htmlFor="conversation-note-body">备注内容</FieldLabel>
          <Textarea id="conversation-note-body" value={body} onChange={event => { setBody(event.target.value); setNotice(null); }} maxLength={4000} rows={3} className="max-h-40" disabled={pending || !!frozen} aria-invalid={!!body && !valid} aria-describedby="conversation-note-help" />
          <FieldDescription id="conversation-note-help">{body.length} / 4000 字符。草稿仅在当前会话页面保留。{body && !valid ? '请输入非空白的有效文本，移除不支持的控制字符。' : ''}</FieldDescription>
        </Field></FieldGroup>
        {notice && <p role="status" className="mt-3 text-sm text-muted-foreground">{notice}</p>}
        {locked && <p role="status" className="mt-3 text-sm text-muted-foreground">请关闭此窗口，先刷新会话状态，再继续核对备注。</p>}
        {exhausted && !frozen && <p role="alert" className="mt-3 text-sm text-destructive">会话版本已达到上限，暂时无法添加备注。</p>}
        <DialogFooter className="mt-4"><Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>关闭</Button>
          <Button type="submit" disabled={disabled || (!frozen && !valid)}>{pending && <Spinner aria-hidden="true" />}{frozen ? '重试保存' : '保存内部备注'}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
