import { workspaceRoutes } from '../lib/routes';
import {useState} from 'react';
import {Link} from 'react-router';
import type {AccountingOverview} from '../../shared/accounting';
import {formatCny} from '../lib/format';
import {Badge} from './ui/badge';
import {Button} from './ui/button';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from './ui/table';

export function AccountingDetails({data}:{data:AccountingOverview}){
  const [view,setView]=useState<'orders'|'products'>('orders'),[page,setPage]=useState(0);
  const products=new Map<string,{offerId:string;name:string;quantity:number;revenue:number;purchase:number;revenueMissing:boolean;purchaseMissing:boolean;cost:number;missing:boolean}>();
  for(const posting of data.postings)for(const line of posting.lines){
    const key=line.productId??line.offerId,current=products.get(key)??{offerId:line.offerId,name:line.name,quantity:0,revenue:0,purchase:0,revenueMissing:false,purchaseMissing:false,cost:0,missing:false};
    current.quantity+=line.quantity;
    if(line.revenue===null)current.revenueMissing=true;else current.revenue+=line.revenue;
    if(line.purchase===null)current.purchaseMissing=true;else current.purchase+=line.purchase;
    if(line.revenue===null||line.purchase===null||line.label===null||line.commission===null||line.freight===null)current.missing=true;
    else current.cost+=line.purchase+line.label+line.commission+line.freight;
    products.set(key,current);
  }
  const sorted=[...products.values()].sort((a,b)=>(a.revenue-a.cost)-(b.revenue-b.cost));
  const rows=view==='orders'?data.postings:sorted,pages=Math.ceil(rows.length/25),safePage=Math.min(page,Math.max(0,pages-1));
  return <section className="grid gap-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold">核算明细</h2><div className="flex gap-2" role="group" aria-label="核算明细视角">{(['orders','products'] as const).map(value=><Button key={value} size="sm" variant={view===value?'default':'outline'} aria-pressed={view===value} onClick={()=>{setView(value);setPage(0);}}>{value==='orders'?'按包裹':'按商品'}</Button>)}</div></div>
    {view==='orders'?<Table><TableHeader><TableRow><TableHead>订单 / 包裹</TableHead><TableHead>销售额</TableHead><TableHead>采购成本</TableHead><TableHead>订单成本</TableHead><TableHead>贡献利润</TableHead><TableHead>核算依据</TableHead></TableRow></TableHeader><TableBody>{data.postings.slice(safePage*25,(safePage+1)*25).map(row=><TableRow key={`${row.fulfillment}:${row.postingNumber}`}><TableCell><Button variant="link" size="sm" className="h-auto p-0" render={<Link to={`${workspaceRoutes.orders}?${new URLSearchParams({store:data.storeId,posting:row.postingNumber,type:row.fulfillment})}`}/>}>{row.orderNumber}</Button><p className="text-xs text-muted-foreground">{row.fulfillment.toUpperCase()} · {row.postingNumber}</p><p className="text-xs text-muted-foreground">{row.date}</p></TableCell><TableCell className="tabular-nums">{formatCny(row.revenue)}</TableCell><TableCell className="tabular-nums">{formatCny(row.purchase)}</TableCell><TableCell className="tabular-nums">{formatCny(row.cost)}</TableCell><TableCell className="tabular-nums">{formatCny(row.profit)}</TableCell><TableCell className="max-w-80 whitespace-normal"><Badge variant="outline">{row.cost===null?'待补全':row.frozen?'预估 · 依据已冻结':'预估 · 未冻结'}</Badge>{row.costSource==='current_estimate'&&<p className="mt-1 text-xs text-muted-foreground">采购依据：当前成本预估，非历史实际</p>}{row.missing.length>0&&<ul className="mt-2 list-inside list-disc text-xs text-muted-foreground">{row.missing.map(text=><li key={text}>{text}</li>)}</ul>}<details className="mt-2 text-xs"><summary className="cursor-pointer rounded-sm text-muted-foreground focus-visible:outline focus-visible:outline-ring">查看成本来源</summary><dl className="mt-2 grid gap-1">{[['采购',row.purchase],['贴单',row.label],['佣金',row.commission],['物流',row.freight],['提现',row.withdrawal]].map(([label,amount])=><div key={label} className="flex justify-between gap-3"><dt>{label}</dt><dd>{formatCny(typeof amount==='number'?amount:null)}</dd></div>)}</dl><p className="mt-2 text-muted-foreground">售价：平台快照；采购/贴单：商家成本版本；佣金优先按平台回传费率估算，再按商品或店铺规则；物流/提现/汇率：规则估算。并非已核对账单。</p>{row.lines.some(line=>line.commissionSource==='platform_rate')&&<p className="mt-1 text-muted-foreground">此包裹已有平台回传佣金费率。</p>}</details></TableCell></TableRow>)}</TableBody></Table>:<><p className="text-xs leading-5 text-muted-foreground">按商品贡献从低到高排列。商品贡献扣采购、贴单、佣金和重量运费，尚未扣包裹基础运费、提现及期间费用；不是商品净利润。销售额和采购成本分别展示；贡献利润仍需相应成本完整。</p><Table><TableHeader><TableRow><TableHead>商品</TableHead><TableHead>数量</TableHead><TableHead>销售额</TableHead><TableHead>采购成本</TableHead><TableHead>商品贡献</TableHead></TableRow></TableHeader><TableBody>{sorted.slice(safePage*25,(safePage+1)*25).map(row=><TableRow key={row.offerId}><TableCell className="max-w-80 whitespace-normal">{row.name}<p className="text-xs text-muted-foreground">{row.offerId}</p></TableCell><TableCell>{row.quantity}</TableCell><TableCell>{formatCny(row.revenueMissing?null:row.revenue)}</TableCell><TableCell>{formatCny(row.purchaseMissing?null:row.purchase)}</TableCell><TableCell>{row.missing?'待补全':formatCny(row.revenue-row.cost)}</TableCell></TableRow>)}</TableBody></Table></>}
    {!rows.length&&<p className="py-8 text-center text-sm text-muted-foreground">当前范围没有已送达包裹。可调整日期或检查订单同步。</p>}
    {pages>1&&<nav aria-label="核算明细分页" className="flex items-center justify-between"><Button size="sm" variant="outline" disabled={safePage===0} onClick={()=>setPage(safePage-1)}>上一页</Button><span className="text-xs text-muted-foreground">第 {safePage+1} / {pages} 页</span><Button size="sm" variant="outline" disabled={safePage+1>=pages} onClick={()=>setPage(safePage+1)}>下一页</Button></nav>}
  </section>;
}
