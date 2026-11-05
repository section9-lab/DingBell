import {useMemo,useState} from 'react';
import type {AccountingOverview} from '../../shared/accounting';
import {accountingMoney} from './accounting-charts';
import {Badge} from './ui/badge';
import {Button} from './ui/button';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from './ui/table';

type Gap={productId:string|null;offerId:string;name:string;quantity:number;revenue:number;postings:Set<string>;fields:Set<string>};
export function AccountingCostGaps({data,canEdit,onEdit,onRules}:{data:AccountingOverview;canEdit:boolean;onEdit:(productId:string)=>void;onRules:()=>void}){
  const [page,setPage]=useState(0);
  const rows=useMemo(()=>{
    const groups=new Map<string,Gap>();
    for(const posting of data.postings)for(const line of posting.lines){
      const fields:string[]=[];
      if(line.purchase===null)fields.push(line.purchaseUnitPrice?'采购汇率':'采购价');
      if(line.label===null)fields.push('贴单费');
      if(line.weightGrams==null)fields.push('计费重量');
      if(!fields.length)continue;
      const key=line.productId??line.offerId,current=groups.get(key)??{productId:line.productId,offerId:line.offerId,name:line.name,quantity:0,revenue:0,postings:new Set<string>(),fields:new Set<string>()};
      current.quantity+=line.quantity;current.revenue+=line.revenue??0;current.postings.add(`${posting.fulfillment}:${posting.postingNumber}`);for(const field of fields)current.fields.add(field);groups.set(key,current);
    }
    return [...groups.values()].sort((a,b)=>b.revenue-a.revenue||a.offerId.localeCompare(b.offerId));
  },[data]);
  const pages=Math.max(1,Math.ceil(rows.length/20)),currentPage=Math.min(page,pages-1);
  return <section aria-labelledby="accounting-gaps-title" className="grid gap-3">
    <h2 id="accounting-gaps-title" className="text-base font-semibold">待补全商品 · {rows.length} 个</h2>
    <p className="text-xs leading-5 text-muted-foreground">按涉及销售额从高到低排列，优先补录影响最大的商品。直接定位商品，无须在 600 个商品中逐页查找。采购价不能从售价或相似名称推断；填写后自动重新核算。运费、提现和缺失汇率在上方费用规则维护。</p>
    {rows.length?<><Table><TableHeader><TableRow><TableHead>商品 / 货号</TableHead><TableHead>包裹 / 件数</TableHead><TableHead>涉及销售额</TableHead><TableHead>缺失字段</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{rows.slice(currentPage*20,(currentPage+1)*20).map(row=><TableRow key={row.productId??row.offerId}>
      <TableCell className="max-w-72 whitespace-normal"><p>{row.name}</p><p className="break-all text-xs text-muted-foreground">{row.offerId}</p></TableCell><TableCell>{row.postings.size} / {row.quantity}</TableCell><TableCell className="tabular-nums">{accountingMoney(row.revenue)}</TableCell><TableCell className="max-w-52 whitespace-normal"><div className="flex flex-wrap gap-1">{[...row.fields].map(field=><Badge key={field} variant="outline">{field}</Badge>)}</div></TableCell>
      <TableCell>{row.fields.size===1&&row.fields.has('采购汇率')?<Button size="sm" variant="outline" disabled={!canEdit} onClick={onRules}>配置汇率</Button>:<Button size="sm" variant="outline" disabled={!canEdit||row.productId===null} aria-label={`补录成本：${row.offerId}`} onClick={()=>{if(row.productId)onEdit(row.productId);}}>补录成本</Button>}{!row.productId&&<p className="mt-1 text-xs text-muted-foreground">需先确认商品货号映射</p>}</TableCell>
    </TableRow>)}</TableBody></Table>{pages>1&&<nav aria-label="缺失成本分页" className="flex items-center justify-between"><Button size="sm" variant="outline" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>上一页</Button><span className="text-xs text-muted-foreground">第 {currentPage+1} / {pages} 页</span><Button size="sm" variant="outline" disabled={currentPage+1>=pages} onClick={()=>setPage(currentPage+1)}>下一页</Button></nav>}</>:<p className="text-sm text-muted-foreground">当前范围内没有缺失采购价、贴单费或重量的商品；仍需检查费用规则及数据覆盖率。</p>}
  </section>;
}
