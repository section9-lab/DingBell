import { LoadingState } from '../components/query-state';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft, ListChecks, Plug, Receipt, Settings, ShieldCheck } from 'lucide-react';
import { ApiError, type Company, type Identity } from '../lib/api';
import { saveCompanySettings } from '../lib/company-settings-api';
import { createTimeFormatter } from '../lib/company-time';
import { readAnalyticsOverview } from '../lib/analytics-api';
import { useCompanySettings } from '../components/company-settings-provider';
import { ErrorNotice } from '../components/identity-shared';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../components/ui/card';
import { Field, FieldGroup, FieldLabel, FieldDescription } from '../components/ui/field';
import { NativeSelect, NativeSelectOption } from '../components/ui/native-select';
import { Spinner } from '../components/ui/spinner';
import { DataGovernancePanel } from '../components/data-governance-panel';
import { DegradationPanel } from '../components/degradation-panel';
import { CompanyModelPanel } from '../components/company-model-panel';
import { ProfileSettingsCard } from '../components/profile-settings';
import { CapabilitiesPage } from './capabilities';
import { workspaceRoutes } from '../lib/routes';

const timeZones = [...new Set(['UTC', ...Intl.supportedValuesOf('timeZone')])];
const integer = new Intl.NumberFormat('zh-CN');
const money = (value: number) => `${(value / 1_000_000).toFixed(6)} 估算货币单位`;

type SettingsSection = 'general' | 'billing' | 'model' | 'governance' | 'capabilities';

function readSection(value: string | null): SettingsSection {
  return value === 'billing' || value === 'model' || value === 'governance' || value === 'capabilities' ? value : 'general';
}

const settingsSections: { id: SettingsSection; label: string; icon: typeof Settings }[] = [
  { id: 'general', label: '常规', icon: Settings },
  { id: 'billing', label: '账单', icon: Receipt },
  { id: 'model', label: '模型接入配置', icon: Plug },
  { id: 'governance', label: '数据治理状态', icon: ShieldCheck },
  { id: 'capabilities', label: '能力与数据', icon: ListChecks },
];

export function CompanySettingsPage({ identity, company, refresh }: { identity: Identity; company: Company; refresh: (notice?: unknown) => Promise<void> }) {
  const { query, queryKey } = useCompanySettings(), client = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const section = readSection(searchParams.get('section'));
  const [language, setLanguage] = useState<'zh-CN' | 'en'>(() => {
    try { return localStorage.getItem('dingbell.language') === 'en' ? 'en' : 'zh-CN'; } catch { return 'zh-CN'; }
  });
  const [draft, setDraft] = useState<{ timeZone: string; version: number } | null>(null);
  const [pending, setPending] = useState(false), [review, setReview] = useState(false), [reread, setReread] = useState(false);
  const [error, setError] = useState<unknown>(), [message, setMessage] = useState('');
  const [previewAt] = useState(() => new Date().toISOString());
  const busy = useRef(false), data = query.data, selection = draft ?? data;
  const conflict = !!data && !!draft && draft.version !== data.version;
  const disabled = pending || query.isFetching || query.isError || !data?.canManage;
  function selectSection(id: SettingsSection) {
    const next = new URLSearchParams(searchParams);
    if (id === 'general') next.delete('section'); else next.set('section', id);
    setSearchParams(next, { replace: true });
  }
  function changeLanguage(value: 'zh-CN' | 'en') {
    setLanguage(value);
    try { localStorage.setItem('dingbell.language', value); } catch { /* Storage may be unavailable. */ }
    document.documentElement.lang = value;
  }
  async function save() {
    if (busy.current || disabled || review || conflict || !data || !selection || selection.timeZone === data.timeZone) return;
    busy.current = true; setPending(true); setError(undefined); setMessage('');
    try {
      await client.cancelQueries({ queryKey });
      const saved = await saveCompanySettings(data.companyId, selection.timeZone, selection.version);
      // A periodic read may have started while the write was in flight.
      await client.cancelQueries({ queryKey });
      client.setQueryData(queryKey, saved); setDraft(null); setMessage('设置已保存，公司内的时间显示已更新。');
    } catch (cause) {
      setError(cause); setReview(true); setReread(false);
    } finally { busy.current = false; setPending(false); }
  }
  async function readLatest() {
    setReread(false);
    const result = await query.refetch();
    if (result.isSuccess) setReread(true);
  }
  if (!data) return <div className="flex flex-col gap-4"><h1 className="page-title">公司设置</h1>{query.isPending ? <LoadingState>正在读取公司设置…</LoadingState> : <ErrorNotice error={query.error} />}<Button variant="outline" disabled={query.isFetching} onClick={() => void readLatest()}>读取最新设置</Button></div>;
  const options = timeZones.includes(data.timeZone) ? timeZones : [...timeZones, data.timeZone];
  return <>
    <div className="flex flex-col gap-2"><h1 className="page-title">公司设置</h1><p className="text-sm text-muted-foreground">管理个人资料、公司时间显示、界面语言、模型接入与账单。</p></div>
    <div className="settings-layout">
      <aside className="min-w-0" aria-label="设置导航">
        <Link to={workspaceRoutes.messages} className="settings-back"><ArrowLeft className="size-4" aria-hidden="true" />返回</Link>
        <nav className="settings-nav" aria-label="设置分区">
          {settingsSections.map(item => {
            const Icon = item.icon;
            return <button
              key={item.id}
              type="button"
              className="settings-nav-item"
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => selectSection(item.id)}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{item.label}</span>
            </button>;
          })}
        </nav>
      </aside>

      <section className="flex min-w-0 flex-col gap-4" aria-label="设置内容">
        {section === 'general' && <>
          <div className="settings-section-head"><h2 className="page-title">常规</h2><p className="page-subtitle">个人资料、公司时区与界面语言。</p></div>
          <ProfileSettingsCard key={identity.session?.user.id} identity={identity} />
          <Card>
            <CardHeader><CardTitle>时间与时区</CardTitle><CardDescription>所有成员使用同一时区，应用于消息、备注与发送记录。</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-5">
              <p className="text-xs text-muted-foreground">当前保存：{data.timeZone} · 版本 {data.version}</p>
              <form id="company-settings-form" onSubmit={event => { event.preventDefault(); void save(); }} aria-busy={pending}>
                <FieldGroup>
                  <Field data-disabled={disabled}>
                    <FieldLabel htmlFor="company-time-zone">公司时区</FieldLabel>
                    <NativeSelect id="company-time-zone" className="w-full" value={selection!.timeZone} disabled={disabled} aria-describedby="company-time-zone-help" onChange={event => { setDraft({ timeZone: event.target.value, version: selection!.version }); setMessage(''); }}>
                      {options.map(zone => <NativeSelectOption key={zone} value={zone}>{zone}</NativeSelectOption>)}
                    </NativeSelect>
                    <FieldDescription id="company-time-zone-help">预览：{createTimeFormatter(selection!.timeZone)(previewAt)} · 夏令时按所选地区自动计算</FieldDescription>
                  </Field>
                </FieldGroup>
              </form>
              {!data.canManage && <p className="text-sm text-muted-foreground">仅公司所有者和管理员可以修改。</p>}
              {(review || conflict) && <Alert><AlertTitle>{error instanceof ApiError && error.code === 'OPERATION_UNCONFIRMED' ? '保存结果尚未确认' : '保存前请核对最新设置'}</AlertTitle><AlertDescription><p>{error instanceof ApiError && error.code === 'SETTINGS_CHANGED' ? '设置已被其他人修改，你的选择已保留。' : '你的选择已保留。请先读取当前设置，核对后再决定是否继续。'}</p>{reread && data.canManage && <Button variant="outline" disabled={query.isFetching || query.isError} onClick={() => { setDraft({ timeZone: selection!.timeZone, version: data.version }); setReview(false); setReread(false); setError(undefined); }}>基于最新版本继续编辑</Button>}</AlertDescription></Alert>}
              {error != null && !(error instanceof ApiError && ['SETTINGS_CHANGED','OPERATION_UNCONFIRMED'].includes(error.code)) && <ErrorNotice error={error} />}
              {query.isError && <ErrorNotice error={query.error} />}
              {message && <p role="status" className="text-sm">{message}</p>}
            </CardContent>
            <CardFooter className="flex flex-wrap gap-2">
              {data.canManage && <Button type="submit" form="company-settings-form" disabled={disabled || review || conflict || selection!.timeZone === data.timeZone || data.version >= Number.MAX_SAFE_INTEGER}>{pending && <Spinner />}保存设置</Button>}
              <Button variant="outline" disabled={pending || query.isFetching} onClick={() => void readLatest()}>读取最新设置</Button>
            </CardFooter>
          </Card>

          <Card>
            <CardHeader><CardTitle>界面语言</CardTitle><CardDescription>选择工作区界面语言。偏好保存在当前浏览器。</CardDescription></CardHeader>
            <CardContent>
              <Field className="max-w-xs">
                <FieldLabel htmlFor="company-language">语言</FieldLabel>
                <NativeSelect id="company-language" className="w-full" value={language} onChange={event => changeLanguage(event.target.value === 'en' ? 'en' : 'zh-CN')}>
                  <NativeSelectOption value="zh-CN">简体中文</NativeSelectOption>
                  <NativeSelectOption value="en">English</NativeSelectOption>
                </NativeSelect>
                <FieldDescription>语言包按发布批次逐步覆盖，当前设置页会保留你的选择。</FieldDescription>
              </Field>
            </CardContent>
          </Card>
        </>}

        {section === 'billing' && <BillingPanel companyId={data.companyId} />}
        {section === 'model' && <CompanyModelPanel companyId={data.companyId} />}
        {section === 'governance' && <div className="flex flex-col gap-4"><DataGovernancePanel companyId={data.companyId} /><DegradationPanel companyId={data.companyId} /></div>}
        {section === 'capabilities' && <CapabilitiesPage company={company} refresh={refresh} />}
      </section>
    </div>
  </>;
}

function BillingPanel({ companyId }: { companyId: string }) {
  const query = useQuery({
    queryKey: ['billing-overview', companyId],
    queryFn: ({ signal }) => readAnalyticsOverview(companyId, {}, signal),
    refetchInterval: 60_000,
  });
  const data = query.data;
  return <div className="flex flex-col gap-4">
    <div className="settings-section-head">
      <h2 className="page-title">账单</h2>
      <p className="page-subtitle">模型调用用量与估算费用。费用来自已报告的 provider claims，不是供应商发票。</p>
    </div>
    {query.isPending ? <LoadingState>正在计算模型用量…</LoadingState> : query.isError ? <><ErrorNotice error={query.error} /><Button variant="outline" className="w-fit" disabled={query.isFetching} onClick={() => void query.refetch()}>重新读取账单</Button></> : data && <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Card className="gap-2"><CardHeader className="pb-0"><CardDescription>模型调用 claims</CardDescription><CardTitle className="text-2xl tabular-nums">{integer.format(data.aiUsage.claims)}</CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">{integer.format(data.aiUsage.usageReportedClaims)} 个有 token 用量 · {integer.format(data.aiUsage.usageUnreportedClaims)} 个未知</p></CardContent></Card>
        <Card className="gap-2"><CardHeader className="pb-0"><CardDescription>Token 总量</CardDescription><CardTitle className="text-2xl tabular-nums">{integer.format(data.aiUsage.tokens.total)}</CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">输入 {integer.format(data.aiUsage.tokens.input)} · 输出 {integer.format(data.aiUsage.tokens.output)} · 缓存读 {integer.format(data.aiUsage.tokens.cacheRead)}</p></CardContent></Card>
        <Card className="gap-2"><CardHeader className="pb-0"><CardDescription>模型估算费用</CardDescription><CardTitle className="text-2xl tabular-nums">{money(data.aiUsage.estimatedChargedMicros)}</CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">{integer.format(data.aiUsage.costKnownClaims)} 个费用已知 · {integer.format(data.aiUsage.costUnknownClaims)} 个费用未知</p></CardContent></Card>
        <Card className="gap-2"><CardHeader className="pb-0"><CardDescription>已确认 AI 外发</CardDescription><CardTitle className="text-2xl tabular-nums">{integer.format(data.businessUsage.confirmedAiReplyIntents)}</CardTitle></CardHeader><CardContent><p className="text-xs text-muted-foreground">按唯一外发意图计数 · {integer.format(data.businessUsage.unknownAiReplyIntents)} 个 unknown 单列</p></CardContent></Card>
      </div>
      <Card>
        <CardHeader><CardTitle>按来源</CardTitle><CardDescription>{data.fromDate} 至 {data.toDate}（结束不含）· {data.timeZone}</CardDescription></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {([['ai_reception_generation', 'AI 接待生成']] as const).map(([key, label]) => {
            const item = data.aiUsage.bySource[key];
            return <div key={key} className="rounded-xl border border-border p-3">
              <p className="text-[13px] font-medium">{label}</p>
              <p className="mt-2 text-sm tabular-nums">{integer.format(item.claims)} claims · {integer.format(item.tokens.total)} tokens</p>
              <p className="mt-1 text-xs text-muted-foreground">估算费用 {money(item.estimatedChargedMicros)}</p>
            </div>;
          })}
        </CardContent>
      </Card>
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>快照 {new Date(data.snapshotAt).toLocaleString('zh-CN', { timeZone: data.timeZone })}</span>
        <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching && <Spinner />}刷新</Button>
      </div>
    </>}
  </div>;
}
