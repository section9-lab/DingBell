import { workspaceRoutes } from '../lib/routes';
import { LoadingState } from '../components/query-state';
import * as v from 'valibot';
import {lazy,Suspense,useEffect,useMemo,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {Link,useSearchParams} from 'react-router';
import {accountingSearch,resolveAccountingFilter} from '../lib/accounting-filters';
import {Calculator,ChevronDown,Info,Plus,RefreshCw,SlidersHorizontal} from 'lucide-react';
import {ApiError,type Company} from '../lib/api';
import {readStores} from '../lib/stores-api';
import {storesQueryKey} from '../lib/query-keys';
import {captureAccounting,readAccounting,readAccountingConfig,voidAccountingExpense} from '../lib/accounting-api';
import {accountingFilter,type AccountingConfig,type AccountingFilter} from '../../shared/accounting';
import {useCompanySettings} from '../components/company-settings-provider';
import {AccountingCharts} from '../components/accounting-charts';
import {formatCny} from '../lib/format';
import {AccountingDetails} from '../components/accounting-details';
import {AccountingCostGaps} from '../components/accounting-cost-gaps';
import {AccountingCostDialog,AccountingExpenseDialog,AccountingRulesDialog} from '../components/accounting-forms';
import {ErrorNotice} from '../components/identity-shared';
import {ContentReveal} from '../components/motion';
import {Alert,AlertDescription,AlertTitle} from '../components/ui/alert';
import {Badge} from '../components/ui/badge';
import {Button} from '../components/ui/button';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from '../components/ui/card';
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '../components/ui/dialog';
import {Empty,EmptyContent,EmptyDescription,EmptyHeader,EmptyMedia,EmptyTitle} from '../components/ui/empty';
import {Field,FieldLabel} from '../components/ui/field';
import {Input} from '../components/ui/input';
import {NativeSelect,NativeSelectOption} from '../components/ui/native-select';
import {Popover,PopoverContent,PopoverDescription,PopoverTitle,PopoverTrigger} from '../components/ui/popover';
import {Spinner} from '../components/ui/spinner';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '../components/ui/table';
import {Tabs,TabsContent,TabsList,TabsTrigger} from '../components/ui/tabs';

const AccountingImportDialog=lazy(async()=>({default:(await import('../components/accounting-import')).AccountingImportDialog}));
const ALL_TIME_FROM='1999-01-01';

function before(date:string,days:number){return new Date(Date.parse(`${date}T00:00:00Z`)-days*86_400_000).toISOString().slice(0,10);}
export function AccountingPage({company}:{company:Company}){
  const {timeZone}=useCompanySettings(),today=new Date().toLocaleDateString('en-CA',{timeZone});
  const stores=useQuery({queryKey:storesQueryKey(company.id),queryFn:({signal})=>readStores(company.id,0,signal)});
  const [params,setParams]=useSearchParams();
  const storeId=params.get('store')||stores.data?.stores[0]?.id||'';
  return <ContentReveal className="grid min-w-0 gap-5">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="page-title">核算中心</h1><p className="mt-2 text-sm text-muted-foreground">看清成本去向与商品贡献，为经营决策提供可追溯的依据。</p></div>{!!stores.data?.stores.length&&<Field orientation="horizontal" className="w-64 items-center"><FieldLabel htmlFor="accounting-store" className="flex-none text-xs font-normal text-muted-foreground">店铺</FieldLabel><NativeSelect id="accounting-store" className="min-w-0 flex-1" value={storeId} onChange={event=>{const next=new URLSearchParams(params);next.set('store',event.target.value);setParams(next);}}>{stores.data.stores.map(store=><NativeSelectOption key={store.id} value={store.id}>{store.name}</NativeSelectOption>)}</NativeSelect></Field>}</div>
    {stores.isPending?<LoadingState>正在读取店铺…</LoadingState>:stores.isError?<><ErrorNotice error={stores.error}/><Button variant="outline" className="w-fit" onClick={()=>void stores.refetch()}>重试</Button></>:!stores.data.stores.length?<Empty><EmptyHeader><EmptyMedia variant="icon"><Calculator/></EmptyMedia><EmptyTitle>先连接你的店铺</EmptyTitle><EmptyDescription>同步商品和订单后，录入成本即可开始核算。</EmptyDescription></EmptyHeader><EmptyContent><Button render={<Link to={workspaceRoutes.stores}/>}>前往店铺管理</Button></EmptyContent></Empty>:<AccountingWorkspace key={`${company.id}:${storeId}`} company={company} storeId={storeId} today={today}/>}
  </ContentReveal>;
}
function AccountingWorkspace({company,storeId,today}:{company:Company;storeId:string;today:string}){
  const client=useQueryClient(),canEdit=company.role==='owner'||company.role==='admin';
  const [params,setParams]=useSearchParams();
  const filter=useMemo(()=>resolveAccountingFilter(storeId,today,params),[storeId,today,params]);
  const [draft,setDraft]=useState(filter),[filterError,setFilterError]=useState('');
  useEffect(()=>setDraft(filter),[filter]);
  function setFilter(next:AccountingFilter){setParams(accountingSearch(next,params),{replace:true});}
  const defaultFilter=useMemo<AccountingFilter>(()=>({storeId,fromDate:before(today,29),toDate:today,fulfillment:'all',costMode:'current_estimate'}),[storeId,today]);
  const activeFilters=(filter.fulfillment!=='all'?1:0)+(filter.costMode!=='current_estimate'?1:0)+(filter.fromDate!==defaultFilter.fromDate||filter.toDate!==defaultFilter.toDate?1:0);
  const [filterOpen,setFilterOpen]=useState(false);
  function applyFilter(next:AccountingFilter){setFilterError('');setError(null);setNotice('');setLimitExceeded(false);setFilter(next);setFilterOpen(false);}
  function submitFilter(){const parsed=v.safeParse(accountingFilter,draft);if(!parsed.success||draft.fromDate>draft.toDate||(Date.parse(draft.toDate)-Date.parse(draft.fromDate))/86_400_000>=20_000){setFilterError('请选择有效的起止日期，范围过大。');return;}applyFilter(parsed.output);}
  function resetFilter(){const next={...defaultFilter};setDraft(next);applyFilter(next);}
  function presetRange(days:number){setDraft({...draft,fromDate:before(today,days-1),toDate:today});}
  function applyRange(days:number){const next:AccountingFilter={...filter,fromDate:before(today,days-1),toDate:today};setDraft(next);applyFilter(next);}
  const [tab,setTab]=useState('overview'),[after,setAfter]=useState<string[]>([]);
  const [costProduct,setCostProduct]=useState<AccountingConfig['products'][number]|null>(null),[rulesOpen,setRulesOpen]=useState(false),[importOpen,setImportOpen]=useState(false),[expenseOpen,setExpenseOpen]=useState(false),[voidId,setVoidId]=useState<string|null>(null);
  const [costTargetId,setCostTargetId]=useState<string|null>(null);
  const [pending,setPending]=useState(false),[error,setError]=useState<unknown>(null),[notice,setNotice]=useState(''),[limitExceeded,setLimitExceeded]=useState(false);
  const filterKey=`${filter.storeId}:${filter.fromDate}:${filter.toDate}:${filter.fulfillment}:${filter.costMode}`;
  const overview=useQuery({queryKey:['accounting',company.id,filter],queryFn:({signal})=>readAccounting(company.id,filter,signal),enabled:!limitExceeded});
  useEffect(()=>{if(overview.error instanceof ApiError&&overview.error.code==='ACCOUNTING_LIMIT')setLimitExceeded(true);},[overview.error]);
  useEffect(()=>setLimitExceeded(false),[filterKey]);
  const config=useQuery({queryKey:['accounting-config',company.id,storeId,after.at(-1)],queryFn:({signal})=>readAccountingConfig(company.id,storeId,after.at(-1),signal)});
  const targetConfig=useQuery({queryKey:['accounting-product-config',company.id,storeId,costTargetId],queryFn:({signal})=>readAccountingConfig(company.id,storeId,undefined,signal,costTargetId??undefined),enabled:costTargetId!==null});
  const targetProduct=targetConfig.data?.products.find(product=>product.id===costTargetId);
  async function invalidate(){await Promise.all([client.invalidateQueries({queryKey:['accounting',company.id]}),client.invalidateQueries({queryKey:['accounting-config',company.id,storeId]}),client.invalidateQueries({queryKey:['accounting-product-config',company.id,storeId]})]);}
  async function capture(){if(pending)return;setPending(true);setError(null);setNotice('');try{await captureAccounting(company.id,filter);await invalidate();setNotice('已冻结当前范围中成本完整的已送达包裹依据；仍为预估核算，不代表财务结算。');}catch(cause){setError(cause);}finally{setPending(false);}}
  const data=overview.data;
  const knownCostAvailable=data?.costComponents?Object.values(data.costComponents).some(component=>component.knownPostings>0):!!data?.counts.purchaseKnown;
  const showSubset=data?.totals.profit===null&&data.counts.complete>0;
  const completeRevenue=data?.postings.reduce((total,posting)=>total+(posting.profit!==null?posting.revenue??0:0),0)??0;
  const displayedMargin=showSubset?(completeRevenue?(data?.totals.knownContribution??0)/completeRevenue:null):data?.totals.margin??null;
  return <>
    <div className="flex flex-wrap items-center gap-3">
      <Popover open={filterOpen} onOpenChange={open=>{setFilterOpen(open);if(open){setDraft(filter);setFilterError('');}}}>
        <PopoverTrigger render={<Button variant="outline" size="sm" aria-label={activeFilters>0?`核算筛选，${activeFilters} 项条件`:'核算筛选'} title="核算筛选"/>}><SlidersHorizontal data-icon="inline-start"/>筛选{activeFilters>0&&<Badge variant="secondary">{activeFilters}</Badge>}</PopoverTrigger>
        <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] gap-3">
          <PopoverTitle>筛选核算范围</PopoverTitle>
          <form className="grid min-w-0 gap-3" onSubmit={event=>{event.preventDefault();submitFilter();}}>
            <Field><FieldLabel>统计区间</FieldLabel>
              <div className="flex flex-wrap gap-1" role="group" aria-label="常用核算日期">{[7,30,90].map(days=>{const active=draft.fromDate===before(today,days-1)&&draft.toDate===today;return <Button key={days} type="button" size="sm" variant={active?'default':'outline'} aria-pressed={active} onClick={()=>presetRange(days)}>近 {days} 天</Button>;})}<Button type="button" size="sm" variant={draft.fromDate===ALL_TIME_FROM?'default':'outline'} aria-pressed={draft.fromDate===ALL_TIME_FROM} onClick={()=>setDraft({...draft,fromDate:ALL_TIME_FROM,toDate:today})}>全部历史</Button></div>
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5"><Input className="min-w-0" type="date" aria-label="开始日期" value={draft.fromDate} onChange={event=>setDraft({...draft,fromDate:event.target.value})}/><span className="text-xs text-muted-foreground">至</span><Input className="min-w-0" type="date" aria-label="结束日期" value={draft.toDate} min={draft.fromDate||undefined} onChange={event=>setDraft({...draft,toDate:event.target.value})}/></div>
              <PopoverDescription>按下单时间归集；缺少下单时间时沿用订单中心的创建 / 处理时间。仅统计已同步且已送达的包裹。单次核算最多 5000 条包裹或费用记录；超长区间自动按月汇总趋势。</PopoverDescription>
            </Field>
            <Field><FieldLabel>履约方式</FieldLabel><div className="flex flex-wrap gap-1" role="group" aria-label="履约方式">{(['all','fbs','fbo','fbp'] as const).map(value=><Button key={value} type="button" size="sm" variant={draft.fulfillment===value?'default':'outline'} aria-pressed={draft.fulfillment===value} onClick={()=>setDraft({...draft,fulfillment:value})}>{value==='all'?'全部':value.toUpperCase()}</Button>)}</div></Field>
            <Field><FieldLabel htmlFor="accounting-cost-mode">成本依据</FieldLabel><NativeSelect id="accounting-cost-mode" value={draft.costMode??'historical'} onChange={event=>setDraft({...draft,costMode:event.target.value as AccountingFilter['costMode']})}><NativeSelectOption value="historical">订单日期历史成本</NativeSelectOption><NativeSelectOption value="current_estimate">历史缺失时按当前成本预估</NativeSelectOption></NativeSelect></Field>
            {filterError&&<p role="alert" className="text-sm text-destructive">{filterError}</p>}
            <div className="flex items-center justify-end gap-2"><Button type="button" size="sm" variant="ghost" onClick={resetFilter}>重置</Button><Button type="submit" size="sm">应用筛选</Button></div>
          </form>
        </PopoverContent>
      </Popover>
      <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground tabular-nums">{filter.fromDate===ALL_TIME_FROM?'全部历史':`${filter.fromDate} 至 ${filter.toDate}`}</span> · {filter.fulfillment==='all'?'全部履约':filter.fulfillment.toUpperCase()} · {filter.costMode==='historical'?'订单日期历史成本':'当前成本预估'} · 仅已送达</p>
      <Button className="ml-auto" variant="ghost" size="sm" disabled={overview.isFetching} onClick={()=>void overview.refetch()}><RefreshCw/>刷新</Button>
    </div>
    {error!=null&&<ErrorNotice error={error}/>} {notice&&<p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    <Tabs value={tab} onValueChange={value=>setTab(String(value))} className="gap-5"><TabsList aria-label="核算中心页面"><TabsTrigger value="overview">经营总览</TabsTrigger><TabsTrigger value="details">核算明细</TabsTrigger><TabsTrigger value="settings">成本与规则</TabsTrigger></TabsList>
      <TabsContent value="overview" className="grid min-w-0 gap-5">
        {limitExceeded?<Card><CardHeader><CardTitle>当前范围记录过多</CardTitle><CardDescription>{filter.fromDate===ALL_TIME_FROM?'全部历史范围':`${filter.fromDate} 至 ${filter.toDate}`}的已送达包裹或费用记录超过单次核算上限（5000 条），因此没有生成看板。请缩短日期范围，例如改为近 30 天或近 7 天。</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-2"><Button size="sm" onClick={()=>applyRange(30)}>改为近 30 天</Button><Button size="sm" variant="outline" onClick={()=>applyRange(7)}>改为近 7 天</Button><Button size="sm" variant="ghost" onClick={()=>setFilterOpen(true)}>调整筛选</Button>{overview.isFetching&&<span className="self-center text-xs text-muted-foreground">正在重新读取…</span>}</CardContent></Card>:overview.isError?<ErrorNotice error={overview.error}/>:overview.isPending?<LoadingState>正在核算…</LoadingState>:data&&<>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{([{label:'已知销售额',value:formatCny(data.counts.revenueKnown?data.totals.revenue:null)},{label:data.totals.cost===null?'已知成本小计（部分）':'预估总成本',value:formatCny(data.totals.cost===null?(knownCostAvailable?data.totals.knownCost??data.totals.knownPurchase:null):data.totals.cost)},{label:showSubset?'已核算包裹贡献':filter.fulfillment==='all'?'预估经营利润':'预估订单贡献',value:formatCny(showSubset?data.totals.knownContribution:data.totals.profit)},{label:showSubset?'已核算包裹贡献率':'预估利润率',value:displayedMargin===null?'—':`${(displayedMargin*100).toFixed(1)}%`}] as const).map(item=><Card key={item.label} className="gap-3"><CardHeader><CardTitle className="text-sm font-normal text-muted-foreground">{item.label}</CardTitle></CardHeader><CardContent className="text-2xl font-semibold tracking-tight tabular-nums">{item.value}</CardContent></Card>)}</div>
          {data.totals.profit===null&&data.counts.complete>0&&<p role="status" className="text-sm text-muted-foreground">成本完整的 {data.counts.complete} 个包裹预估贡献合计 <span className="font-medium text-foreground">{formatCny(data.totals.knownContribution)}</span>。仅覆盖已补全包裹，未扣整店广告和其他期间费用，不代表整店利润。</p>}
          {data.counts.eligible||data.expenses.length?<AccountingCharts data={data} includePeriodCosts={filter.fulfillment==='all'}/>:<Empty><EmptyHeader><EmptyTitle>当前范围暂无可核算订单</EmptyTitle><EmptyDescription>调整日期、检查订单同步，并录入商品成本和费用规则。</EmptyDescription></EmptyHeader><EmptyContent><Button variant="outline" onClick={()=>setTab('settings')}>设置成本与规则</Button></EmptyContent></Empty>}
          <p className="text-xs text-muted-foreground">当前范围另有 {data.counts.excluded} 个未送达、已取消或其他状态包裹未计入。未包含退款损失及未录入费用，不能视作真实净利润。</p>
          <section aria-label="核算资料与口径" className="grid gap-3 border-t pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">成本完整 {data.counts.complete} / {data.counts.eligible} 个已送达包裹 · 依据已冻结 {data.counts.frozen} 个</p>{canEdit&&<Button variant="outline" size="sm" disabled={pending||!data.counts.complete||filter.costMode==='current_estimate'} onClick={()=>void capture()}>{pending&&<Spinner/>}冻结当前核算依据</Button>}</div>
            {(data.counts.complete<data.counts.eligible||data.counts.undated>0)&&<Alert><AlertTitle>有资料需要补全</AlertTitle><AlertDescription><p>{data.counts.eligible-data.counts.complete} 个包裹资料不完整。已知销售额覆盖 {data.counts.revenueKnown} / {data.counts.eligible} 个，已知采购成本覆盖 {data.counts.purchaseKnown} / {data.counts.eligible} 个；另有 {data.counts.undated} 个包裹时间未知。</p>{config.data?.coverage&&<p>已录入 {config.data.coverage.costed} / {config.data.coverage.products} 个商品成本，最早成本版本自 {config.data.coverage.earliestDate??'未知日期'} 生效；不自动将今天导入的成本当作历史采购价。</p>}{config.data&&!config.data.rules.length&&<p>尚未配置费用与汇率规则，物流及提现费用未知，因此暂不能给出完整利润。</p>}<div className="mt-2 flex flex-wrap gap-2">{filter.costMode!=='current_estimate'&&!!config.data?.coverage?.costed&&<Button size="sm" variant="outline" onClick={()=>{const next={...filter,costMode:'current_estimate' as const};setFilter(next);setDraft(next);setNotice('');}}>按当前成本预估历史订单</Button>}{canEdit&&config.data&&<Button size="sm" variant="outline" onClick={()=>setRulesOpen(true)}>配置费用规则</Button>}<Button size="sm" variant="ghost" onClick={()=>setTab('details')}>查看缺失明细</Button><Button size="sm" variant="outline" onClick={()=>setTab('settings')}>补录缺失商品成本</Button></div></AlertDescription></Alert>}
            {filter.costMode==='current_estimate'&&<Alert><AlertTitle>当前成本预估，不是历史实际成本</AlertTitle><AlertDescription>历史成本缺失时，使用当前版本参考价。当前有 {data.counts.currentEstimate} 个包裹使用此依据，采购成本覆盖 {data.counts.purchaseKnown} / {data.counts.eligible} 个包裹；不改写原始生效日期，不允许冻结为历史依据。费用规则仍按订单日期匹配，未知费用需补录。</AlertDescription></Alert>}
          </section>
        </>}
      </TabsContent>
      <TabsContent value="details" className="grid min-w-0 gap-4">{overview.isError?<ErrorNotice error={overview.error}/>:overview.isPending?<Spinner/>:data&&<AccountingDetails key={JSON.stringify(filter)} data={data}/>}</TabsContent>
      <TabsContent value="settings" className="grid min-w-0 gap-6">
        {data&&!overview.isError&&<AccountingCostGaps key={JSON.stringify(filter)} data={data} canEdit={canEdit} onEdit={setCostTargetId} onRules={()=>setRulesOpen(true)}/>}
        <section className="grid gap-3"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">费用与汇率规则</h2>{canEdit&&<Button variant="outline" size="sm" disabled={!config.data||config.isError} onClick={()=>setRulesOpen(true)}>新增规则版本</Button>}</div>
          {config.isPending?<p role="status"><Spinner/>正在读取配置…</p>:config.isError?<ErrorNotice error={config.error}/>:config.data.rules.length?<div className="grid gap-2">{config.data.rules.map((rule,index)=><div key={rule.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border/70 bg-card p-3 text-xs"><Badge variant="outline">{index===0?'最新版本':'历史版本'}</Badge><span>{rule.validFrom} 起生效</span><span>佣金 {(Number(rule.commissionRate)*100).toFixed(2)}%</span><span>运费 {rule.freightPerKg} 元/kg + {rule.freightPerPosting} 元/包裹</span><span>{rule.rubToCny?`1 RUB = ${rule.rubToCny} CNY`:'RUB 汇率未录入（仅涉 RUB 时需要）'}</span></div>)}</div>:<p className="text-sm text-muted-foreground">尚未配置规则。请填写真实适用的佣金、物流、提现费率与汇率；无费用可显式填 0。</p>}
          <p className="text-xs text-muted-foreground">展示最近 10 个版本。运费为「重量 × 每公斤运费 + 每包裹基础运费」的线性预估，复杂阶梯费率暂不支持。</p>
        </section>
        <section className="grid gap-3"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">商品核算成本</h2>{canEdit&&<Button size="sm" variant="outline" disabled={!config.data||config.isError} onClick={()=>setImportOpen(true)}>导入成本 CSV</Button>}</div><p className="text-xs text-muted-foreground">通过商家货号精确匹配订单，不按商品名称匹配。采购价、单件贴单费和重量均需完整；与商品资料中的参考采购价独立，历史版本不覆盖。</p>
          {config.data&&!config.isError&&<><Table><TableHeader><TableRow><TableHead>商品 / 货号</TableHead><TableHead>采购价</TableHead><TableHead>贴单费</TableHead><TableHead>重量</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{config.data.products.map(product=><TableRow key={product.id}><TableCell className="max-w-64 whitespace-normal">{product.name}<p className="text-xs text-muted-foreground">{product.offerId}</p></TableCell><TableCell>{product.cost?`${product.cost.purchasePrice} ${product.cost.purchaseCurrency}`:'待补全'}</TableCell><TableCell>{product.cost?`${product.cost.labelFee} CNY`:'—'}</TableCell><TableCell>{product.cost?`${product.cost.weightGrams} g`:'—'}</TableCell><TableCell><Button size="sm" variant="ghost" disabled={!canEdit} aria-label={`维护成本：${product.offerId}`} onClick={()=>setCostProduct(product)}>维护成本</Button></TableCell></TableRow>)}</TableBody></Table>{!config.data.products.length&&<p className="text-sm text-muted-foreground">还没有同步商品，请前往店铺管理检查商品同步。</p>}<div className="flex justify-between"><Button size="sm" variant="outline" disabled={!after.length||config.isFetching} onClick={()=>setAfter(value=>value.slice(0,-1))}>上一页</Button><Button size="sm" variant="outline" disabled={!config.data.nextProductId||config.isFetching} onClick={()=>{const next=config.data?.nextProductId;if(next)setAfter(value=>[...value,next]);}}>下一页</Button></div></>}
        </section>
        <section className="grid gap-3"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">期间费用</h2>{canEdit&&<Button size="sm" variant="outline" onClick={()=>setExpenseOpen(true)}><Plus/>登记费用</Button>}</div><p className="text-xs text-muted-foreground">展示当前日期范围的整店费用。录入其他日期的费用后，请调整日期查看；按履约方式筛选时不扣除此处费用。</p>{overview.isError?<ErrorNotice error={overview.error}/>:overview.isPending?<Spinner/>:data&&<Table><TableHeader><TableRow><TableHead>日期</TableHead><TableHead>类别 / 说明</TableHead><TableHead>金额</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{data.expenses.map(expense=><TableRow key={expense.id}><TableCell>{expense.date}</TableCell><TableCell className="max-w-64 whitespace-normal">{expense.category==='advertising'?'广告':'其他'} · {expense.note}</TableCell><TableCell>{formatCny(expense.amount)}</TableCell><TableCell><Button variant="ghost" size="sm" disabled={!canEdit||pending} onClick={()=>{setError(null);setVoidId(expense.id);}}>作废</Button></TableCell></TableRow>)}</TableBody></Table>}{data&&!data.expenses.length&&<p className="text-sm text-muted-foreground">当前范围尚无已登记费用，不代表实际费用为零。</p>}</section>
        {!canEdit&&<p className="text-sm text-muted-foreground">仅公司所有者和管理员可以维护成本、规则及费用。</p>}
      </TabsContent>
    </Tabs>
    <details className="group rounded-xl border border-border/70 bg-card/60 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium outline-none select-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"><Info aria-hidden="true" className="size-4 shrink-0 text-muted-foreground"/><span>预估经营分析，不是结算账本</span><ChevronDown aria-hidden="true" className="ms-auto size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"/></summary>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">尚未接入退款与平台财务账单。采购和期间费用由商家录入；佣金优先用平台回传费率估算，其次用商品/店铺规则。物流、提现按历史规则估算，均不是已核对账单。已知销售额独立展示，不因缺少成本而隐藏；总成本、利润和利润率在资料不完整时显示「—」，不把未知当成 0。期间费用按实际登记计入。冻结只固定历史成本与汇率依据，不代表费用已核对。{filter.fulfillment!=='all'&&' 当前按履约方式筛选，仅核算订单贡献，不扣除整店期间费用。'}</p>
    </details>
    {importOpen&&config.data&&<Suspense fallback={<p role="status">正在加载导入工具…</p>}><AccountingImportDialog companyId={company.id} storeId={storeId} products={config.data.products} startDate={filter.fromDate} close={()=>setImportOpen(false)} saved={invalidate}/></Suspense>}
    {costTargetId&&(targetProduct?<AccountingCostDialog key={costTargetId} companyId={company.id} storeId={storeId} product={targetProduct} startDate={today} close={()=>setCostTargetId(null)} saved={invalidate}/>:<Dialog open onOpenChange={open=>{if(!open)setCostTargetId(null);}}><DialogContent><DialogHeader><DialogTitle>读取商品核算成本</DialogTitle><DialogDescription>正在定位所选缺失商品，不按名称猜测或套用其他商品价格。</DialogDescription></DialogHeader>{targetConfig.isPending?<p role="status"><Spinner/>正在读取…</p>:targetConfig.isError?<ErrorNotice error={targetConfig.error}/>:<p>该商品当前不可访问，请刷新数据后重试。</p>}</DialogContent></Dialog>)}
    {costProduct&&<AccountingCostDialog companyId={company.id} storeId={storeId} product={costProduct} startDate={costProduct.cost?today:filter.fromDate} close={()=>setCostProduct(null)} saved={invalidate}/>}
    {rulesOpen&&<AccountingRulesDialog companyId={company.id} storeId={storeId} current={config.data?.rules[0]} startDate={config.data?.rules.length?today:filter.fromDate} close={()=>setRulesOpen(false)} saved={invalidate}/>}
    {expenseOpen&&<AccountingExpenseDialog companyId={company.id} storeId={storeId} today={today} close={()=>setExpenseOpen(false)} saved={invalidate}/>}
    {voidId&&<Dialog open onOpenChange={open=>{if(!open&&!pending)setVoidId(null);}}><DialogContent><DialogHeader><DialogTitle>作废这笔费用？</DialogTitle><DialogDescription>费用将从核算中移除，原始记录和作废操作仍保留。若金额有误，请作废后重新登记。</DialogDescription></DialogHeader>{error!=null&&<ErrorNotice error={error}/>}<Button variant="destructive" disabled={pending} onClick={async()=>{if(pending)return;setPending(true);setError(null);try{await voidAccountingExpense(company.id,storeId,voidId);await invalidate();setVoidId(null);}catch(cause){setError(cause);}finally{setPending(false);}}}>{pending&&<Spinner/>}确认作废</Button></DialogContent></Dialog>}
  </>;
}
