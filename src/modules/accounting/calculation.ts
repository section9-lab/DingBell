import type {AccountingLine,AccountingOverview,AccountingPosting,CostBasis,FrozenBasis,RuleBasis} from '../../shared/accounting.ts';
import {nextDate} from '../../shared/time-zone.ts';

export type SaleLine={offerId:string;name:string|null;quantity:number;price:string|null;currency:string|null;commissionRate?:string|null};
export type SalePosting={postingNumber:string;orderNumber:string;fulfillment:'fbs'|'fbo'|'fbp';date:string;products:SaleLine[]};
const scale=10_000n;
function scaled(value:string):bigint|null {
  if(!/^\d{1,12}(\.\d{1,4})?$/.test(value))return null;
  const [whole,fraction='']=value.split('.');return BigInt(whole!)*scale+BigInt(fraction.padEnd(4,'0'));
}
function rounded(value:bigint,divisor:bigint){const result=Number((value+divisor/2n)/divisor);if(!Number.isSafeInteger(result))throw new RangeError('ACCOUNTING_AMOUNT_OVERFLOW');return result;}
export function moneyCents(value:string,quantity=1,exchange='1'):number|null {
  // Platform prices can contain more decimal places than merchant inputs. Preserve them
  // until the final currency conversion; never round a unit price before multiplying quantity.
  if(!/^\d{1,12}(\.\d{1,12})?$/.test(value))return null;
  const [whole,fraction='']=value.split('.'),price=BigInt(`${whole}${fraction}`),priceScale=10n**BigInt(fraction.length),fx=scaled(exchange);
  if(fx===null||!Number.isSafeInteger(quantity)||quantity<0||quantity>100_000)return null;
  return rounded(price*BigInt(quantity)*fx*100n,priceScale*scale);
}
function rateCents(cents:number,rate:string){
  if(!/^\d(\.\d{1,12})?$/.test(rate))return null;
  const [whole,fraction='']=rate.split('.'),coefficient=BigInt(`${whole}${fraction}`),divisor=10n**BigInt(fraction.length);
  return coefficient>divisor?null:rounded(BigInt(cents)*coefficient,divisor);
}
function exchange(currency:string|null,rules:RuleBasis|null){return currency==='CNY'?'1':currency==='RUB'?rules?.rubToCny??null:currency==='USD'?rules?.usdToCny??null:currency==='EUR'?rules?.eurToCny??null:null;}
function sum(values:(number|null)[]){
  if(!values.length)return null;
  if(values.some(value=>value===null))return null;
  const result=values.reduce<number>((total,value)=>total+(value??0),0);
  if(!Number.isSafeInteger(result))throw new RangeError('ACCOUNTING_AMOUNT_OVERFLOW');return result;
}
export function calculatePosting(sale:SalePosting,costs:(CostBasis|null)[],rules:RuleBasis|null,frozen=false):AccountingPosting {
  const missing=new Set<string>();if(!rules)missing.add('缺少订单日期生效的费用与汇率规则');
  if(!sale.products.length)missing.add('缺少商品明细');
  const lines:AccountingLine[]=sale.products.map((item,index)=>{
    const cost=costs[index]??null,saleFx=exchange(item.currency,rules),purchaseFx=exchange(cost?.purchaseCurrency??null,rules);
    const revenue=saleFx!==null&&item.price!==null?moneyCents(item.price,item.quantity,saleFx):null;
    const purchase=cost&&purchaseFx!==null?moneyCents(cost.purchasePrice,item.quantity,purchaseFx):null;
    const label=cost?.labelFee!==null&&cost?.labelFee!==undefined?moneyCents(cost.labelFee,item.quantity):null;
    const commissionRate=item.commissionRate??cost?.commissionRate??rules?.commissionRate;
    const commission=revenue!==null&&commissionRate!==undefined?rateCents(revenue,commissionRate):null;
    const freightRate=rules?scaled(rules.freightPerKg):null;
    const freight=freightRate!==null&&cost?.weightGrams?rounded(BigInt(cost.weightGrams)*BigInt(item.quantity)*freightRate,100_000n):null;
    if(commission===null&&rules)missing.add(`${item.offerId}：佣金费率无效或售价不完整`);
    if(revenue===null)missing.add(`${item.offerId}：缺少售价、币种或汇率`);
    if(!cost)missing.add(`${item.offerId}：缺少唯一匹配且在订单日期生效的成本`);
    if(purchase===null&&cost)missing.add(`${item.offerId}：采购金额或采购汇率不完整`);
    if(label===null&&cost)missing.add(`${item.offerId}：单件贴单费未录入`);
    if(cost&&!cost.weightGrams)missing.add(`${item.offerId}：计费重量未录入`);
    if(!Number.isSafeInteger(item.quantity)||item.quantity<=0)missing.add(`${item.offerId}：商品数量无效`);
    if(freight===null&&rules&&cost?.weightGrams)missing.add(`${item.offerId}：物流费率不完整`);
    return {purchaseUnitPrice:cost?.purchasePrice??null,purchaseCurrency:cost?.purchaseCurrency??null,weightGrams:cost?.weightGrams??null,productId:cost?.productId??null,offerId:item.offerId,name:item.name??item.offerId,quantity:item.quantity,revenue,purchase,label,commission,freight,commissionSource:commission===null?null:item.commissionRate!=null?'platform_rate':cost?.commissionRate!=null?'cost_model':'store_rule'};
  });
  const revenue=sum(lines.map(line=>line.revenue)),purchase=sum(lines.map(line=>line.purchase)),label=sum(lines.map(line=>line.label)),commission=sum(lines.map(line=>line.commission));
  const weightFreight=sum(lines.map(line=>line.freight)),baseFreight=rules?moneyCents(rules.freightPerPosting):null;
  const freight=weightFreight!==null&&baseFreight!==null?weightFreight+baseFreight:null;
  const settlement=revenue!==null&&commission!==null&&freight!==null?Math.max(0,revenue-commission-freight):null;
  const withdrawal=rules&&settlement!==null?rateCents(settlement,rules.withdrawalRate):null;
  const cost=missing.size?null:sum([purchase,label,commission,freight,withdrawal]);
  return {postingNumber:sale.postingNumber,orderNumber:sale.orderNumber,fulfillment:sale.fulfillment,date:sale.date,lines,revenue,cost,purchase,label,commission,freight,withdrawal,profit:cost!==null&&revenue!==null?revenue-cost:null,frozen,costSource:frozen?'frozen':'historical',missing:[...missing]};
}
export function frozenBasis(costs:(CostBasis|null)[],rules:RuleBasis|null):FrozenBasis|null {
  return rules&&costs.every((cost):cost is CostBasis=>cost!==null)?{version:1,rules,lines:costs}:null;
}
export function summarize(postings:AccountingPosting[],expenses:AccountingOverview['expenses'],fromDate:string,toDate:string) {
  // Long periods are rolled up by month so the trend stays readable and bounded.
  const monthly=(Date.parse(toDate)-Date.parse(fromDate))/86_400_000>120,bucket=(date:string)=>monthly?date.slice(0,7):date;
  const totals:AccountingOverview['totals']={revenue:0,knownPurchase:0,knownContribution:0,cost:0,profit:0,margin:null,purchase:0,label:0,commission:0,freight:0,withdrawal:0,advertising:0,other:0};
  const trend=new Map<string,AccountingOverview['trend'][number]>(),orderDays=new Set<string>(),knownCostDays=new Set<string>();
  for(let date=fromDate;date<=toDate;date=nextDate(date)){const key=bucket(date);if(!trend.has(key))trend.set(key,{date:key,revenue:0,cost:0,profit:0,knownCost:0,knownContribution:0});}
  for(const posting of postings){
    // Sales and procurement facts remain useful even when freight/fees are unknown.
    // An incomplete cohort must never turn known sales into zero or partial profit into net profit.
    totals.revenue+=posting.revenue??0;totals.knownPurchase+=posting.purchase??0;totals.knownContribution+=posting.profit??0;
    for(const key of ['cost','profit','purchase','label','commission','freight','withdrawal'] as const){
      const value=posting[key];totals[key]=totals[key]===null||value===null?null:totals[key]+value;
    }
    const key=bucket(posting.date),day=trend.get(key);if(day){
      day.knownContribution=(day.knownContribution??0)+(posting.profit??0);
      orderDays.add(key);day.revenue+=posting.revenue??0;day.cost=day.cost===null||posting.cost===null?null:day.cost+posting.cost;day.profit=day.profit===null||posting.profit===null?null:day.profit+posting.profit;
      const known=[posting.purchase,posting.label,posting.commission,posting.freight,posting.withdrawal].filter((value):value is number=>value!==null);
      if(known.length){knownCostDays.add(key);day.knownCost=(day.knownCost??0)+(sum(known)??0);}
    }
  }
  for(const expense of expenses){
    totals[expense.category==='advertising'?'advertising':'other']+=expense.amount;
    if(totals.cost!==null)totals.cost+=expense.amount;if(totals.profit!==null)totals.profit-=expense.amount;
    const key=bucket(expense.date),day=trend.get(key);if(day){knownCostDays.add(key);day.knownCost=(day.knownCost??0)+expense.amount;if(day.cost!==null)day.cost+=expense.amount;if(day.profit!==null)day.profit-=expense.amount;}
  }
  for(const amount of Object.values(totals))if(amount!==null&&!Number.isSafeInteger(amount))throw new RangeError('ACCOUNTING_AMOUNT_OVERFLOW');
  if(postings.some(posting=>posting.revenue===null)){totals.profit=null;}
  totals.margin=totals.revenue&&totals.profit!==null?totals.profit/totals.revenue:null;
  function component(key:'purchase'|'label'|'commission'|'freight'|'withdrawal'){
    const values=postings.map(posting=>posting[key]).filter((value):value is number=>value!==null);
    return {amount:sum(values)??0,knownPostings:values.length,totalPostings:postings.length,...(key==='commission'?{platformRatePostings:postings.filter(posting=>posting.commission!==null&&posting.lines.length>0&&posting.lines.every(line=>line.commissionSource==='platform_rate')).length}:{})};
  }
  const costComponents={purchase:component('purchase'),label:component('label'),commission:component('commission'),freight:component('freight'),withdrawal:component('withdrawal')};
  totals.knownCost=(sum(Object.values(costComponents).map(value=>value.amount))??0)+totals.advertising+totals.other;
  if(!Number.isSafeInteger(totals.knownCost))throw new RangeError('ACCOUNTING_AMOUNT_OVERFLOW');
  for(const date of orderDays)if(!knownCostDays.has(date))trend.get(date)!.knownCost=null;
  return {totals,trend:[...trend.values()],costComponents,trendGranularity:monthly?'month' as const:'day' as const};
}
