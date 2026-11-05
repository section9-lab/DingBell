import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ArrowRight, Copy, RefreshCw } from 'lucide-react';
import { ApiError, type Company } from '../lib/api';
import { readReadiness, type Readiness, type ReadinessStore, type ReadinessSync, type SyncSourceKind } from '../lib/readiness-api';
import { setFbsSync, setFboSync,setFbpSync, setProductSync, setStoreSync } from '../lib/sync-api';
import { syncReasons } from '../components/store-sync-panel';
import { ErrorNotice } from '../components/identity-shared';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Spinner } from '../components/ui/spinner';

const storeStatuses: Record<string, string> = {
  unverified: '待验证', verified: '只读验证通过', partial: '部分能力可用',
  attention: '需要检查', paused: '已暂停', disconnected: '已断开',
};
const syncNames: Record<SyncSourceKind, string> = {
  chat: '会话同步', products: '商品同步', fbs_postings: 'FBS 包裹同步', fbo_postings: 'FBO 包裹同步',fbp_postings:'FBP 包裹同步（Beta）',
};
const syncData: Record<SyncSourceKind, string> = {
  chat: '买家会话与消息', products: '商品列表与详情', fbs_postings: 'FBS 包裹与详情', fbo_postings: 'FBO 包裹与详情',fbp_postings:'FBP 合作仓包裹与详情',
};
const write = { chat: setStoreSync, products: setProductSync, fbs_postings: setFbsSync, fbo_postings: setFboSync,fbp_postings:setFbpSync };

/** 总览页可以直接重新启用，因此不再重复「请联系管理员检查」。 */
const hubReasons: Record<string, string> = {
  invalid_response: '平台返回的数据未能通过校验，进度已保留。',
  cursor_stalled: '平台没有返回可继续的分页位置，进度已保留。',
  sync_failed: '同步未能继续，进度已保留。',
};
const reasonFor = (code: string) => hubReasons[code] ?? syncReasons[code] ?? '同步未能继续，已保留进度。';

function syncState(sync: ReadinessSync, configured: boolean) {
  if (!configured) return { label: '部署未配置', tone: 'destructive' as const, detail: '同步运行时或凭证加密密钥未配置，需要部署管理员处理。' };
  if (!sync.enabled) return sync.epoch === 0
    ? { label: '未启用', tone: 'outline' as const, detail: '从未启用。启用后只读取此后的数据，历史仍会按平台窗口补齐。' }
    : { label: '已停止', tone: 'outline' as const, detail: sync.lastError ? `${reasonFor(sync.lastError)} 重新启用会从保留的断点继续，不会清空已有数据。` : '已手动停止，进度与已导入数据保留，重新启用即从断点继续。' };
  if (sync.blockedUntil && Date.parse(sync.blockedUntil) > Date.now()) return { label: '等待平台许可', tone: 'secondary' as const, detail: '平台限制了读取频率，到期后自动继续。' };
  if (sync.lastError) return { label: '等待重试', tone: 'secondary' as const, detail: reasonFor(sync.lastError) };
  if (sync.running) return { label: '正在同步', tone: 'secondary' as const, detail: '正在读取平台数据，进度会自动保存。' };
  return { label: '持续同步中', tone: 'secondary' as const, detail: '后台会持续追赶新数据并刷新详情。' };
}

const variables = `# 本地写入 .dev.vars；线上配置为 Worker 变量或密钥，改完重启生效
OUTBOUND_ENABLED=true          # 人工回复发送（还需要店铺聊天回复能力）
TRANSLATION_ENABLED=true       # 译文预览；还需独立模型、完整价格与翻译预算
AI_OUTBOUND_ENABLED=true       # AI 自动发送；同时需要 OUTBOUND_ENABLED`;

type Step = { name: string; detail: string; ready: boolean; blocked?: 'unconfigured' | 'disabled'; env?: string[]; to?: string; action?: string };

export function CapabilitiesPage({ company, refresh }: { company: Company; refresh: (notice?: unknown) => Promise<void> }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<unknown>();
  const [copied, setCopied] = useState(false);
  const query = useQuery({ queryKey: ['readiness', company.id], queryFn: ({ signal }) => readReadiness(company.id, signal) });
  const management = ['owner', 'admin'].includes(company.role);

  async function toggle(store: ReadinessStore, sync: ReadinessSync) {
    if (pending) return;
    setPending(`${store.id}:${sync.source}`);
    setError(undefined);
    try {
      await write[sync.source](company.id, store.id, sync.epoch, !sync.enabled);
      await query.refetch();
    } catch (cause) {
      setError(cause);
      if (cause instanceof ApiError && ['NOT_FOUND', 'UNAUTHENTICATED', 'FORBIDDEN'].includes(cause.code)) await refresh(cause);
    } finally { setPending(null); }
  }

  if (query.isPending) return <p role="status" className="flex items-center gap-2 text-sm"><Spinner aria-hidden="true" />正在读取能力状态…</p>;
  if (query.isError || !query.data) return <div className="flex flex-col gap-3"><ErrorNotice error={query.error} /><Button className="w-fit" variant="outline" onClick={() => void query.refetch()}>重新读取能力状态</Button></div>;
  const data: Readiness = query.data;
  const deployment = data.deployment;

  const steps: Step[] = [
    { name: '回复策略', detail: data.policies.enabled ? `${data.policies.enabled} 条已启用，共 ${data.policies.total} 条草稿。` : data.policies.total ? `${data.policies.total} 条草稿尚未启用，AI 托管没有可执行策略。` : '还没有回复策略，AI 托管即使打开也不会自动回复。', ready: data.policies.enabled > 0, blocked: 'unconfigured', to: '/workspace/reply-policies', action: '配置策略' },
    { name: '知识库发布', detail: data.knowledge.published ? `${data.knowledge.published} 篇已发布，共 ${data.knowledge.total} 篇。` : data.knowledge.total ? `${data.knowledge.total} 篇存在草稿，但没有已发布版本，AI 无法引用。` : '还没有知识资料，AI 只能按策略通用回复。', ready: data.knowledge.published > 0, blocked: 'unconfigured', to: '/workspace/knowledge', action: '管理知识' },
    { name: '人工回复发送', detail: deployment.outbound ? '可以在消息中心直接发送回复。' : '消息中心可以撰写与翻译，但发送开关未开。', ready: deployment.outbound, blocked: 'disabled', env: ['OUTBOUND_ENABLED'] },
    { name: '翻译成俄语', detail: !deployment.translation.enabled ? '译文预览未启用。' : !deployment.translation.configured || !deployment.translation.model ? '已启用，但独立翻译配置或模型密钥不完整；不能仅靠保存客服连接启用，请联系部署管理员核查。' : '可在回复编辑器里把中文译成俄语。', ready: deployment.translation.enabled && deployment.translation.configured && deployment.translation.model, blocked: deployment.translation.enabled ? 'unconfigured' : 'disabled', env: ['TRANSLATION_ENABLED', 'TRANSLATION_CONFIG_JSON'] },
    { name: 'AI 托管接待', detail: !deployment.ai.modelConfigured ? '还没有在「公司设置 > AI 模型」保存可用连接，或缺少运行绑定。' : !deployment.ai.pricesConfigured ? '模型连接已保存，但价格或执行限制不完整。' : '执行配置已保存；每次接待仍需可用预算、已发布策略及当前店铺权限。', ready: deployment.ai.enabled && deployment.ai.pricesConfigured, blocked: 'unconfigured', to: '/workspace/settings', action: '配置模型' },
    { name: 'AI 自动发送', detail: deployment.aiOutbound && deployment.outbound ? '部署发送开关已开；仍需公司显式授权、预算、策略与店铺发送许可。' : '部署不允许 AI 自动外发；内部草稿不是已发送消息。', ready: deployment.aiOutbound && deployment.outbound, blocked: 'disabled', env: ['AI_OUTBOUND_ENABLED', 'OUTBOUND_ENABLED'] },
  ];
  const readySteps = steps.filter(step => step.ready).length;
  const syncs = data.stores.flatMap(store => store.sync);
  const disabledDeployment = steps.filter(step => step.env && !step.ready).length;

  return <>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">能力与数据</h1>
        <p className="text-sm leading-6 text-muted-foreground">所有能力与数据的实时状态。数据同步可以在这里开关；对外发送与 AI 相关的开关由部署配置决定，这里说明它们的状态与开启方式。</p>
      </div>
      <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw data-icon="inline-start" />刷新状态</Button>
    </div>

    {error && <ErrorNotice error={error} />}
    {!management && <Alert><AlertTitle>只读查看</AlertTitle><AlertDescription>同步开关与配置只能由公司所有者或管理员操作。你可以查看当前状态。</AlertDescription></Alert>}

    <section aria-labelledby="readiness-summary" className="grid gap-3 sm:grid-cols-3">
      <Card className="gap-2"><CardHeader className="pb-0"><CardDescription>接待准备</CardDescription><CardTitle className="text-2xl tabular-nums">{readySteps} / {steps.length}</CardTitle></CardHeader><CardContent><p className="text-xs leading-5 text-muted-foreground">{readySteps === steps.length ? '配置项已齐备；预算、权限与执行条件仍会逐次验证。' : `还有 ${steps.length - readySteps} 项未就绪，其中 ${disabledDeployment} 项需要部署配置。`}</p></CardContent></Card>
      <Card className="gap-2"><CardHeader className="pb-0"><CardDescription>数据同步</CardDescription><CardTitle className="text-2xl tabular-nums">{syncs.filter(sync => sync.enabled).length} / {syncs.length}</CardTitle></CardHeader><CardContent><p className="text-xs leading-5 text-muted-foreground">{data.stores.length ? `覆盖 ${data.stores.length} 家店铺的四类数据。` : '还没有店铺，先在店铺管理里连接。'}</p></CardContent></Card>
      <Card className="gap-2"><CardHeader className="pb-0"><CardDescription>已发布知识</CardDescription><CardTitle className="text-2xl tabular-nums">{data.knowledge.published} / {data.knowledge.total}</CardTitle></CardHeader><CardContent><p className="text-xs leading-5 text-muted-foreground">只有已发布版本会被 AI 引用。</p></CardContent></Card>
    </section>

    <section aria-labelledby="data-sync" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="data-sync" className="text-base font-semibold">数据同步</h2>
        <p className="text-xs text-muted-foreground">四类数据独立开关，停止会保留已导入内容与断点</p>
      </div>
      {!data.stores.length ? <p className="text-sm text-muted-foreground">还没有店铺。<Button variant="link" className="h-auto p-0" render={<Link to="/workspace/stores" />}>去连接店铺</Button></p>
        : data.stores.map(store => <Card key={store.id}>
          <CardHeader>
            <CardTitle><h3 className="text-base">{store.name}</h3></CardTitle>
            <CardAction className="flex items-center gap-2">
              <Badge variant="outline">{storeStatuses[store.status] ?? store.status}</Badge>
              <Button size="sm" variant="ghost" render={<Link to={`/workspace/stores?store=${store.id}`} />}>店铺详情<ArrowRight data-icon="inline-end" /></Button>
            </CardAction>
            <CardDescription>Ozon · Client ID {store.platformStoreId}{!store.hasCredentials && ' · 未保存凭证'}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col divide-y">
            {store.sync.map(sync => {
              const state = syncState(sync, deployment.sync);
              const busy = pending === `${store.id}:${sync.source}`;
              return <div key={sync.source} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{syncNames[sync.source]}</span><Badge variant={state.tone}>{state.label}</Badge></div>
                  <p className="text-xs leading-5 text-muted-foreground">{syncData[sync.source]} · {state.detail}</p>
                  <p className="text-xs text-muted-foreground">最近完成读取：{sync.lastSuccessAt ? new Date(sync.lastSuccessAt).toLocaleString('zh-CN') : '尚未完成'}</p>
                </div>
                {management && <Button size="sm" variant={sync.enabled ? 'outline' : 'default'} disabled={busy || (!sync.enabled && (!deployment.sync || !sync.canEnable))} title={!sync.enabled && !sync.canEnable ? '请先在店铺详情里通过凭证与该资源的只读能力检查' : undefined}
                  onClick={() => void toggle(store, sync)}>{busy && <Spinner aria-hidden="true" />}{sync.enabled ? '停止' : '启用'}</Button>}
              </div>;
            })}
          </CardContent>
        </Card>)}
      <p className="text-xs leading-5 text-muted-foreground">同步停用多因连续失败自动停止（例如平台返回的数据未能通过校验），重新启用会从断点继续；凭证或权限不足时，先到店铺详情重新检查只读能力。</p>
    </section>

    <section aria-labelledby="reception-steps" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="reception-steps" className="text-base font-semibold">接待能力</h2>
        <p className="text-xs text-muted-foreground">自上而下依次就绪，AI 才能接手</p>
      </div>
      <div className="divide-y overflow-hidden rounded-xl border">
        {steps.map(step => <div key={step.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-background p-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{step.name}</span>
              <Badge variant={step.ready ? 'secondary' : step.blocked === 'disabled' ? 'outline' : 'destructive'}>{step.ready ? '已就绪' : step.blocked === 'unconfigured' ? '缺少配置' : '未启用'}</Badge>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">{step.detail}</p>
            {!!step.env?.length && !step.ready && <p className="font-mono text-xs text-muted-foreground">{step.env.join(' · ')}</p>}
          </div>
          {step.to && <Button size="sm" variant="ghost" render={<Link to={step.to} />}>{step.action}<ArrowRight data-icon="inline-end" /></Button>}
        </div>)}
      </div>
    </section>

    <section aria-labelledby="deployment" className="flex flex-col gap-3">
      <h2 id="deployment" className="text-base font-semibold">部署配置</h2>
      <p className="text-sm leading-6 text-muted-foreground">下面这些能力不会在界面里出现开关：它们决定消息能否真正发到 Ozon、模型能否被调用。本地写在 <code className="rounded bg-muted px-1 py-0.5 text-xs">.dev.vars</code>，线上配置为 Worker 变量或密钥，修改后需要重启或重新部署。</p>
      <div className="relative overflow-x-auto rounded-xl border bg-muted/40 p-4">
        <pre className="text-xs leading-6"><code>{variables}</code></pre>
        <Button size="sm" variant="outline" className="absolute right-3 top-3" onClick={() => { void navigator.clipboard?.writeText(variables).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => setCopied(false)); }}>{copied ? '已复制' : <><Copy data-icon="inline-start" />复制</>}</Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">开启后仍需逐项核对：翻译需要已审核的翻译配置与预算，AI 接待需要已审核的模型价格与回复策略，自动发送还需要店铺的聊天回复能力。任何一项缺失时，界面会显示「缺少配置」而不是「已就绪」。</p>
    </section>
  </>;
}
