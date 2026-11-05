import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../lib/api';
import { saveCompanySettings } from '../lib/company-settings-api';
import { createTimeFormatter } from '../lib/company-time';
import { useCompanySettings } from '../components/company-settings-provider';
import { ErrorNotice } from '../components/identity-shared';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../components/ui/card';
import { Field, FieldGroup, FieldLabel, FieldDescription } from '../components/ui/field';
import { NativeSelect, NativeSelectOption } from '../components/ui/native-select';
import { Spinner } from '../components/ui/spinner';
import { BudgetPanel } from '../components/budget-panel';
import {AnalyticsPanel} from '../components/analytics-panel';
import {DataGovernancePanel} from '../components/data-governance-panel';
import {DegradationPanel} from '../components/degradation-panel';
import {CompanyModelPanel} from '../components/company-model-panel';

const timeZones = [...new Set(['UTC', ...Intl.supportedValuesOf('timeZone')])];
export function CompanySettingsPage() {
  const { query, queryKey } = useCompanySettings(), client = useQueryClient();
  const [draft, setDraft] = useState<{ timeZone: string; version: number } | null>(null);
  const [pending, setPending] = useState(false), [review, setReview] = useState(false), [reread, setReread] = useState(false);
  const [error, setError] = useState<unknown>(), [message, setMessage] = useState('');
  const [previewAt] = useState(() => new Date().toISOString());
  const busy = useRef(false), data = query.data, selection = draft ?? data;
  const conflict = !!data && !!draft && draft.version !== data.version;
  const disabled = pending || query.isFetching || query.isError || !data?.canManage;
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
  if (!data) return <div className="flex flex-col gap-4"><h1 className="text-2xl font-semibold">公司设置</h1>{query.isPending ? <p role="status" className="flex items-center gap-2"><Spinner />正在读取公司设置…</p> : <ErrorNotice error={query.error} />}<Button variant="outline" disabled={query.isFetching} onClick={() => void readLatest()}>读取最新设置</Button></div>;
  const options = timeZones.includes(data.timeZone) ? timeZones : [...timeZones, data.timeZone];
  return <>
    <div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold tracking-tight">公司设置</h1><p className="text-sm text-muted-foreground">管理时间显示、AI 模型与用量预算。</p></div>
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
    {data.canManage&&!query.isError&&<CompanyModelPanel companyId={data.companyId}/>}
    {data.canManage&&!query.isError&&<AnalyticsPanel companyId={data.companyId}/>}
    {data.canManage&&!query.isError&&<DataGovernancePanel companyId={data.companyId}/>}
    {data.canManage&&!query.isError&&<DegradationPanel companyId={data.companyId}/>}
    {data.canManage&&!query.isError&&<section id="ai-budgets" className="flex flex-col gap-3"><div className="flex flex-col gap-1"><h2 className="text-lg font-semibold">AI 接待用量预算</h2><p className="text-sm text-muted-foreground">为消费者会话中的 AI 接待设置用量与次数上限；未启用、暂停或耗尽预算时停止新接待，不自动切换为无限预算。</p></div>
      <BudgetPanel companyId={data.companyId} />
    </section>}
  </>;
}
