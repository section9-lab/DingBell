import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, RefreshCw } from 'lucide-react';
import { ApiError } from '../lib/api';
import { readAiDraft, type AiDraft } from '../lib/ai-draft-api';
import { ErrorNotice } from './identity-shared';
import { useCompanySettings } from './company-settings-provider';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from './ui/empty';
import { Separator } from './ui/separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter, SheetTrigger } from './ui/sheet';
import { Spinner } from './ui/spinner';

type Editor = { body: string; revision: number };
const reasons = {
  new_input: '会话已有新消息，这份草稿仅供查看。', source_changed: '知识来源已变化，请核对最新资料后重新编写。',
  policy_changed: '回复策略已变化，这份草稿仅供查看。', conversation_changed: '店铺或平台会话状态已变化，请先核对。',
  changed: '核对期间上下文发生变化，请刷新草稿。',
};
const denied = (error: unknown): error is ApiError => error instanceof ApiError && ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND'].includes(error.code);
export function ConversationAiDraft({ companyId, conversationId, memberId, conversationLabel, canRead, canAdopt, getEditor, onAdopt, editorFocus, onDenied }: {
  companyId: string; conversationId: string; memberId: string; conversationLabel: string; canRead: boolean; canAdopt: boolean;
  getEditor: () => Editor; onAdopt: (body: string, expected: Editor) => boolean; editorFocus: () => HTMLElement | null; onDenied: (error: ApiError) => void;
}) {
  const { date } = useCompanySettings();
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const [replacement, setReplacement] = useState<{ runId: string; editor: Editor } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), request = useRef<AbortController | null>(null), adopted = useRef(false), live = useRef(true), reported = useRef(false);
  const current = useRef({ canAdopt, onAdopt, getEditor, onDenied }); current.current = { canAdopt, onAdopt, getEditor, onDenied };
  const query = useQuery({ queryKey: ['ai-draft', companyId, conversationId, memberId], queryFn: ({ signal }) => readAiDraft(companyId, conversationId, memberId, signal),
    enabled: open && canRead, gcTime: 0, retry: false, refetchOnWindowFocus: false });
  const data = query.isError ? undefined : query.data, draft = data?.draft;
  useEffect(() => { live.current = true; return () => { live.current = false; request.current?.abort(); }; }, []);
  useEffect(() => { if (denied(query.error) && !reported.current) { reported.current = true; onDenied(query.error); } }, [query.error, onDenied]);
  function toggle(value: boolean) {
    request.current?.abort(); request.current = null; setPending(false); setReplacement(null); setNotice(null);
    if (value) adopted.current = false;
    setOpen(value);
  }
  async function adopt(runId: string, editor: Editor) {
    if (pending || !current.current.canAdopt) return;
    const controller = new AbortController(); request.current = controller; setPending(true); setNotice(null);
    try {
      const fresh = await readAiDraft(companyId, conversationId, memberId, controller.signal);
      if (!live.current || controller.signal.aborted) return;
      if (!fresh.draft || fresh.draft.runId !== runId || fresh.draft.status !== 'current') {
        setReplacement(null); setNotice('草稿或依据已变化，请重新核对。'); await query.refetch(); return;
      }
      if (!current.current.canAdopt || !current.current.onAdopt(fresh.draft.body, editor)) {
        setReplacement(null); setNotice('回复框或处理状态已变化，已保留当前输入。请重新核对。'); return;
      }
      adopted.current = true; toggle(false);
    } catch (error) {
      if (!live.current || controller.signal.aborted) return;
      if (denied(error)) current.current.onDenied(error); else setNotice('暂时无法核对草稿，当前输入未变。请恢复连接后重试。');
    } finally { if (live.current && request.current === controller) { request.current = null; setPending(false); } }
  }
  function choose() {
    if (!draft || draft.status !== 'current' || !canAdopt || pending || query.isFetching) return;
    const editor = current.current.getEditor();
    if (editor.body && editor.body !== draft.body) setReplacement({ runId: draft.runId, editor });
    else void adopt(draft.runId, editor);
  }
  const available = !!draft && draft.status === 'current' && canAdopt && !pending && !query.isFetching;
  const source = (item: NonNullable<AiDraft['draft']>['citations'][number], index: number) => <article key={item.chunkId} className="flex flex-col gap-2">
    <div className="flex items-start justify-between gap-3"><h4 className="break-words text-sm font-medium">{index + 1}. {item.title}</h4><span className="shrink-0 text-xs text-muted-foreground">第 {item.revision} 版</span></div>
    <p lang={draft?.language} className="whitespace-pre-wrap break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{item.body}</p>
  </article>;
  return <Sheet open={open} onOpenChange={toggle}>
    <SheetTrigger render={<Button ref={trigger} type="button" size="sm" variant="ghost" disabled={!canRead} />}><FileText data-icon="inline-start" />AI 草稿</SheetTrigger>
    <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl" finalFocus={() => adopted.current ? editorFocus() ?? trigger.current : trigger.current}>
      <SheetHeader className="shrink-0 pr-12"><SheetTitle>AI 回复草稿</SheetTitle><SheetDescription>核对正文与引用。采纳只填入回复框，发送仍需人工确认。</SheetDescription></SheetHeader>
      <Separator />
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        <div className="flex items-center justify-between gap-3"><p className="min-w-0 break-words text-sm">{conversationLabel}</p><Button type="button" size="sm" variant="ghost" disabled={query.isFetching || pending || !canRead} onClick={() => { setReplacement(null); void query.refetch(); }}><RefreshCw data-icon="inline-start" />刷新草稿</Button></div>
        {!canRead ? <p role="status">正在确认当前成员权限。</p> : query.isError ? <ErrorNotice error={query.error} /> : !data ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />正在读取草稿…</p> : !draft ? <Empty><EmptyHeader><EmptyTitle>暂无 AI 草稿</EmptyTitle><EmptyDescription>AI 保存的回复草稿会显示在这里。你也可以直接编写人工回复。</EmptyDescription></EmptyHeader></Empty> : <>
          <div className="flex flex-wrap items-center gap-2"><Badge variant="secondary">{draft.status === 'current' ? '待人工复核' : '已过期 · 仅供查看'}</Badge><span className="text-xs text-muted-foreground">{date(draft.createdAt)} · {draft.language === 'ru' ? '俄语' : draft.language === 'zh-CN' ? '中文' : '英语'}</span></div>
          {draft.reason && <Alert><AlertDescription>{reasons[draft.reason]}</AlertDescription></Alert>}
          <section className="flex flex-col gap-2"><h3 className="text-sm font-medium">原问题</h3><p lang={draft.language} className="whitespace-pre-wrap break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{draft.question}</p></section>
          <section className="flex flex-col gap-2"><h3 className="text-sm font-medium">回复正文</h3><p lang={draft.language} className="whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{draft.body}</p></section>
          <Separator /><section className="flex flex-col gap-4"><div><h3 className="text-sm font-medium">引用来源 · {draft.citations.length}</h3><p className="mt-1 text-xs text-muted-foreground">请核对正文是否准确表达了下列资料。</p></div>{draft.citations.map(source)}</section>
        </>}
      </div>
      <Separator /><SheetFooter className="shrink-0">
        {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
        {replacement ? <Alert><AlertTitle>回复框已有内容</AlertTitle><AlertDescription className="flex flex-col gap-3"><p>采纳会替换当前输入。关闭抽屉或保留输入都不会更改回复。</p><div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" onClick={() => { request.current?.abort(); request.current = null; setPending(false); setReplacement(null); }}>保留当前输入</Button><Button type="button" size="sm" disabled={!available} onClick={() => void adopt(replacement.runId, replacement.editor)}>{pending && <Spinner />}替换当前输入</Button></div></AlertDescription></Alert> : <>
          {draft?.status === 'current' && !canAdopt && <p className="text-xs text-muted-foreground">满足人工回复条件后可采纳；请先接管会话并检查回复权限。</p>}
          <Button type="button" disabled={!available} onClick={choose}>{pending && <Spinner />}采纳到回复框</Button>
        </>}
      </SheetFooter>
    </SheetContent>
  </Sheet>;
}
