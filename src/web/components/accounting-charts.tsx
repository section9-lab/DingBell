import {useId} from 'react';
import {Area,AreaChart,Bar,BarChart,CartesianGrid,ReferenceLine,XAxis,YAxis} from 'recharts';
import type {AccountingOverview} from '../../shared/accounting';
import {formatCompactCny, formatCny} from '../lib/format';
import {Card,CardContent,CardDescription,CardHeader,CardTitle} from './ui/card';
import {ChartContainer,ChartTooltip,ChartTooltipContent,type ChartConfig} from './ui/chart';

const config={
  revenue:{label:'已知销售额',color:'var(--foreground)'},
  cost:{label:'总成本',color:'var(--muted-foreground)'},
  knownCost:{label:'已知成本小计（部分）',color:'var(--muted-foreground)'},
  profit:{label:'预估经营利润',color:'var(--foreground)'},
  knownContribution:{label:'已核算包裹贡献（部分）',color:'var(--foreground)'},
} satisfies ChartConfig;
const axis=formatCompactCny;

export function AccountingCharts({data,includePeriodCosts=true}:{data:AccountingOverview;includePeriodCosts?:boolean}){
  const id=useId().replaceAll(':','');
  const partial=data.totals.cost===null,costKey=partial?'knownCost':'cost',profitKey=data.totals.profit===null?'knownContribution':'profit';
  const monthly=data.trendGranularity==='month',tick=(value:string)=>monthly?String(value).slice(2):String(value).slice(5);
  function component(key:'purchase'|'label'|'commission'|'freight'|'withdrawal',label:string){
    const known=data.costComponents?.[key];
    const amount=known?(known.knownPostings?known.amount:null):data.totals[key];
    return {key,label,amount,note:known?`已知 ${known.knownPostings} / ${known.totalPostings} 个包裹${known.platformRatePostings===undefined?'':` · 平台费率 ${known.platformRatePostings}，规则估算 ${known.knownPostings-known.platformRatePostings}`}`:'待补全'};
  }
  const breakdown=[
    component('purchase','采购'),component('commission','平台佣金'),component('freight','物流'),component('label','贴单'),component('withdrawal','提现'),
    ...(['advertising','other'] as const).map(category=>{
      const recorded=data.expenses.filter(expense=>expense.category===category).length;
      return {key:category,label:category==='advertising'?'广告':'其他',amount:recorded&&includePeriodCosts?data.totals[category==='advertising'?'advertising':'other']:null,note:!includePeriodCosts?'整店费用未向履约方式分摊':recorded?`已登记 ${recorded} 笔`:'未登记，不代表无支出'};
    }),
  ];
  const maximum=Math.max(1,...breakdown.map(row=>row.amount??0));
  return <div className="grid min-w-0 gap-4 lg:grid-cols-2">
    <Card className="min-w-0 lg:col-span-2">
      <CardHeader><CardTitle>收入与成本趋势</CardTitle><CardDescription>{monthly?'按月汇总已送达包裹':'按下单日期归集已送达包裹'}。{partial?'虚线仅为已有采购、佣金、贴单等成本小计，不是完整成本，不能用两线差值当利润。':`成本含${monthly?'当月':'当日'}登记费用。`}未送达订单不在此图中，销售额不是结算到账。</CardDescription><div className="flex gap-4 text-xs"><span>实线：已知销售额</span><span>虚线：{partial?'已知成本（部分）':'总成本'}</span></div></CardHeader>
      <CardContent><ChartContainer config={config} aria-label="收入与成本趋势图，金额单位人民币；具体数值可在核算明细中查看">
        <AreaChart accessibilityLayer data={data.trend} margin={{left:0,right:12,top:10,bottom:0}}>
          <defs><linearGradient id={`${id}-revenue`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--color-revenue)" stopOpacity={0.2}/><stop offset="100%" stopColor="var(--color-revenue)" stopOpacity={0.02}/></linearGradient></defs>
          <CartesianGrid vertical={false}/><XAxis dataKey="date" tickFormatter={tick} minTickGap={32} tickLine={false} axisLine={false}/><YAxis tickFormatter={axis} width={56} tickLine={false} axisLine={false}/>
          <ChartTooltip content={<ChartTooltipContent formatter={formatCny}/>}/>
          <Area type="linear" dataKey="revenue" stroke="var(--color-revenue)" fill={`url(#${id}-revenue)`} strokeWidth={2} isAnimationActive={false}/>
          <Area type="linear" dataKey={costKey} stroke="var(--color-cost)" fill="var(--color-cost)" fillOpacity={0.06} strokeDasharray="5 4" strokeWidth={2} isAnimationActive={false}/>
        </AreaChart>
      </ChartContainer></CardContent>
    </Card>
    <Card className="min-w-0">
      <CardHeader><CardTitle>{profitKey==='knownContribution'?'已核算包裹贡献趋势':'预估利润趋势'}</CardTitle><CardDescription>{profitKey==='knownContribution'?`仅覆盖资料完整的 ${data.counts.complete} / ${data.counts.eligible} 个包裹，未分摊整店期间费用，不是整店净利润。`:'保留零基线，负值表示当日预估亏损。'}</CardDescription></CardHeader>
      <CardContent>{data.counts.complete===0&&data.totals.profit===null?<p role="status" className="flex h-72 items-center justify-center text-sm text-muted-foreground">费用或采购成本尚未补全，暂不能计算利润。</p>:<ChartContainer config={config} aria-label={profitKey==='knownContribution'?'已核算包裹贡献柱状图':'每日预估利润柱状图'}>
        <BarChart accessibilityLayer data={data.trend} margin={{left:0,right:12,top:10,bottom:0}}>
          <CartesianGrid vertical={false}/><XAxis dataKey="date" tickFormatter={tick} minTickGap={48} tickLine={false} axisLine={false}/><YAxis tickFormatter={axis} width={56} tickLine={false} axisLine={false}/><ReferenceLine y={0}/>
          <ChartTooltip content={<ChartTooltipContent formatter={formatCny}/>}/><Bar dataKey={profitKey} fill="var(--color-profit)" radius={2} isAnimationActive={false}/>
        </BarChart>
      </ChartContainer>}</CardContent>
    </Card>
    <Card><CardHeader><CardTitle>已知成本构成与覆盖率</CardTitle><CardDescription>各项独立汇总，不因其他字段缺失而全部隐藏。佣金可能按平台回传或商品费率估算，尚未与财务账单核对。</CardDescription></CardHeader>
      <CardContent><dl className="grid gap-4">{breakdown.map(row=><div key={row.key} className="grid grid-cols-[4rem_1fr_auto] items-center gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{row.label}</dt><div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true"><div className="h-full rounded-full bg-foreground/70" style={{width:`${(row.amount??0)/maximum*100}%`}}/></div><dd className="tabular-nums">{row.amount===null?'待补全':formatCny(row.amount)}</dd>
        <dd className="col-start-2 col-span-2 text-muted-foreground">{row.note}</dd>
      </div>)}</dl></CardContent>
    </Card>
  </div>;
}
