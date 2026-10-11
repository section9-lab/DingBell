import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as v from 'valibot';
import { knowledgeDraftSchema, knowledgeScopeSchema, knowledgeTestCasesSchema, validKnowledgeScope, type KnowledgeDraft, type KnowledgeScope, type KnowledgeTestCases } from '../../shared/knowledge';
import { ApiError } from '../lib/api';
import { createKnowledge, readKnowledge, readKnowledgeJob, readKnowledgeVersions, submitKnowledgeJob, updateKnowledge, type KnowledgeOperation } from '../lib/knowledge-api';
import type { StoreRecord } from '../lib/stores-api';
import { useCompanySettings } from './company-settings-provider';
import { ErrorNotice } from './identity-shared';
import { KnowledgeFields, KnowledgeSource, knowledgeJobActive, knowledgeKinds, knowledgeLanguages, knowledgeStates } from './knowledge-fields';
import { emptyKnowledgeCases, KnowledgeJobStatus, KnowledgeReview } from './knowledge-review';
import { Alert, AlertTitle, AlertDescription } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { Spinner } from './ui/spinner';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';

type LocalDraft = { scope: KnowledgeScope; content: KnowledgeDraft; version: number };
type Props = { companyId: string; id: string; isNew: boolean; stores: StoreRecord[]; unavailable: boolean; capabilities: { indexing: boolean; review: boolean };
  initialQuestion?: Pick<KnowledgeTestCases[number], 'question' | 'minimumScore'>;
  onSaved: (id: string) => void; onDirty: (dirty: boolean) => void; refresh: (error?: unknown) => Promise<void> };
const denied = (error: unknown) => error instanceof ApiError && ['FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND'].includes(error.code);
export function KnowledgeEditor({ companyId, id, isNew, stores, unavailable, capabilities, initialQuestion, onSaved, onDirty, refresh }: Props) {
  const client = useQueryClient(), { date: formatDate, query: settings } = useCompanySettings();
  const date = (ms: number) => formatDate(new Date(ms).toISOString());
  const key = ['knowledge-document', companyId, id];
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => readKnowledge(companyId, id, signal), enabled: !isNew, retry: false, gcTime: 0 });
  const [local, setLocal] = useState<LocalDraft | null>(() => isNew ? { version: 0, scope: { kind: 'faq', language: 'ru', storeId: null, productRef: null }, content: { title: '', source: { format: 'text', content: '' } } } : null);
  const [tab, setTab] = useState(initialQuestion ? 'tests' : 'draft'), [pending, setPending] = useState(false), busy = useRef(false), mounted = useRef(false);
  const writing = useRef(false), interrupted = useRef(false);
  const [error, setError] = useState<unknown>(), [message, setMessage] = useState(''), [review, setReview] = useState(false), [reread, setReread] = useState(false);
  const [confirmation, setConfirmation] = useState<'publish' | 'withdraw' | null>(null), [before, setBefore] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState<KnowledgeOperation | null>(null), [localCases, setLocalCases] = useState<KnowledgeTestCases | null>(() => initialQuestion ? [{ ...initialQuestion, expectedChunkId: '' }] : null), [testDirty, setTestDirty] = useState(!!initialQuestion);
  const data = query.data, document = data?.document, content = local?.content ?? (data ? { title: data.draft.title, source: data.draft.source } : undefined);
  const scope = local?.scope ?? (document ? { kind: document.kind, storeId: document.storeId, productRef: document.productRef, language: document.language } : null);
  const contentDirty = !!local && (isNew || JSON.stringify(local.content) !== JSON.stringify(data && { title: data.draft.title, source: data.draft.source }));
  const dirty = contentDirty || testDirty, conflict = !!local && !!document && local.version !== document.version;
  const operation = submitted ?? data?.operation;
  const jobKey = ['knowledge-job', companyId, id, operation?.kind, operation?.id];
  const job = useQuery({ queryKey: jobKey, queryFn: async ({ signal }) => await readKnowledgeJob(companyId, id, operation!, signal), enabled: !!operation,
    retry: false, gcTime: 0, refetchInterval: query => query.state.error ? false : knowledgeJobActive(query.state.data?.job.state) ? 2000 : false });
  const currentJob = job.data?.job, currentReview = currentJob && 'kind' in currentJob ? currentJob : undefined;
  const cases = localCases ?? (currentReview?.kind === 'test' && currentReview.revision === document?.draftRevision ? currentReview.cases : null) ?? emptyKnowledgeCases();
  const blocked = pending || unavailable || settings.isPending || settings.isError || (!isNew && (query.isFetching || query.isError));
  const processing = !!operation && (job.isPending || job.isError || knowledgeJobActive(currentJob?.state));
  const locked = blocked || processing || review || conflict;
  const parsed = content ? v.safeParse(knowledgeDraftSchema, content) : null;
  const valid = parsed?.success && !!scope && v.safeParse(knowledgeScopeSchema, scope).success && validKnowledgeScope(scope, parsed.output);
  const historyBefore = before ?? (document ? Math.min(document.draftRevision + 1, Number.MAX_SAFE_INTEGER - 1) : 1);
  const history = useQuery({ queryKey: ['knowledge-versions', companyId, id, historyBefore], queryFn: ({ signal }) => readKnowledgeVersions(companyId, id, historyBefore, signal), enabled: !isNew && tab === 'versions', retry: false, gcTime: 0 });
  useEffect(() => {
    mounted.current = true;
    if (!busy.current) setPending(false);
    if (!busy.current && interrupted.current) { interrupted.current = false; setReview(true); setReread(false); setError(new ApiError('OPERATION_UNCONFIRMED')); }
    return () => { mounted.current = false; if (writing.current) interrupted.current = true; };
  }, []);
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  useEffect(() => { if (!dirty) return; const prevent = (event: BeforeUnloadEvent) => event.preventDefault(); window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent); }, [dirty]);
  useEffect(() => { const error = query.error ?? history.error; if (denied(error)) void refresh(error); }, [query.error, history.error, refresh]);
  useEffect(() => { if (job.error instanceof ApiError && ['FORBIDDEN', 'UNAUTHENTICATED'].includes(job.error.code)) void refresh(job.error); }, [job.error, refresh]);
  const observed = useRef('');
  useEffect(() => {
    if (!currentJob || knowledgeJobActive(currentJob.state) || observed.current === `${currentJob.id}:${currentJob.state}`) return;
    observed.current = `${currentJob.id}:${currentJob.state}`;
    void client.invalidateQueries({ queryKey: ['knowledge-document', companyId, id] });
    void client.invalidateQueries({ queryKey: ['knowledge-reviews', companyId, id] });
    void client.invalidateQueries({ queryKey: ['knowledge-versions', companyId, id] });
    void client.invalidateQueries({ queryKey: ['knowledge', companyId] });
  }, [currentJob, client, companyId, id]);
  async function readLatest() {
    if (busy.current) return; busy.current = true; setPending(true); setReread(false);
    try {
      await client.cancelQueries({ queryKey: key }); const latest = await readKnowledge(companyId, id);
      if (!mounted.current) return;
      await client.cancelQueries({ queryKey: key }); if (!mounted.current) return;
      client.setQueryData(key, latest); setSubmitted(null); setReread(true);
      if (local && JSON.stringify(local.content) === JSON.stringify({ title: latest.draft.title, source: latest.draft.source })) setLocal(null);
      if (isNew) onSaved(id);
      await settings.refetch();
      void client.invalidateQueries({ queryKey: ['knowledge-job', companyId, id] });
    } catch (cause) {
      if (!mounted.current) return;
      if (denied(cause) && !(isNew && cause instanceof ApiError && cause.code === 'NOT_FOUND')) { await refresh(cause); return; }
      setError(cause); if (isNew && cause instanceof ApiError && cause.code === 'NOT_FOUND') setReread(true);
    } finally { busy.current = false; if (mounted.current) setPending(false); }
  }
  async function write(action: 'draft' | 'restore' | 'withdraw', revision?: number) {
    if (busy.current || locked || !content || !scope || ((action === 'draft' || isNew) && !valid) || (action === 'restore' && dirty)) return;
    busy.current = true; writing.current = true; setPending(true); setError(undefined); setMessage(''); setConfirmation(null);
    try {
      await client.cancelQueries({ queryKey: key }); const expectedVersion = local?.version ?? document!.version;
      const result = isNew ? await createKnowledge(companyId, id, scope, v.parse(knowledgeDraftSchema, content)) : action === 'draft'
        ? await updateKnowledge(companyId, id, action, { expectedVersion, ...v.parse(knowledgeDraftSchema, content) }) : action === 'restore'
          ? await updateKnowledge(companyId, id, action, { expectedVersion, revision: revision! }) : await updateKnowledge(companyId, id, action, { expectedVersion });
      if (!mounted.current) return;
      await client.cancelQueries({ queryKey: key }); if (!mounted.current) return;
      client.setQueryData(key, result); setLocal(action === 'withdraw' && contentDirty ? { scope, content, version: result.document.version } : null);
      setSubmitted(null); setBefore(null); setReview(false); setReread(false); onSaved(id);
      if (action === 'restore') setTab('draft');
      void client.invalidateQueries({ queryKey: ['knowledge', companyId] }); void client.invalidateQueries({ queryKey: ['knowledge-versions', companyId, id] });
      setMessage(({ draft: '草稿已保存，生效版本未改变。', restore: '历史版本已恢复为新草稿，请重新索引、测试并发布。', withdraw: '已撤回发布，此资料不再作为新的检索依据。' })[action]);
    } catch (cause) { if (!mounted.current) return; if (denied(cause)) { await refresh(cause); return; } setError(cause); setReview(true); setReread(false); }
    finally { busy.current = false; writing.current = false; if (mounted.current) { interrupted.current = false; setPending(false); } }
  }
  async function submit(kind: KnowledgeOperation['kind']) {
    if (busy.current || locked || contentDirty || !document || isNew || (kind === 'test' && !v.safeParse(knowledgeTestCasesSchema, cases).success)) return;
    busy.current = true; writing.current = true; setPending(true); setError(undefined); setMessage(''); setConfirmation(null);
    const operation = { kind, id: crypto.randomUUID() };
    try {
      await client.cancelQueries({ queryKey: key }); const base = { jobId: operation.id, expectedVersion: document.version };
      const result = kind === 'test' ? await submitKnowledgeJob(companyId, id, kind, { ...base, cases: v.parse(knowledgeTestCasesSchema, cases) }) : await submitKnowledgeJob(companyId, id, kind, base);
      if (!mounted.current) return;
      client.setQueryData(['knowledge-job', companyId, id, kind, operation.id], result); setSubmitted(operation); setLocal(null);
      if (kind === 'test') { setTestDirty(false); setLocalCases(cases); }
      setMessage('任务已保存，可在下方查看执行进度。');
      await client.invalidateQueries({ queryKey: key }); void client.invalidateQueries({ queryKey: ['knowledge-reviews', companyId, id] });
    } catch (cause) {
      if (!mounted.current) return; if (denied(cause)) { await refresh(cause); return; }
      if (cause instanceof ApiError && cause.code === 'OPERATION_UNCONFIRMED') setSubmitted(operation);
      setError(cause); setReview(true); setReread(false);
    } finally { busy.current = false; writing.current = false; if (mounted.current) { interrupted.current = false; setPending(false); } }
  }
  if (!isNew && (query.isError || !data)) return <Card><CardHeader><CardTitle>知识详情</CardTitle><CardDescription>读取草稿、生效版本与任务状态。</CardDescription></CardHeader><CardContent>{query.isError ? <ErrorNotice error={query.error}/> : <p role="status"><Spinner/>正在读取知识…</p>}</CardContent><CardFooter><Button variant="outline" disabled={pending || query.isFetching} onClick={() => void readLatest()}>读取最新版本</Button></CardFooter></Card>;
  if (!content || !scope) return null;
  const active = data?.active, saved = data?.draft, canPublish = !locked && !dirty && capabilities.review && saved?.status === 'ready' && saved.testedAt !== null && document?.activeRevision !== saved.revision;
  return <div className="flex min-w-0 flex-col gap-4">
    {!isNew && <p className="break-words text-sm text-muted-foreground">{knowledgeKinds[scope.kind]} · {knowledgeLanguages[scope.language]} · {scope.storeId ? stores.find(store => store.id === scope.storeId)?.name ?? '店铺资料' : '公司通用'}{scope.productRef ? ` · 商品 ${scope.productRef}` : ''}</p>}
    {(review || conflict) && <Alert><AlertTitle>{error instanceof ApiError && error.code === 'OPERATION_UNCONFIRMED' ? '操作结果尚未确认' : '核对最新知识后再操作'}</AlertTitle><AlertDescription><p>你的修改已保留，请读取最新版本并核对后再操作。系统不会自动重提请求。</p>
      {reread && <Button variant="outline" className="self-start" disabled={blocked || processing} onClick={() => { if (local) setLocal({ ...local, version: document?.version ?? 0 }); setReview(false); setReread(false); setError(undefined); }}>基于最新版本继续编辑</Button>}
    </AlertDescription></Alert>}
    {error != null && !(error instanceof ApiError && ['OPERATION_UNCONFIRMED', 'KNOWLEDGE_CHANGED'].includes(error.code)) && <ErrorNotice error={error}/>}
    {message && <p role="status" className="text-sm">{message}</p>}
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={pending || query.isFetching} onClick={() => void readLatest()}>读取最新版本</Button>{dirty && <Badge variant="outline">未保存修改</Badge>}</div>
    {operation && <KnowledgeJobStatus operation={operation} job={currentJob} error={job.error} fetching={job.isFetching} onRead={() => void job.refetch()}/>}
    <Card data-testid="knowledge-effective"><CardHeader><div className="flex flex-wrap items-center gap-2"><CardTitle>{active ? `生效版本 v${active.revision}` : '尚未发布'}</CardTitle><Badge variant={active ? 'secondary' : 'outline'}>{active ? '已发布' : '草稿'}</Badge></div><CardDescription>{active ? active.title : '保存、索引和检索测试不会自动发布资料。'}</CardDescription></CardHeader>
      {active && <><CardContent><details><summary className="cursor-pointer text-sm">查看当前生效内容</summary><div className="pt-3"><KnowledgeSource source={active.source}/></div></details></CardContent><CardFooter><Button variant="outline" disabled={locked} onClick={() => setConfirmation('withdraw')}>撤回发布</Button></CardFooter></>}
    </Card>
    <Tabs value={tab} onValueChange={value => setTab(value as string)}><TabsList className="max-w-full"><TabsTrigger value="draft">编辑草稿</TabsTrigger><TabsTrigger value="tests" disabled={isNew}>检索测试</TabsTrigger><TabsTrigger value="versions" disabled={isNew}>版本记录</TabsTrigger></TabsList>
      <TabsContent value="draft" className="pt-4"><Card><CardHeader><div className="flex flex-wrap items-center gap-2"><CardTitle>{isNew ? '新建知识' : `草稿 v${saved!.revision}`}</CardTitle>{saved && <Badge variant="outline">{knowledgeStates[saved.status]}</Badge>}</div><CardDescription>{saved?.rollbackOf ? `恢复自 v${saved.rollbackOf}。` : '保存一条有明确范围、可验证的资料。'}{saved?.testedAt ? ` 检索测试通过于 ${date(saved.testedAt)}。` : ''}</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">
        <form id="knowledge-draft-form" onSubmit={event => { event.preventDefault(); void write('draft'); }} aria-busy={pending}><fieldset disabled={blocked || processing} className="min-w-0"><legend className="sr-only">知识草稿</legend><KnowledgeFields scope={scope} draft={content} stores={stores} isNew={isNew} onChange={(scope, content) => { setLocal({ scope, content, version: local?.version ?? document?.version ?? 0 }); setMessage(''); }}/></fieldset></form>
        {!valid && <p className="text-sm text-muted-foreground">请填写标题与内容。商品资料需指定店铺和商品，属性名称不能重复。</p>}
        {contentDirty && !isNew && <p className="text-sm text-muted-foreground">先保存修改，再索引和测试新草稿。</p>}
      </CardContent><CardFooter className="flex flex-wrap gap-2"><Button type="submit" form="knowledge-draft-form" disabled={locked || !contentDirty || !valid}>{pending && <Spinner/>}保存草稿</Button><Button variant="outline" disabled={locked || !capabilities.indexing || isNew || contentDirty || !saved || !['draft', 'failed'].includes(saved.status)} onClick={() => void submit('index')}>开始索引</Button><Button variant="outline" disabled={!canPublish} onClick={() => setConfirmation('publish')}>发布知识</Button></CardFooter></Card></TabsContent>
      <TabsContent value="tests" className="pt-4">{document && <KnowledgeReview companyId={companyId} id={id} revision={document.draftRevision} version={document.version} ready={saved?.status === 'ready' && !contentDirty} locked={locked || contentDirty || document.activeRevision === document.draftRevision} capable={capabilities.review} cases={cases} changed={testDirty} current={currentReview} date={date}
        onChange={cases => { setLocalCases(cases); setTestDirty(true); }} onSubmit={() => void submit('test')} onDiscard={() => { setLocalCases(null); setTestDirty(false); }} onError={refresh}/>}</TabsContent>
      <TabsContent value="versions" className="pt-4"><Card><CardHeader><CardTitle>版本记录</CardTitle><CardDescription>每次保存保留完整内容。恢复会创建新草稿，并需要重新索引、测试和发布。</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">{history.isError ? <ErrorNotice error={history.error}/> : history.isPending ? <p role="status">正在读取版本…</p> : history.data?.revisions.map(version => <div key={version.revision} className="flex flex-col gap-3 rounded-lg border p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">v{version.revision} · {version.title}</p><Button variant="outline" size="sm" disabled={locked || dirty || version.revision === saved?.revision} onClick={() => void write('restore', version.revision)}>将 v{version.revision} 恢复为草稿</Button></div><p className="text-xs text-muted-foreground">{date(version.createdAt)}{version.rollbackOf ? ` · 恢复自 v${version.rollbackOf}` : ''}</p><details><summary className="cursor-pointer text-sm">查看 v{version.revision} 的内容</summary><div className="pt-3"><KnowledgeSource source={version.source}/></div></details></div>)}</CardContent><CardFooter className="flex flex-wrap gap-2"><Button variant="ghost" disabled={history.isFetching} onClick={() => void history.refetch()}>刷新版本</Button>{before !== null && <Button variant="outline" onClick={() => setBefore(null)}>最近版本</Button>}{history.data?.nextBefore && <Button variant="outline" disabled={history.isFetching} onClick={() => setBefore(history.data!.nextBefore)}>较早版本</Button>}</CardFooter></Card></TabsContent>
    </Tabs>
    <Dialog open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }}><DialogContent><DialogHeader><DialogTitle>{confirmation === 'publish' ? '确认发布知识' : '撤回当前生效版本？'}</DialogTitle><DialogDescription>{confirmation === 'publish' ? `发布草稿 v${saved?.revision}。校验成功后，新检索才会使用此版本；执行期间保留原生效版本。` : '撤回后，新检索不再使用此资料。草稿和历史版本仍然保留，已生成的消息不会被修改。'}</DialogDescription></DialogHeader><p className="break-words text-sm font-medium">{confirmation === 'publish' ? saved?.title : active?.title}</p><DialogFooter><Button variant="outline" onClick={() => setConfirmation(null)}>返回核对</Button><Button disabled={confirmation === 'publish' ? !canPublish : locked} onClick={() => confirmation === 'publish' ? void submit('publish') : void write('withdraw')}>{confirmation === 'publish' ? '确认发布' : '确认撤回'}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
