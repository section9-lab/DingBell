import { useEffect,useRef,useState } from 'react';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../lib/api';
import { readReplyTestBudgets,type ReplyTestBudgetCommand,type ReplyTestBudgetView,type ReplyTestBudgetWorkspace } from '../lib/reply-test-budget-api';
import {readAiBudgets} from '../lib/ai-budget-api';
import {changeBudget,usdToMicros,formatBudgetUsd,utcBudgetDay,type BudgetKind} from '../lib/budget-api';
import type {AiBudgetWorkspace} from '../../shared/ai-budget';
import { useCompanySettings } from './company-settings-provider';
import { ErrorNotice } from './identity-shared';
import { Card,CardHeader,CardTitle,CardDescription,CardContent,CardFooter } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import { FieldGroup,Field,FieldLabel,FieldDescription,FieldError } from './ui/field';
import { Alert,AlertDescription } from './ui/alert';
import { Dialog,DialogTrigger,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter } from './ui/dialog';
import { Spinner } from './ui/spinner';
const budgetTitles={test:'AI 回复测试预算',reception:'AI 接待预算'};
const budgetDescriptions={test:'仅用于内部问答测试。金额为 USD 用量估算，不是充值余额或供应商账单；翻译与客户消息发送另行管理。',reception:'用于消费者会话中的 AI 接待，与策略测试单独记账。金额为 USD 用量估算，不是充值余额或供应商账单。'};
const dayText=(ms:number)=>new Date(ms).toISOString().slice(0,10);
export function BudgetPanel({companyId,kind}:{companyId:string;kind:BudgetKind}){
  const settings=useCompanySettings(),[pages,setPages]=useState<string[]>([]),client=useQueryClient(),cursor=pages.at(-1);
  const key=['ai-budgets',kind,...settings.queryKey,cursor??''];
  const query=useQuery<ReplyTestBudgetWorkspace|AiBudgetWorkspace>({queryKey:key,queryFn:({signal})=>kind==='test'?readReplyTestBudgets(companyId,cursor,signal):readAiBudgets(companyId,cursor,signal),retry:false,gcTime:0,refetchInterval:10000});
  async function refresh(){await client.cancelQueries({queryKey:key});return (await query.refetch()).isSuccess;}
  if(!query.data||query.isError)return <Card><CardHeader><CardTitle>{budgetTitles[kind]}</CardTitle><CardDescription>{budgetDescriptions[kind]}</CardDescription></CardHeader><CardContent>
    {query.isPending?<p role="status" className="flex items-center gap-2 text-sm"><Spinner />正在读取预算…</p>:<ErrorNotice error={query.error} />}
  </CardContent><CardFooter><Button variant="outline" disabled={query.isFetching} onClick={()=>void refresh()}>读取当前预算</Button></CardFooter></Card>;
  return <BudgetWorkspace key={`${kind}:${query.data.viewerMemberId}`} kind={kind} data={query.data} fetching={query.isFetching} refresh={refresh} date={settings.date}
    page={pages.length+1} previous={pages.length?()=>setPages(p=>p.slice(0,-1)):undefined} next={query.data.nextBefore?()=>setPages(p=>[...p,query.data!.nextBefore!]):undefined} />;
}
function BudgetWorkspace({data,kind,fetching,refresh,date,page,previous,next}:{data:ReplyTestBudgetWorkspace|AiBudgetWorkspace;kind:BudgetKind;fetching:boolean;refresh:()=>Promise<boolean>;date:(value:string)=>string;page:number;previous?:()=>void;next?:()=>void}){
  const [open,setOpen]=useState(false),[draft,setDraft]=useState(()=>({id:crypto.randomUUID(),start:dayText(Date.now()),end:dayText(Date.now()+86400000),amount:'',runs:''}));
  const [pending,setPending]=useState(false),[review,setReview]=useState(false),[error,setError]=useState<unknown>(null),[notice,setNotice]=useState(''),[formError,setFormError]=useState('');
  const busy=useRef(false),alive=useRef(true),panel=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const locked=pending||fetching||review;
  const money=usdToMicros(draft.amount),runs=/^\d{1,7}$/.test(draft.runs)?Number(draft.runs):0,start=utcBudgetDay(draft.start),end=utcBudgetDay(draft.end);
  async function execute(input:ReplyTestBudgetCommand){
    if(busy.current||locked)return;busy.current=true;setPending(true);setError(null);setNotice('');
    try{
      await changeBudget(kind,data.companyId,data.viewerMemberId,input);
      if(alive.current){setNotice('预算操作已记录，当前状态以列表为准。');if(input.action==='create')setOpen(false);}
      if(!await refresh()&&alive.current)setReview(true);
    }catch(cause){if(alive.current){setError(cause);setReview(true);}}
    finally{busy.current=false;if(alive.current)setPending(false);}
  }
  async function readLatest(){if(busy.current)return;const ok=await refresh();if(ok&&alive.current){setReview(false);setError(null);setNotice('已读取当前预算，请核对后操作。');}}
  function create(){
    if(money===null||!Number.isInteger(runs)||runs<1||runs>1000000||start===null||end===null||end<=start){setFormError('请填写有效日期、最多六位小数的非负金额，以及 1–1,000,000 次的上限。');return;}
    setFormError('');void execute({id:draft.id,action:'create',startsAt:start,endsAt:end,limitMicros:money,maxRuns:runs});
  }
  const message=error instanceof ApiError&&error.code==='OPERATION_UNCONFIRMED'
    ?'操作结果尚未确认。请读取当前预算和管理记录，再决定下一步。':'预算可能已变化。请先读取当前预算，核对后再操作。';
  const reviewNotice=review&&<Alert><AlertDescription>{message}</AlertDescription></Alert>;
  function budgetContent(b:ReplyTestBudgetView,current=false){return <section key={b.id} data-testid={current?`current-${kind}-budget`:undefined} className="flex flex-col gap-3 rounded-lg border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{current?(kind==='test'?'当前生成预算':'当前接待预算'):b.startsAt>data.at?'计划中的预算':'历史预算'}</h3><Badge variant={b.enabled?'secondary':'outline'}>{b.enabled?'已启用':'已暂停'}</Badge></div>
    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{date(new Date(b.startsAt).toISOString())} — {date(new Date(b.endsAt).toISOString())}（不含结束时刻）</p>
    <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">{[
      ['金额上限',formatBudgetUsd(b.limitMicros)],['已使用（估算）',formatBudgetUsd(b.spentMicros)],['尚在预留',formatBudgetUsd(b.reservedMicros)],['可用余额',formatBudgetUsd(b.remainingMicros)],
    ].map(([label,value])=><div key={label} className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words text-sm font-medium [overflow-wrap:anywhere]">{value}</dd></div>)}</dl>
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm">{kind==='test'?'获准生成':'获准接待'}：{b.admittedRuns} / {b.maxRuns} 次</p>
      {(b.endsAt>data.at||b.enabled)&&<Button variant="outline" size="sm" disabled={locked||b.revision>=Number.MAX_SAFE_INTEGER} onClick={()=>void execute({id:crypto.randomUUID(),action:'set_enabled',budgetId:b.id,expectedRevision:b.revision,enabled:!b.enabled})}>{b.enabled?'暂停预算':'启用预算'}</Button>}
    </div>
  </section>;}
  return <Card ref={panel} tabIndex={-1}>
    <CardHeader><CardTitle>{budgetTitles[kind]}</CardTitle><CardDescription>{budgetDescriptions[kind]}</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-5">
      {'queryToday' in data&&(!data.configuration.enabled||!data.configuration.modelConfigured||!data.configuration.knowledgeConfigured||!data.configuration.pricesConfigured)&&<Alert role="note"><AlertDescription>
        测试服务尚未配置完整。可先准备预算，再由部署管理员启用服务并核对模型、知识检索和价格配置。
      </AlertDescription></Alert>}
      {'queryToday' in data&&data.configuration.pricesConfigured&&<p className="text-sm text-muted-foreground">按当前配置，每次生成最多预留 {formatBudgetUsd(data.configuration.answerReservationMicros!)}，每次问题检索另预留 {formatBudgetUsd(data.configuration.queryReservationMicros!)}。生成结束后按报告用量核算。</p>}
      {'purpose' in data&&<section className="flex flex-col gap-2" aria-label="接待准备情况">
        <div className="flex flex-wrap gap-2"><Badge variant="outline">接待服务：{data.configuration.enabled?'已启用':'未启用'}</Badge><Badge variant="outline">模型服务：{data.configuration.modelConfigured?'已配置':'未配置'}</Badge><Badge variant="outline">模型与价格：{data.configuration.pricesConfigured?'已配置':'未配置'}</Badge></div>
        <p className="text-xs text-muted-foreground">此处检查已保存的配置，未调用模型。公司预算与接待服务分别启用。</p>
        {data.configuration.pricesConfigured&&<><p className="break-words text-sm text-muted-foreground">模型：{data.configuration.model}</p><p className="text-sm">每次接待最多预留 {formatBudgetUsd(data.configuration.runReservationMicros!)}（最多 {data.configuration.maxGenerations} 轮生成，每轮 {formatBudgetUsd(data.configuration.perGenerationMicros!)}）。完成后按报告用量核算，未知用量继续保留预留。</p></>}
      </section>}
      {kind==='reception'&&<Alert role="note"><AlertDescription>自动接待尚未开放，可先准备额度。启用预算不会自动接管会话或向消费者发送消息。</AlertDescription></Alert>}
      {data.currentBudget?budgetContent(data.currentBudget,true):<p className="text-sm text-muted-foreground">{kind==='test'?'当前没有覆盖此时段的生成预算。创建并启用预算后，才可开始新的测试。':'当前没有覆盖此时段的接待预算。可先创建，确认额度后再启用。'}</p>}
      {reviewNotice}{!!error&&!review&&<ErrorNotice error={error} />}{error instanceof ApiError&&error.code!=='OPERATION_UNCONFIRMED'&&review&&<ErrorNotice error={error} />}
      {notice&&<p role="status" className="text-sm">{notice}</p>}
      {'queryToday' in data&&<section className="flex flex-col gap-2"><h3 className="text-sm font-medium">今日问题检索 · UTC</h3><p className="text-sm">本公司获准 {data.queryToday.queries} 次，预留上限合计 {formatBudgetUsd(data.queryToday.reservedMicros)}。</p><p className="text-xs text-muted-foreground">检索另受整个部署的每日额度限制，不从上方生成预算中扣除。检索额度不是实际账单；未知结果不会自动退款或再次调用。</p></section>}
      <details><summary className="cursor-pointer text-sm font-medium">其他预算与历史</summary><div className="mt-3 flex flex-col gap-3">
        {data.budgets.filter(b=>b.id!==data.currentBudget?.id).map(b=>budgetContent(b))}
        {!data.budgets.some(b=>b.id!==data.currentBudget?.id)&&<p className="text-sm text-muted-foreground">本页暂无其他预算。</p>}
        <div className="flex flex-wrap items-center gap-2"><Button variant="ghost" size="sm" disabled={!previous||locked} onClick={previous}>上一页预算</Button><span className="text-xs text-muted-foreground">第 {page} 页</span><Button variant="ghost" size="sm" disabled={!next||locked} onClick={next}>下一页预算</Button></div>
      </div></details>
      <details data-testid={`${kind}-budget-audit`}><summary className="cursor-pointer text-sm font-medium">最近 10 条管理操作</summary><ol className="mt-3 flex flex-col gap-3">
        {data.events.map(e=><li key={e.id} className="flex flex-col gap-1 border-b pb-2 text-sm"><span>{e.action==='create'?'创建预算（暂停）':e.enabled?'启用预算':'暂停预算'} · {e.actorName.trim()||'未填写姓名'}</span><span className="text-xs text-muted-foreground">{date(new Date(e.createdAt).toISOString())} · 版本 {e.revision}</span></li>)}
      </ol>{!data.events.length&&<p className="mt-3 text-sm text-muted-foreground">暂无本入口记录的管理操作。</p>}</details>
      <p className="text-xs text-muted-foreground">暂停阻止新的额度授权，已发起的请求仍记录结果与费用。次数不会因结束或取消而返还；未知费用继续预留。当前记录读取于 {date(new Date(data.at).toISOString())}。</p>
    </CardContent>
    <CardFooter className="flex flex-wrap gap-2">
      <Dialog open={open} onOpenChange={value=>{if(!pending)setOpen(value);}}><DialogTrigger render={<Button ref={trigger} disabled={locked} onClick={()=>{setDraft({id:crypto.randomUUID(),start:dayText(Date.now()),end:dayText(Date.now()+86400000),amount:'',runs:''});setFormError('');}} />}>{kind==='test'?'新建测试预算':'新建接待预算'}</DialogTrigger>
        <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto" finalFocus={()=>trigger.current?.isConnected&&!trigger.current.disabled?trigger.current:panel.current}>
          <DialogHeader><DialogTitle>{kind==='test'?'新建测试预算':'新建接待预算'}</DialogTitle><DialogDescription>创建后，时间窗、金额和次数不能修改。预算默认暂停。</DialogDescription></DialogHeader>
          <form id={`${kind}-budget-form`} onSubmit={event=>{event.preventDefault();create();}} aria-busy={pending}>
            <FieldGroup className="gap-4">
              <Field data-disabled={locked}><FieldLabel htmlFor={`${kind}-budget-start`}>开始日期（UTC）</FieldLabel><Input id={`${kind}-budget-start`} type="date" min={dayText(Date.now())} value={draft.start} disabled={locked} onChange={e=>setDraft(d=>({...d,start:e.target.value}))} /></Field>
              <Field data-disabled={locked}><FieldLabel htmlFor={`${kind}-budget-end`}>结束日期（UTC）</FieldLabel><Input id={`${kind}-budget-end`} type="date" value={draft.end} disabled={locked} onChange={e=>setDraft(d=>({...d,end:e.target.value}))} /><FieldDescription>不含结束日期当天。例如 10 日至 11 日表示 10 日的一整天，不可与已有预算重叠。</FieldDescription></Field>
              <Field data-disabled={locked} data-invalid={!!formError&&money===null}><FieldLabel htmlFor={`${kind}-budget-amount`}>{kind==='test'?'生成':'接待'}金额上限（USD）</FieldLabel><Input id={`${kind}-budget-amount`} inputMode="decimal" value={draft.amount} disabled={locked} aria-invalid={!!formError&&money===null} onChange={e=>setDraft(d=>({...d,amount:e.target.value}))} /><FieldDescription>最多六位小数。单价由部署配置提供，这里只设置公司的用量上限。</FieldDescription></Field>
              <Field data-disabled={locked} data-invalid={!!formError&&(runs<1||runs>1000000)}><FieldLabel htmlFor={`${kind}-budget-runs`}>{kind==='test'?'生成':'接待'}次数上限</FieldLabel><Input id={`${kind}-budget-runs`} inputMode="numeric" value={draft.runs} disabled={locked} aria-invalid={!!formError&&(runs<1||runs>1000000)} onChange={e=>setDraft(d=>({...d,runs:e.target.value}))} /><FieldDescription>{kind==='reception'?'按接待运行计数，一次接待中的多次生成不重复计次。':''}1–1,000,000 次；即使配置零价格，也受次数限制。</FieldDescription></Field>
              {formError&&<FieldError>{formError}</FieldError>}
            </FieldGroup>
          </form>
          {reviewNotice}{error instanceof ApiError&&error.code!=='OPERATION_UNCONFIRMED'&&<ErrorNotice error={error} />}
          <DialogFooter><Button type="submit" form={`${kind}-budget-form`} disabled={locked}>{pending&&<Spinner data-icon="inline-start" />}创建预算</Button>{review&&<Button variant="outline" disabled={pending||fetching} onClick={()=>void readLatest()}>读取当前预算</Button>}</DialogFooter>
        </DialogContent>
      </Dialog>
      <Button variant="outline" disabled={pending||fetching} onClick={()=>void readLatest()}>读取当前预算</Button>
    </CardFooter>
  </Card>;
}
