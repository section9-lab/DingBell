import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as v from 'valibot';
import { knowledgeTestCasesSchema, type KnowledgeTestCases } from '../../shared/knowledge';
import { readKnowledgeReviews, readKnowledgeTestInputs, type KnowledgeIndexJob, type KnowledgeOperation, type KnowledgeReviewJob } from '../lib/knowledge-api';
import { ApiError } from '../lib/api';
import { ErrorNotice } from './identity-shared';
import { knowledgeJobActive, knowledgeJobKinds, knowledgeJobStates } from './knowledge-fields';
import { Alert, AlertTitle, AlertDescription } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './ui/card';
import { Field, FieldGroup, FieldLabel, FieldDescription } from './ui/field';
import { Input } from './ui/input';
import { NativeSelect, NativeSelectOption } from './ui/native-select';
import { Spinner } from './ui/spinner';
import { Textarea } from './ui/textarea';

export const emptyKnowledgeCases = (): KnowledgeTestCases => [{ question: '', expectedChunkId: '', minimumScore: 0 }];
export function KnowledgeJobStatus({ operation, job, error, fetching, onRead }: { operation: KnowledgeOperation; job?: KnowledgeIndexJob | KnowledgeReviewJob;
  error: unknown; fetching: boolean; onRead: () => void }) {
  return <Alert data-testid="knowledge-operation"><AlertTitle className="flex flex-wrap items-center gap-2">{knowledgeJobKinds[operation.kind]}任务 {job ? knowledgeJobStates[job.state] : '正在确认状态'}{knowledgeJobActive(job?.state) && <Spinner/>}</AlertTitle>
    <AlertDescription>
      {job && <p>草稿 v{job.revision}。{knowledgeJobActive(job.state) ? '任务已保存，离开或刷新页面后仍可回来查看。' : job.state === 'succeeded' ? operation.kind === 'publish' ? '发布校验已完成，请查看下方生效版本。' : operation.kind === 'test' ? '检索测试通过。请核对内容后单独发布。' : '索引完成。下一步使用真实业务问题做检索测试。'
        : job.state === 'unknown' ? '本次调用结果尚未确认，系统不会自动重复调用。请先读取最新状态。' : job.state === 'cancelled' ? '资料或权限发生变化，此任务已停止。请读取最新资料。' : '任务未通过。请检查内容与测试结果，读取最新版本后再操作。'}</p>}
      {error != null && <ErrorNotice error={error}/>}
      <Button variant="outline" className="self-start" disabled={fetching} onClick={onRead}>刷新任务状态</Button>
    </AlertDescription>
  </Alert>;
}
function TestResults({ job }: { job: KnowledgeReviewJob }) {
  return <div className="flex flex-col gap-3">{job.cases?.map((item, index) => <div key={index} className="flex flex-col gap-1 text-sm">
    <p className="break-words font-medium">{index + 1}. {item.question}</p>
    <p className="text-muted-foreground">最低匹配分值：{item.minimumScore} · {job.results ? job.results.cases[index].passed ? '命中预期片段' : '未达到预期' : '暂无检索结果'}</p>
    {job.results && <p className="text-muted-foreground">返回 {job.results.cases[index].matches.length} 个候选片段{job.results.cases[index].matches.length ? `，匹配分值：${job.results.cases[index].matches.map(match => match.score.toFixed(3)).join(' / ')}` : ''}。</p>}
  </div>)}</div>;
}
export function KnowledgeReview({ companyId, id, revision, version, ready, locked, capable, cases, changed, current, date, onChange, onSubmit, onDiscard, onError }:
  { companyId: string; id: string; revision: number; version: number; ready: boolean; locked: boolean; capable: boolean;
    cases: KnowledgeTestCases; changed: boolean; current?: KnowledgeReviewJob; date: (ms: number) => string; onChange: (cases: KnowledgeTestCases) => void;
    onSubmit: () => void; onDiscard: () => void; onError: (error: unknown) => void }) {
  const [after, setAfter] = useState('');
  const inputs = useQuery({ queryKey: ['knowledge-inputs', companyId, id, revision, version], queryFn: ({ signal }) => readKnowledgeTestInputs(companyId, id, signal), enabled: ready, retry: false, gcTime: 0 });
  const history = useQuery({ queryKey: ['knowledge-reviews', companyId, id, after], queryFn: ({ signal }) => readKnowledgeReviews(companyId, id, after, signal), retry: false, gcTime: 0 });
  useEffect(() => { const error = inputs.error ?? history.error; if (error instanceof ApiError && ['FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND'].includes(error.code)) onError(error); }, [inputs.error, history.error, onError]);
  const matchesVersion = inputs.data?.revision === revision && inputs.data.documentVersion === version;
  const valid = v.safeParse(knowledgeTestCasesSchema, cases).success && cases.every(item => inputs.data?.chunks.some(chunk => chunk.id === item.expectedChunkId));
  function change(index: number, patch: Partial<KnowledgeTestCases[number]>) { onChange(cases.map((row, i) => i === index ? { ...row, ...patch } : row)); }
  return <div className="flex min-w-0 flex-col gap-4">
    <Card><CardHeader><CardTitle>检索测试</CardTitle><CardDescription>填写消费者可能提出的问题，并选择应命中的资料片段。问题随测试任务保存，每次最多 5 条。</CardDescription></CardHeader><CardContent className="flex flex-col gap-5">
      {!ready ? <p className="text-sm text-muted-foreground">请先保存草稿并完成索引，再测试当前版本。</p> : inputs.isError ? <ErrorNotice error={inputs.error}/> : inputs.isPending ? <p role="status"><Spinner/>正在读取测试片段…</p> : <>
        <details><summary className="cursor-pointer text-sm font-medium">查看当前草稿的 {inputs.data?.chunks.length} 个片段</summary><div className="flex flex-col gap-4 pt-4">{inputs.data?.chunks.map(chunk => <div key={chunk.id}><p className="text-sm font-medium">片段 {chunk.ordinal + 1}</p><p className="break-words whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{chunk.body}</p></div>)}</div></details>
        {!matchesVersion && <Alert><AlertTitle>测试资料版本已变化</AlertTitle><AlertDescription>请读取最新知识版本，再选择当前资料的预期片段。</AlertDescription></Alert>}
        <fieldset disabled={locked} className="flex min-w-0 flex-col gap-5"><legend className="sr-only">检索测试问题</legend>
          {cases.map((item, index) => <FieldGroup key={index} className="gap-4 rounded-lg border p-4">
            <Field><FieldLabel htmlFor={`knowledge-question-${index}`}>测试问题 {index + 1}</FieldLabel><Textarea id={`knowledge-question-${index}`} value={item.question} onChange={event => change(index, { question: event.target.value })}/></Field>
            <FieldGroup className="grid gap-4 sm:grid-cols-2">
              <Field><FieldLabel htmlFor={`knowledge-expected-${index}`}>预期片段 {index + 1}</FieldLabel><NativeSelect id={`knowledge-expected-${index}`} value={inputs.data?.chunks.some(chunk => chunk.id === item.expectedChunkId) ? item.expectedChunkId : ''} onChange={event => change(index, { expectedChunkId: event.target.value })}><NativeSelectOption value="">请选择应命中的片段</NativeSelectOption>{inputs.data?.chunks.map(chunk => <NativeSelectOption key={chunk.id} value={chunk.id}>片段 {chunk.ordinal + 1} · {chunk.body.slice(0, 48)}</NativeSelectOption>)}</NativeSelect></Field>
              <Field><FieldLabel htmlFor={`knowledge-score-${index}`}>最低匹配分值 {index + 1}</FieldLabel><Input id={`knowledge-score-${index}`} type="number" min="0" max="1" step="0.01" value={Number.isNaN(item.minimumScore) ? '' : item.minimumScore} onChange={event => change(index, { minimumScore: event.target.value === '' ? NaN : Number(event.target.value) })}/></Field>
            </FieldGroup><Button variant="ghost" className="self-start" disabled={cases.length === 1} aria-label={`删除测试问题 ${index + 1}`} onClick={() => onChange(cases.filter((_, i) => i !== index))}>删除问题</Button>
          </FieldGroup>)}
          <Button variant="outline" className="self-start" disabled={cases.length >= 5} onClick={() => onChange([...cases, ...emptyKnowledgeCases()])}>添加测试问题</Button>
        </fieldset>
        <FieldDescription>预期片段须出现在前 3 个候选中，且达到设定分值。0 表示不额外提高分值门槛。匹配分值不是回答准确率；此测试不生成客户回复。</FieldDescription>
        {!valid && <p className="text-sm text-muted-foreground">请填写不同的问题、选择当前版本的片段，并填写 0 至 1 的分值。每题最多 2400 字节。</p>}
      </>}
      {current?.kind === 'test' && <div data-testid="knowledge-test-results" className="flex flex-col gap-3 border-t pt-4"><p className="text-sm font-medium">本次测试 · v{current.revision} · {knowledgeJobStates[current.state]}</p><TestResults job={current}/></div>}
    </CardContent><CardFooter className="flex flex-wrap gap-2"><Button disabled={locked || !capable || !ready || !matchesVersion || !valid || inputs.isFetching || inputs.isError} onClick={onSubmit}>运行检索测试</Button>{changed && <Button variant="ghost" disabled={locked} onClick={onDiscard}>放弃测试修改</Button>}{inputs.isError && <Button variant="outline" onClick={() => void inputs.refetch()}>重新读取片段</Button>}</CardFooter></Card>
    <Card><CardHeader><CardTitle>测试与发布记录</CardTitle><CardDescription>显示持久保存的任务及时间，可复用历史问题。复用后请重新核对当前版本的预期片段。</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">
      {history.isError ? <ErrorNotice error={history.error}/> : history.isPending ? <p role="status">正在读取记录…</p> : !history.data?.jobs.length ? <p className="text-sm text-muted-foreground">尚无测试或发布记录。</p> : history.data.jobs.map(job => <details key={job.id} className="rounded-lg border p-4"><summary className="cursor-pointer text-sm"><span className="mr-2 font-medium">{knowledgeJobKinds[job.kind]} · v{job.revision}</span><Badge variant="outline">{knowledgeJobStates[job.state]}</Badge><span className="mt-1 block text-muted-foreground">{date(job.createdAt)}</span></summary><div className="flex flex-col gap-3 pt-4"><TestResults job={job}/>{job.cases && <Button variant="outline" className="self-start" disabled={locked} onClick={() => onChange(job.cases!.map(item => ({ ...item, expectedChunkId: inputs.data?.chunks.some(chunk => chunk.id === item.expectedChunkId) ? item.expectedChunkId : '' })))}>使用这些测试问题</Button>}</div></details>)}
    </CardContent><CardFooter className="flex flex-wrap gap-2"><Button variant="ghost" disabled={history.isFetching} onClick={() => void history.refetch()}>刷新记录</Button>{after && <Button variant="outline" onClick={() => setAfter('')}>首批记录</Button>}{history.data?.nextAfter && <Button variant="outline" disabled={history.isFetching} onClick={() => setAfter(history.data!.nextAfter!)}>更多记录</Button>}</CardFooter></Card>
  </div>;
}
