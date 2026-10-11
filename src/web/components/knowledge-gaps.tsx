import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { KnowledgeGapFilters } from '../../shared/knowledge-gaps';
import { ApiError } from '../lib/api';
import { readKnowledgeGaps, type KnowledgeGap } from '../lib/knowledge-api';
import type { StoreRecord } from '../lib/stores-api';
import { useCompanySettings } from './company-settings-provider';
import { knowledgeKinds, knowledgeLanguages } from './knowledge-fields';
import { ErrorNotice } from './identity-shared';
import { Alert, AlertTitle, AlertDescription } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './ui/card';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from './ui/empty';
import { Field, FieldGroup, FieldLabel } from './ui/field';
import { NativeSelect, NativeSelectOption } from './ui/native-select';
import { Spinner } from './ui/spinner';

const states = { pending: '待核对', retested: '草稿复测通过', published: '对应版本已发布' };
export function KnowledgeGaps({ companyId, stores, onOpen, refresh }: { companyId: string; stores: StoreRecord[];
  onOpen: (gap: KnowledgeGap, reuse: boolean) => void; refresh: (error?: unknown) => Promise<void> }) {
  const [filters, setFilters] = useState<KnowledgeGapFilters>({ state: 'pending', after: '' });
  const { date } = useCompanySettings();
  const query = useQuery({ queryKey: ['knowledge-gaps', companyId, filters], queryFn: ({ signal }) => readKnowledgeGaps(companyId, filters, signal), retry: false, gcTime: 0 });
  useEffect(() => { if (query.error instanceof ApiError && ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND'].includes(query.error.code)) void refresh(query.error); }, [query.error, refresh]);
  function filter<K extends keyof KnowledgeGapFilters>(key: K, value: KnowledgeGapFilters[K]) { setFilters(current => ({ ...current, [key]: value, after: '' })); }
  return <div className="flex min-w-0 flex-col gap-4">
    <Alert><AlertTitle>先核对资料与测试要求，再修订知识</AlertTitle><AlertDescription>这里汇总已保存且未达到预期的检索测试问题，每条对应一次测试。它们不等同于客户投诉或已确认的内容缺失；模型和索引服务异常不计入。复测通过后，仍需单独发布。</AlertDescription></Alert>
    <Card><CardHeader><CardTitle>知识缺口</CardTitle><CardDescription>编辑资料、重新索引后，可带入原问题复测。新版本必须重新选择预期片段；降低分值要求不会使原记录自动达标。</CardDescription></CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-5"><FieldGroup className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Field><FieldLabel htmlFor="gap-state">知识缺口状态</FieldLabel><NativeSelect id="gap-state" value={filters.state ?? ''} onChange={event => filter('state', event.target.value as KnowledgeGapFilters['state'] || undefined)}><NativeSelectOption value="">全部状态</NativeSelectOption>{Object.entries(states).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
        <Field><FieldLabel htmlFor="gap-store">缺口适用店铺</FieldLabel><NativeSelect id="gap-store" value={filters.storeId === undefined ? '*' : filters.storeId ?? ''} onChange={event => filter('storeId', event.target.value === '*' ? undefined : event.target.value || null)}><NativeSelectOption value="*">全部范围</NativeSelectOption><NativeSelectOption value="">公司通用</NativeSelectOption>{stores.map(store => <NativeSelectOption key={store.id} value={store.id}>{store.name}</NativeSelectOption>)}</NativeSelect></Field>
        <Field><FieldLabel htmlFor="gap-language">缺口知识语言</FieldLabel><NativeSelect id="gap-language" value={filters.language ?? ''} onChange={event => filter('language', event.target.value as KnowledgeGapFilters['language'] || undefined)}><NativeSelectOption value="">全部语言</NativeSelectOption>{Object.entries(knowledgeLanguages).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
        <Field><FieldLabel htmlFor="gap-kind">缺口知识类型</FieldLabel><NativeSelect id="gap-kind" value={filters.kind ?? ''} onChange={event => filter('kind', event.target.value as KnowledgeGapFilters['kind'] || undefined)}><NativeSelectOption value="">全部类型</NativeSelectOption>{Object.entries(knowledgeKinds).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
      </FieldGroup>
      <div data-testid="knowledge-gap-list" className="flex min-w-0 flex-col gap-5">{query.isError ? <ErrorNotice error={query.error}/> : query.isPending ? <p role="status" className="flex items-center gap-2"><Spinner/>正在读取测试问题…</p> : query.data?.gaps.length ? query.data.gaps.map(gap => <section key={`${gap.jobId}:${gap.caseIndex}`} className="flex min-w-0 flex-col gap-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3"><h3 className="min-w-0 break-words text-sm font-medium">{gap.question}</h3><Badge variant="outline">{states[gap.state]}</Badge></div>
        <p className="break-words text-sm text-muted-foreground">{gap.title} · 测试版本 v{gap.revision} · {knowledgeLanguages[gap.language]} · {gap.storeId ? stores.find(store => store.id === gap.storeId)?.name ?? '店铺知识' : '公司通用'}</p>
        <p className="text-xs text-muted-foreground">原测试要求 ≥ {gap.minimumScore} · 预期片段{gap.observedScore === null ? '未返回' : `得分 ${gap.observedScore}`} · {date(new Date(gap.createdAt).toISOString())}</p>
        {gap.proof && <p className="text-sm">复测依据：v{gap.proof.revision} 的同一问题达到原分值要求。{gap.state === 'retested' ? '该通过版本尚未发布。' : '当前生效版本与复测版本一致。'}</p>}
        <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => onOpen(gap, false)}>编辑知识</Button>{gap.state !== 'published' && <Button variant="secondary" onClick={() => onOpen(gap, true)}>用此问题复测</Button>}</div>
      </section>) : <Empty><EmptyHeader><EmptyTitle>当前筛选下没有记录</EmptyTitle><EmptyDescription>这里显示检索测试问题，空列表不代表所有客户问题都能得到回答。</EmptyDescription></EmptyHeader></Empty>}</div>
      </CardContent><CardFooter className="flex flex-wrap gap-2"><Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>刷新缺口</Button>{filters.after && <Button variant="outline" onClick={() => setFilters(current => ({ ...current, after: '' }))}>第一页</Button>}{query.data?.nextAfter && <Button variant="outline" disabled={query.isFetching} onClick={() => setFilters(current => ({ ...current, after: query.data!.nextAfter! }))}>下一页</Button>}</CardFooter>
    </Card>
  </div>;
}
