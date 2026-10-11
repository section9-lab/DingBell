import { useCallback, useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { BookOpen, Plus } from 'lucide-react';
import type { KnowledgeFilters } from '../../shared/knowledge';
import { ApiError, type Company } from '../lib/api';
import { readKnowledgeList, type KnowledgeGap } from '../lib/knowledge-api';
import { readStores } from '../lib/stores-api';
import { KnowledgeEditor } from '../components/knowledge-editor';
import { KnowledgeProductImport } from '../components/knowledge-product-import';
import { KnowledgeFileImport } from '../components/knowledge-file-import';
import { KnowledgeGaps } from '../components/knowledge-gaps';
import { useWorkspaceExit } from '../components/workspace-exit';
import { knowledgeKinds, knowledgeLanguages, knowledgeStates } from '../components/knowledge-fields';
import { ErrorNotice } from '../components/identity-shared';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../components/ui/card';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from '../components/ui/empty';
import { Field, FieldGroup, FieldLabel } from '../components/ui/field';
import { NativeSelect, NativeSelectOption } from '../components/ui/native-select';
import { Spinner } from '../components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

export function KnowledgePage({ company, refresh }: { company: Company; refresh: (notice?: unknown) => Promise<void> }) {
  const [search, setSearch] = useSearchParams(), [newId, setNewId] = useState<string | null>(null);
  const [gapSeed, setGapSeed] = useState<KnowledgeGap | null>(null);
  const [filters, setFilters] = useState<KnowledgeFilters>({}), [after, setAfter] = useState('');
  const { setDirty, confirmExit: navigate } = useWorkspaceExit();
  const management = ['owner', 'admin'].includes(company.role), selectedId = newId ?? search.get('document');
  const importing = ['products', 'files'].includes(search.get('import') ?? '') ? search.get('import') : null;
  const list = useQuery({ queryKey: ['knowledge', company.id, filters, after], queryFn: ({ signal }) => readKnowledgeList(company.id, filters, after, signal), enabled: management, retry: false });
  const stores = useInfiniteQuery({ queryKey: ['knowledge-stores', company.id], queryFn: ({ pageParam, signal }) => readStores(company.id, pageParam, signal),
    initialPageParam: 0, getNextPageParam: page => page.nextOffset ?? undefined, enabled: management, retry: false });
  const storeRows = stores.data?.pages.flatMap(page => page.stores) ?? [];
  const resetEditor = useCallback(async (error?: unknown) => {
    if (error instanceof ApiError && error.code === 'NOT_FOUND') { setDirty(false); setNewId(null); setSearch({}, { replace: true }); }
    await refresh(error);
  }, [refresh, setSearch, setDirty]);
  useEffect(() => { if (newId && search.get('document') === newId) setNewId(null); }, [newId, search]);
  useEffect(() => { const error = list.error ?? stores.error; if (error instanceof ApiError && ['FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND'].includes(error.code)) void refresh(error); }, [list.error, stores.error, refresh]);
  function filter<K extends keyof KnowledgeFilters>(key: K, value: KnowledgeFilters[K]) { setFilters(current => ({ ...current, [key]: value })); setAfter(''); }
  return <>
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold tracking-tight">知识库</h1><p className="text-sm text-muted-foreground">维护商品事实与店铺政策，检索测试通过后再发布。</p></div>
      {management && <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => navigate(() => { setNewId(null); setGapSeed(null); setSearch({ view: 'gaps' }); })}>知识缺口</Button><Button variant="outline" onClick={() => navigate(() => { setNewId(null); setGapSeed(null); setSearch({ import: 'files' }); })}>从文件导入</Button><Button variant="outline" onClick={() => navigate(() => { setNewId(null); setGapSeed(null); setSearch({ import: 'products' }); })}>从商品导入</Button><Button onClick={() => navigate(() => { setGapSeed(null); setNewId(crypto.randomUUID()); setSearch({}); })}><Plus data-icon="inline-start"/>新建知识</Button></div>}
    </div>
    {!management ? <Alert><AlertTitle>需要管理员权限</AlertTitle><AlertDescription>知识的维护、测试与发布由公司所有者或管理员负责。客服在消息中心查看已授权的回答依据。</AlertDescription></Alert> : <>
      {list.data && !list.data.capabilities.indexing && <Alert><AlertTitle>索引服务尚未启用</AlertTitle><AlertDescription>可以保存和整理草稿。启用索引、检索测试及发布需要部署管理员完成服务配置。</AlertDescription></Alert>}
      {list.data?.capabilities.indexing && !list.data.capabilities.review && <Alert><AlertTitle>检索测试与发布尚未启用</AlertTitle><AlertDescription>可保存草稿并建立索引，发布前还需部署管理员配置检索测试与发布服务。</AlertDescription></Alert>}
      {stores.isError && <Alert><AlertTitle>店铺读取失败</AlertTitle><AlertDescription><p>请重新读取店铺后再修改知识范围。</p><Button variant="outline" onClick={() => void stores.refetch()}>重新读取店铺</Button></AlertDescription></Alert>}
      {stores.hasNextPage && <Button variant="outline" className="self-start" disabled={stores.isFetchingNextPage} onClick={() => void stores.fetchNextPage()}>加载更多店铺</Button>}
      {search.get('view')==='gaps' ? <div className="flex min-w-0 flex-col gap-4"><Button variant="ghost" className="self-start" onClick={()=>setSearch({})}>返回知识库</Button><KnowledgeGaps key={company.id} companyId={company.id} stores={storeRows} refresh={resetEditor} onOpen={(gap,reuse)=>navigate(()=>{setGapSeed(reuse?gap:null);setNewId(null);setSearch({document:gap.documentId});})}/></div> : importing ? <div className="flex min-w-0 flex-col gap-4"><Button variant="ghost" className="self-start" onClick={()=>navigate(()=>setSearch({}))}>返回知识库</Button>{importing==='files'
        ? <KnowledgeFileImport key={company.id} companyId={company.id} stores={storeRows} unavailable={stores.isError||stores.isPending} onOpen={id=>navigate(()=>setSearch({document:id}))} refresh={resetEditor}/>
        : <KnowledgeProductImport companyId={company.id} stores={storeRows} unavailable={stores.isError||stores.isPending} onOpen={id=>setSearch({document:id})} refresh={resetEditor}/>}</div> : selectedId ? <div className="flex min-w-0 flex-col gap-4">
        <Button variant="ghost" className="self-start" onClick={() => navigate(() => { setNewId(null); setSearch({}); })}>返回知识库</Button>
        {list.isError && <div className="flex flex-col gap-3"><ErrorNotice error={list.error}/><Button variant="outline" className="self-start" disabled={list.isFetching} onClick={() => void list.refetch()}>重新读取知识库配置</Button></div>}
        <KnowledgeEditor key={`${company.id}:${selectedId}:${gapSeed?.jobId ?? ''}:${gapSeed?.caseIndex ?? ''}`} companyId={company.id} id={selectedId} isNew={newId === selectedId} stores={storeRows}
          initialQuestion={gapSeed?.documentId===selectedId?{question:gapSeed.question,minimumScore:gapSeed.minimumScore}:undefined}
          unavailable={stores.isError || stores.isPending || list.isError || list.isPending} capabilities={list.data?.capabilities ?? { indexing: false, review: false }}
          onSaved={id => { if (newId === id) setDirty(false); setSearch({ document: id }, { replace: true }); }} onDirty={setDirty} refresh={resetEditor}/>
      </div> : <Card><CardHeader><CardTitle>知识资料</CardTitle><CardDescription>草稿独立保存，已发布版本继续生效，直到新版本发布或撤回。</CardDescription></CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-5">
          <FieldGroup className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Field><FieldLabel htmlFor="knowledge-filter-kind">知识类型筛选</FieldLabel><NativeSelect id="knowledge-filter-kind" value={filters.kind ?? ''} onChange={e => filter('kind', e.target.value as KnowledgeFilters['kind'] || undefined)}><NativeSelectOption value="">全部类型</NativeSelectOption>{Object.entries(knowledgeKinds).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
            <Field><FieldLabel htmlFor="knowledge-filter-store">适用店铺筛选</FieldLabel><NativeSelect id="knowledge-filter-store" value={filters.storeId === undefined ? '*' : filters.storeId ?? ''} onChange={e => filter('storeId', e.target.value === '*' ? undefined : e.target.value || null)}><NativeSelectOption value="*">全部范围</NativeSelectOption><NativeSelectOption value="">公司通用</NativeSelectOption>{storeRows.map(store => <NativeSelectOption key={store.id} value={store.id}>{store.name}</NativeSelectOption>)}</NativeSelect></Field>
            <Field><FieldLabel htmlFor="knowledge-filter-language">语言筛选</FieldLabel><NativeSelect id="knowledge-filter-language" value={filters.language ?? ''} onChange={e => filter('language', e.target.value as KnowledgeFilters['language'] || undefined)}><NativeSelectOption value="">全部语言</NativeSelectOption>{Object.entries(knowledgeLanguages).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
            <Field><FieldLabel htmlFor="knowledge-filter-publication">发布状态筛选</FieldLabel><NativeSelect id="knowledge-filter-publication" value={filters.publication ?? ''} onChange={e => filter('publication', e.target.value as KnowledgeFilters['publication'] || undefined)}><NativeSelectOption value="">全部状态</NativeSelectOption><NativeSelectOption value="published">已发布</NativeSelectOption><NativeSelectOption value="unpublished">未发布</NativeSelectOption></NativeSelect></Field>
          </FieldGroup>
          {list.isError ? <ErrorNotice error={list.error}/> : list.isPending ? <p role="status" className="flex items-center gap-2"><Spinner/>正在读取知识…</p> : list.data?.documents.length ? <Table><TableHeader><TableRow><TableHead>知识</TableHead><TableHead>适用范围</TableHead><TableHead>草稿状态</TableHead><TableHead>生效版本</TableHead></TableRow></TableHeader><TableBody>
            {list.data.documents.map(row => <TableRow key={row.id}><TableCell><Button variant="link" className="h-auto max-w-64 justify-start whitespace-normal p-0 text-left" aria-label={`编辑知识：${row.title}`} onClick={() => setSearch({ document: row.id })}>{row.title}</Button><p className="mt-1 text-xs text-muted-foreground">{knowledgeKinds[row.kind]} · {knowledgeLanguages[row.language]}</p></TableCell><TableCell className="max-w-52 whitespace-normal break-words">{row.storeId ? storeRows.find(store => store.id === row.storeId)?.name ?? '店铺资料' : '公司通用'}{row.productRef && <p className="text-xs text-muted-foreground">商品：{row.productRef}</p>}</TableCell><TableCell><Badge variant="outline">v{row.draftRevision} · {knowledgeStates[row.status]}</Badge></TableCell><TableCell><Badge variant={row.activeRevision ? 'secondary' : 'outline'}>{row.activeRevision ? `已发布 v${row.activeRevision}` : '未发布'}</Badge></TableCell></TableRow>)}
          </TableBody></Table> : <Empty><EmptyHeader><EmptyMedia variant="icon"><BookOpen/></EmptyMedia><EmptyTitle>没有匹配的知识</EmptyTitle><EmptyDescription>调整筛选，或新建一条商品资料、使用说明或店铺政策。</EmptyDescription></EmptyHeader></Empty>}
        </CardContent><CardFooter className="flex flex-wrap gap-2"><Button variant="ghost" disabled={list.isFetching} onClick={() => void list.refetch()}>刷新列表</Button>{after && <Button variant="outline" onClick={() => setAfter('')}>第一页</Button>}{list.data?.nextAfter && <Button variant="outline" disabled={list.isFetching} onClick={() => setAfter(list.data!.nextAfter!)}>下一页</Button>}</CardFooter>
      </Card>}
    </>}
  </>;
}
