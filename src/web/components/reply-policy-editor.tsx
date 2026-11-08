import { LoadingState } from './query-state';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as v from 'valibot';
import { ChevronDown, History } from 'lucide-react';
import { replyPolicyConfigSchema, type ReplyPolicyConfig } from '../../shared/reply-policy';
import { ApiError } from '../lib/api';
import { readReplyPolicy, readPolicyVersions, saveReplyPolicy, updateReplyPolicy, type PolicyKind } from '../lib/reply-policies-api';
import type { StoreRecord } from '../lib/stores-api';
import { useCompanySettings } from './company-settings-provider';
import { ErrorNotice } from './identity-shared';
import { defaultPolicy, PolicyFields, PolicySummary } from './reply-policy-fields';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';

type Props = { companyId: string; id: string; kind: PolicyKind; isNew: boolean; stores: StoreRecord[]; storesUnavailable: boolean;
  onSaved: (id: string) => void; onDirty: (dirty: boolean) => void; onClose: () => void; refresh: (error?: unknown) => Promise<void> };
const accessDenied = (error: unknown) => error instanceof ApiError && ['FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND'].includes(error.code);
export function ReplyPolicyEditor({ companyId, id, kind, isNew, stores, storesUnavailable, onSaved, onDirty, onClose, refresh }: Props) {
  const client = useQueryClient(), { timeZone, date, query: settings } = useCompanySettings();
  const queryKey = ['reply-policy', companyId, id];
  const query = useQuery({ queryKey, queryFn: ({ signal }) => readReplyPolicy(companyId, id, signal), enabled: !isNew, gcTime: 0 });
  const [local, setLocal] = useState<{ config: ReplyPolicyConfig; version: number } | null>(() => isNew ? { config: defaultPolicy(kind), version: 0 } : null);
  const [pending, setPending] = useState(false), busy = useRef(false), mounted = useRef(false);
  const [review, setReview] = useState(false), [reread, setReread] = useState(false);
  const [error, setError] = useState<unknown>(), [message, setMessage] = useState('');
  const [before, setBefore] = useState<number | null>(null), [historyOpen, setHistoryOpen] = useState(false);
  const history = useQuery({ queryKey: ['reply-policy-history', companyId, id, before], queryFn: ({ signal }) => readPolicyVersions(companyId, id, before!, signal), enabled: before !== null && !isNew, gcTime: 0 });
  const data = query.data, policy = data?.policy;
  const savedConfig = policy?.published?.config ?? policy?.draft;
  const config = local?.config ?? savedConfig;
  const dirty = !!local && (isNew || JSON.stringify(local.config) !== JSON.stringify(savedConfig));
  const conflict = !!local && !!policy && local.version !== policy.version;
  const blocked = pending || storesUnavailable || settings.isError || settings.isPending || (!isNew && (query.isFetching || query.isError));
  const locked = blocked || review || conflict;
  const validation = config ? v.safeParse(replyPolicyConfigSchema, config) : null;
  const versions = before === null ? data?.history : history.data;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  useEffect(() => { const error = query.error ?? history.error; if (accessDenied(error)) void refresh(error); }, [query.error, history.error, refresh]);
  async function readLatest() {
    if (busy.current) return;
    busy.current = true; setPending(true); setReread(false);
    try {
      await client.cancelQueries({ queryKey }); const latest = await readReplyPolicy(companyId, id);
      if (!mounted.current) return;
      await client.cancelQueries({ queryKey }); if (!mounted.current) return;
      client.setQueryData(queryKey, latest); await settings.refetch(); if (!mounted.current) return;
      setReread(true);
      if (isNew) { setLocal(null); onSaved(id); }
      void client.invalidateQueries({ queryKey: ['reply-policies', companyId] });
    } catch (cause) {
      if (!mounted.current) return;
      if (accessDenied(cause) && !(isNew && cause instanceof ApiError && cause.code === 'NOT_FOUND')) { await refresh(cause); return; }
      setError(cause); if (isNew && cause instanceof ApiError && cause.code === 'NOT_FOUND') setReread(true);
    } finally { busy.current = false; if (mounted.current) setPending(false); }
  }
  async function write(action: 'save' | 'pause') {
    if (busy.current || locked || !config || (action === 'save' && !validation?.success)) return;
    busy.current = true; setPending(true); setError(undefined); setMessage('');
    try {
      await client.cancelQueries({ queryKey });
      const expectedVersion = local?.version ?? policy?.version ?? 0;
      const result = action === 'save' ? await saveReplyPolicy(companyId, id, expectedVersion, v.parse(replyPolicyConfigSchema, config))
        : await updateReplyPolicy(companyId, id, 'pause', { expectedVersion });
      if (!mounted.current) return;
      await client.cancelQueries({ queryKey }); if (!mounted.current) return;
      client.setQueryData(queryKey, result);
      setLocal(action === 'pause' && dirty ? { config, version: result.policy.version } : null);
      setBefore(null); setReview(false); setReread(false); onSaved(id);
      void client.invalidateQueries({ queryKey: ['reply-policies', companyId] });
      setMessage(action === 'save' ? '策略已保存并生效。' : '策略已暂停，不再匹配新任务。');
    } catch (cause) {
      if (!mounted.current) return;
      if (accessDenied(cause)) { await refresh(cause); return; }
      setError(cause);
      if (!(cause instanceof ApiError) || ['OPERATION_UNCONFIRMED', 'POLICY_CHANGED'].includes(cause.code)) { setReview(true); setReread(false); }
    } finally { busy.current = false; if (mounted.current) setPending(false); }
  }
  if (!isNew && (query.isError || !data)) return <div className="space-y-4 p-6">{query.isError ? <ErrorNotice error={query.error} /> : <LoadingState>正在读取策略…</LoadingState>}<Button variant="outline" disabled={query.isFetching || pending} onClick={() => void readLatest()}>读取最新策略</Button></div>;
  if (!config) return null;
  const effective = policy?.published;
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-6">
      <section data-testid="policy-effective" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-4">
        <div className="space-y-1"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{effective ? `当前版本 v${effective.revision}` : '新策略'}</span><Badge variant="outline">{policy?.enabled ? '已启用' : effective ? '已暂停' : '未保存'}</Badge>{dirty && !isNew && <Badge variant="secondary">未保存修改</Badge>}</div><p className="text-xs text-muted-foreground">{effective ? `${effective.config.name} · 保存于 ${date(effective.publishedAt)}` : '保存时自动校验规则，通过后立即生效。'}</p></div>
        {policy?.enabled && <Button size="sm" variant="outline" disabled={locked} onClick={() => void write('pause')}>暂停策略</Button>}
      </section>
      <form id="reply-policy-form" onSubmit={event => { event.preventDefault(); void write('save'); }} aria-busy={pending}>
        <fieldset disabled={blocked} className="min-w-0"><legend className="sr-only">策略设置</legend><PolicyFields config={config} stores={stores} timeZone={timeZone} onChange={next => { setLocal({ config: next, version: local?.version ?? policy?.version ?? 0 }); setMessage(''); }} /></fieldset>
      </form>
      {validation && !validation.success && <p role="status" className="text-sm text-muted-foreground">请填写策略名称、选择店铺与业务阶段，并检查数字范围、免打扰时间和通知变量。</p>}
      {(review || conflict) && <Alert><AlertTitle>{error instanceof ApiError && error.code === 'OPERATION_UNCONFIRMED' ? '操作结果尚未确认' : '核对最新策略后再操作'}</AlertTitle><AlertDescription><p>你的修改已保留。请读取最新策略，确认是否已有其他修改或保存已经生效，避免重复提交。</p>{reread && <Button variant="outline" disabled={blocked} onClick={() => { setLocal(dirty ? { config, version: policy?.version ?? 0 } : null); setReview(false); setReread(false); setError(undefined); }}>基于最新版本继续编辑</Button>}</AlertDescription></Alert>}
      {error != null && !(error instanceof ApiError && ['OPERATION_UNCONFIRMED', 'POLICY_CHANGED'].includes(error.code)) && <ErrorNotice error={error} />}
      {message && <p role="status" className="text-sm">{message}</p>}
      {effective && <details open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)} className="group border-t pt-5">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring"><History className="size-4" />版本记录<ChevronDown className="ml-auto size-4 transition-transform group-open:rotate-180" /></summary>
        <p className="mt-2 text-xs text-muted-foreground">每次保存都会保留版本。载入历史设置后，点击保存才会生效。</p>
        <div className="mt-4 flex flex-col gap-4">{history.isError ? <ErrorNotice error={history.error} /> : before !== null && history.isFetching ? <p role="status">正在读取版本记录…</p> : versions?.versions.map(version => <div key={version.revision} className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">v{version.revision} · {date(version.publishedAt)}</p><Button variant="outline" size="sm" disabled={locked || dirty} onClick={() => { setLocal({ config: version.config, version: policy!.version }); setMessage(`已载入 v${version.revision} 的设置，保存后生效。`); }}>载入 v{version.revision} 的设置</Button></div>
          <details><summary className="cursor-pointer text-xs text-muted-foreground">查看 v{version.revision} 的设置</summary><div className="pt-3"><PolicySummary config={version.config} stores={stores} /><p className="mt-2 text-xs text-muted-foreground">版本时区：{version.timeZone}</p></div></details>
        </div>)}</div>
        <div className="mt-4 flex flex-wrap gap-2">{before !== null && <Button variant="ghost" onClick={() => setBefore(null)}>最近版本</Button>}{versions?.nextBefore && <Button variant="outline" disabled={history.isFetching} onClick={() => setBefore(versions.nextBefore)}>较早版本</Button>}{history.isError && <Button variant="outline" onClick={() => void history.refetch()}>重试读取版本</Button>}</div>
      </details>}
    </div>
    <div className="shrink-0 space-y-3 border-t bg-background px-6 py-4">
      <p className="text-xs leading-relaxed text-muted-foreground">{review || conflict ? '请先读取最新策略，核对操作结果。' : config.kind === 'automatic' ? config.mode === 'automatic' ? '保存后，AI 可在适用范围内直接回复；人工接管的会话不受影响。' : '保存后仅生成回复建议，由人工确认发送。' : '保存后启用此通知规则，实际发送取决于平台能力与触发条件。'}</p>
      <div className="flex flex-wrap items-center justify-between gap-2"><Button size="sm" variant="ghost" disabled={pending || query.isFetching} onClick={() => void readLatest()}>读取最新策略</Button><div className="flex gap-2"><Button variant="outline" onClick={onClose}>返回列表</Button><Button form="reply-policy-form" type="submit" disabled={locked || !validation?.success || (!dirty && !!policy?.enabled)}>{pending && <Spinner />}{effective && !policy?.enabled ? '保存并启用' : '保存策略'}</Button></div></div>
    </div>
  </div>;
}
