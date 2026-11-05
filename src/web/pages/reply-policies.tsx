import { useCallback, useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { ArrowRight, Bell, Info, MessageSquare, Plus, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { ApiError, type Company } from '../lib/api';
import { readReplyPolicies, type PolicyKind } from '../lib/reply-policies-api';
import { storesInfiniteQueryKey } from '../lib/query-keys';
import { readStores } from '../lib/stores-api';
import { ReplyPolicyEditor } from '../components/reply-policy-editor';
import { useCompanySettings } from '../components/company-settings-provider';
import { ErrorNotice } from '../components/identity-shared';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../components/ui/dialog';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from '../components/ui/empty';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '../components/ui/sheet';
import { Spinner } from '../components/ui/spinner';
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from '../components/ui/table';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';

export function ReplyPoliciesPage({ company, refresh }: { company: Company; refresh: (notice?: unknown) => Promise<void> }) {
  const [search, setSearch] = useSearchParams();
  const kind: PolicyKind = search.get('kind') === 'notification' ? 'notification' : 'automatic';
  const [newId, setNewId] = useState<string | null>(null);
  const [after, setAfter] = useState('');
  const [dirty, setDirty] = useState(false);
  const [next, setNext] = useState<(() => void) | null>(null);
  const { date } = useCompanySettings();
  const management = ['owner', 'admin'].includes(company.role);
  const selectedId = newId ?? search.get('policy');
  const list = useQuery({ queryKey: ['reply-policies', company.id, kind, after], queryFn: ({ signal }) => readReplyPolicies(company.id, kind, after, signal), enabled: management, retry: false });
  const stores = useInfiniteQuery({ queryKey: storesInfiniteQueryKey(company.id), queryFn: ({ pageParam, signal }) => readStores(company.id, pageParam, signal), initialPageParam: 0,
    getNextPageParam: page => page.nextOffset ?? undefined, enabled: management && !!selectedId, retry: false });
  const storeRows = stores.data?.pages.flatMap(page => page.stores) ?? [];
  const resetEditor = useCallback(async (error?: unknown) => {
    if (error instanceof ApiError && error.code === 'NOT_FOUND') { setNewId(null); setSearch({ kind }, { replace: true }); }
    await refresh(error);
  }, [kind, refresh, setSearch]);
  // Keep the new editor mounted until the router has committed its saved ID.
  useEffect(() => { if (newId && search.get('policy') === newId) setNewId(null); }, [newId, search]);
  useEffect(() => { const error = list.error ?? stores.error; if (error instanceof ApiError && ['FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND'].includes(error.code)) void refresh(error); }, [list.error, stores.error, refresh]);
  function navigate(action: () => void) { if (dirty) setNext(() => action); else action(); }
  function closeEditor() { navigate(() => { setNewId(null); setSearch({ kind }); }); }
  function createPolicy() { navigate(() => { setNewId(crypto.randomUUID()); setSearch({ kind }); }); }
  function changeKind(value: PolicyKind) { navigate(() => { setNewId(null); setAfter(''); setSearch({ kind: value }); }); }

  return <>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-2"><h1 className="text-2xl font-semibold tracking-tight">回复策略</h1><p className="text-sm text-muted-foreground">设置 AI 如何接待消费者，以及何时发送订单通知。</p></div>
      {management && <Button onClick={createPolicy}><Plus data-icon="inline-start" />新建策略</Button>}
    </div>
    {!management ? <Alert><AlertTitle>需要管理员权限</AlertTitle><AlertDescription>当前账号可以处理被授权的消费者会话。回复策略由公司所有者或管理员配置和发布。</AlertDescription></Alert> : <>
      <Tabs value={kind} onValueChange={value => changeKind(value as PolicyKind)} className="gap-6">
        <TabsList variant="line" className="w-full justify-start border-b pb-2">
          <TabsTrigger value="automatic" className="flex-none px-3"><MessageSquare />自动回复</TabsTrigger>
          <TabsTrigger value="notification" className="flex-none px-3"><Bell />主动通知</TabsTrigger>
        </TabsList>
        <TabsContent value={kind} className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1"><h2 className="font-medium">{kind === 'automatic' ? '自动回复策略' : '主动通知策略'}</h2><p className="text-sm text-muted-foreground">{kind === 'automatic' ? '按店铺和业务阶段匹配，回复方式决定 AI 是生成建议还是自动发送。' : '按订单阶段配置触发条件与通知内容，保存即可启用。'}</p></div>
            <Button variant="ghost" size="icon" aria-label="刷新列表" disabled={list.isFetching} onClick={() => void list.refetch()}><RefreshCw className={list.isFetching ? 'animate-spin' : ''} /></Button>
          </div>
          <div className="overflow-hidden rounded-xl border">
            {list.isError ? <div className="p-6"><ErrorNotice error={list.error} /><Button variant="outline" className="mt-4" onClick={() => void list.refetch()}>重新读取策略</Button></div>
              : list.isPending ? <p role="status" className="flex items-center justify-center gap-2 p-12 text-muted-foreground"><Spinner />正在读取策略…</p>
              : list.data?.policies.length ? <Table>
                <TableHeader className="bg-muted/40"><TableRow><TableHead className="pl-5">策略名称</TableHead><TableHead>状态</TableHead><TableHead className="hidden sm:table-cell">当前版本</TableHead><TableHead className="hidden lg:table-cell">更新时间</TableHead><TableHead><span className="sr-only">操作</span></TableHead></TableRow></TableHeader>
                <TableBody>{list.data.policies.map(policy => <TableRow key={policy.id}>
                  <TableCell className="max-w-40 py-5 pl-5 sm:max-w-64"><Button variant="link" className="h-auto max-w-full justify-start p-0 text-left font-medium" aria-label={`编辑策略：${policy.name}`} onClick={() => navigate(() => { setNewId(null); setSearch({ kind, policy: policy.id }); })}><span className="truncate">{policy.name}</span></Button><p className="mt-1 text-xs text-muted-foreground sm:hidden">{policy.publishedRevision ? `v${policy.publishedRevision}` : '未启用'}</p></TableCell>
                  <TableCell><Badge variant={policy.enabled ? 'secondary' : 'outline'}>{policy.enabled ? '已启用' : policy.publishedRevision ? '已暂停' : '未启用'}</Badge></TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">{policy.publishedRevision ? `v${policy.publishedRevision}` : '—'}</TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">{date(policy.updatedAt)}</TableCell>
                  <TableCell className="pr-4 text-right"><Button variant="ghost" size="icon-sm" aria-label={`打开策略：${policy.name}`} onClick={() => navigate(() => { setNewId(null); setSearch({ kind, policy: policy.id }); })}><ArrowRight /></Button></TableCell>
                </TableRow>)}</TableBody>
              </Table> : <Empty className="py-16"><EmptyHeader><EmptyMedia variant="icon"><SlidersHorizontal /></EmptyMedia><EmptyTitle>{kind === 'automatic' ? '创建第一条自动回复策略' : '创建第一条主动通知策略'}</EmptyTitle><EmptyDescription>还没有此类策略。创建后选择适用范围，保存即可生效。</EmptyDescription></EmptyHeader><Button variant="outline" onClick={createPolicy}><Plus />创建策略</Button></Empty>}
            {(after || list.data?.nextAfter) && <div className="flex justify-end gap-2 border-t p-3">{after && <Button variant="ghost" disabled={list.isFetching} onClick={() => setAfter('')}>第一页</Button>}{list.data?.nextAfter && <Button variant="outline" disabled={list.isFetching} onClick={() => { const cursor = list.data?.nextAfter; if (cursor) setAfter(cursor); }}>下一页</Button>}</div>}
          </div>
          <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><Info className="mt-0.5 size-4 shrink-0" /><p>保存时自动校验适用范围和规则冲突，通过后立即生效。{kind === 'automatic' ? '仅生成建议的策略不会自动发送消息。' : '通知是否可执行，仍取决于店铺的平台能力。'}</p></div>
        </TabsContent>
      </Tabs>
      <Sheet open={!!selectedId} onOpenChange={open => { if (!open) closeEditor(); }}>
        <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
          <SheetHeader className="shrink-0 gap-1 border-b px-6 py-5 pr-14"><SheetTitle>{newId ? '新建策略' : '编辑策略'}</SheetTitle><SheetDescription>{kind === 'automatic' ? '自动回复' : '主动通知'} · 保存即生效，历史版本自动保留</SheetDescription></SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col">
            {stores.isPending && <p role="status" className="flex items-center gap-2 border-b px-6 py-3 text-sm text-muted-foreground"><Spinner />正在读取适用店铺…</p>}
            {(stores.isError || stores.hasNextPage) && <div className="shrink-0 border-b p-4">
              {stores.isError && <Alert><AlertTitle>店铺读取失败</AlertTitle><AlertDescription><p>策略操作已暂时锁定，请先重新读取店铺。</p><Button variant="outline" onClick={() => void stores.refetch()}>重新读取店铺</Button></AlertDescription></Alert>}
              {stores.hasNextPage && <Button variant="outline" disabled={stores.isFetchingNextPage} onClick={() => void stores.fetchNextPage()}>载入更多店铺</Button>}
            </div>}
            {selectedId && <ReplyPolicyEditor key={selectedId} companyId={company.id} id={selectedId} kind={kind} isNew={newId !== null && search.get('policy') !== newId} stores={storeRows} storesUnavailable={stores.isError || stores.isPending || list.isError} onDirty={setDirty} onClose={closeEditor} onSaved={id => { setSearch({ kind, policy: id }, { replace: true }); }} refresh={resetEditor} />}
          </div>
        </SheetContent>
      </Sheet>
    </>}
    <Dialog open={next !== null} onOpenChange={open => { if (!open) setNext(null); }}><DialogContent><DialogHeader><DialogTitle>放弃未保存的修改？</DialogTitle><DialogDescription>当前策略还有未保存的内容。关闭或切换将丢失这些修改。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setNext(null)}>继续编辑</Button><Button onClick={() => { next?.(); setNext(null); setDirty(false); }}>放弃并继续</Button></DialogFooter></DialogContent></Dialog>
  </>;
}
