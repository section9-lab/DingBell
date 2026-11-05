import assert from 'node:assert/strict';
import * as v from 'valibot';
import {test} from 'node:test';
import {calculatePosting,moneyCents,summarize,type SalePosting} from '../src/modules/accounting/calculation.ts';
import {accountingDate,costingInput,rulesInput,type CostBasis,type RuleBasis} from '../src/shared/accounting.ts';

const rule:RuleBasis={id:'rule',commissionRate:'0.1',withdrawalRate:'0.01',freightPerKg:'10',freightPerPosting:'2',rubToCny:'0.1',usdToCny:'7',eurToCny:'8'};
const cost:CostBasis={id:'cost',productId:'100',purchasePrice:'5',purchaseCurrency:'CNY',labelFee:'1',weightGrams:100,commissionRate:null};
const sale:SalePosting={postingNumber:'p',orderNumber:'o',fulfillment:'fbs',date:'2026-11-01',products:[{offerId:'offer',name:'Product',quantity:2,price:'200',currency:'RUB'}]};

test('money uses decimal integer arithmetic, converts currency and rounds half up once',()=>{
  assert.equal(moneyCents('0.1',3),30);assert.equal(moneyCents('1.005'),101);assert.equal(moneyCents('200',2,'0.1'),4000);
  assert.equal(moneyCents('0',1),0);assert.equal(moneyCents('-1'),null);assert.equal(moneyCents('1e2'),null);assert.equal(moneyCents('12.34567890',2,'0.1'),247);assert.equal(moneyCents('1.1234567890123'),null);assert.equal(moneyCents('1',1.5),null);
});
test('posting counts quantity, applies freight base once, and charges withdrawal on settlement',()=>{
  const result=calculatePosting(sale,[cost],rule);
  assert.equal(result.revenue,4000);assert.equal(result.purchase,1000);assert.equal(result.label,200);assert.equal(result.commission,400);
  assert.equal(result.freight,400);assert.equal(result.withdrawal,32);assert.equal(result.cost,2032);assert.equal(result.profit,1968);assert.deepEqual(result.missing,[]);
  const twoLines=calculatePosting({...sale,products:[...sale.products,...sale.products]},[cost,cost],rule);
  assert.equal(twoLines.freight,600,'per-parcel base is not duplicated');
});
test('missing basis, unknown currency, zero quantity and absent fees are never zero-cost profit',()=>{
  for(const result of [calculatePosting(sale,[null],rule),calculatePosting(sale,[cost],null),calculatePosting(sale,[{...cost,labelFee:null}],rule),calculatePosting({...sale,products:[{...sale.products[0]!,currency:'JPY'}]},[cost],rule),calculatePosting({...sale,products:[{...sale.products[0]!,quantity:0}]},[cost],rule)]){
    assert.equal(result.cost,null);assert.equal(result.profit,null);assert.ok(result.missing.length);
  }
  assert.equal(calculatePosting({...sale,products:[]},[],rule).profit,null);
});
test('explicit zero fees are valid, negative profit is preserved, and product commission override applies',()=>{
  const result=calculatePosting(sale,[{...cost,purchasePrice:'100',commissionRate:'0.2'}],{...rule,withdrawalRate:'0',freightPerKg:'0',freightPerPosting:'0'});
  assert.equal(result.commission,800);assert.equal(result.freight,0);assert.equal(result.withdrawal,0);assert.equal(result.profit,-17000);
});
test('period totals retain known sales, leave unknown profit blank, and subtract expenses once',()=>{
  const complete=calculatePosting(sale,[cost],rule),missing=calculatePosting(sale,[null],rule);
  const expenses=[{id:'x',date:'2026-11-02',category:'advertising' as const,amount:2000,note:'campaign'}];
  const partial=summarize([complete,missing],expenses,'2026-11-01','2026-11-03');
  assert.equal(partial.totals.revenue,8000,'cost gaps must not erase platform sales');assert.equal(partial.totals.knownPurchase,1000);assert.equal(partial.totals.knownContribution,1968,'subset contribution is distinct from whole-period net profit');
  assert.equal(partial.totals.cost,null);assert.equal(partial.totals.profit,null);assert.equal(partial.totals.margin,null);assert.equal(partial.trend[0]?.cost,null);assert.equal(partial.trend[0]?.profit,null);
  const {totals,trend}=summarize([complete],expenses,'2026-11-01','2026-11-03');
  assert.equal(totals.revenue,4000);assert.equal(totals.cost,4032);assert.equal(totals.profit,-32);assert.equal(totals.margin,-0.008);
  assert.deepEqual(trend.map(row=>row.profit),[1968,-2000,0]);assert.equal(trend.reduce((sum,row)=>sum+(row.profit??0),0),totals.profit);
});

test('CNY sales and imported commission remain visible without unrelated FX or freight rules',()=>{
  const cny={...sale,products:sale.products.map(line=>({...line,currency:'CNY',price:'20'}))};
  const posting=calculatePosting(cny,[{...cost,commissionRate:'0.15'}],null);
  assert.equal(posting.revenue,4000);assert.equal(posting.purchase,1000);assert.equal(posting.commission,600);
  assert.equal(posting.freight,null);assert.equal(posting.profit,null);
  const {totals,costComponents,trend}=summarize([posting],[],'2026-11-01','2026-11-01');assert.equal(totals.revenue,4000);assert.equal(totals.knownPurchase,1000);assert.equal(totals.profit,null);
  assert.equal(totals.knownCost,1800);assert.equal(costComponents.commission.amount,600);assert.equal(costComponents.label.amount,200);assert.equal(costComponents.freight.knownPostings,0);assert.equal(trend[0]?.knownCost,1800);
  const noFx={...rule,rubToCny:'',usdToCny:'',eurToCny:''};
  assert.equal(calculatePosting(cny,[{...cost,commissionRate:'0.15'}],noFx).profit,1770,'CNY-only orders do not require invented exchange rates');
  assert.equal(calculatePosting(sale,[cost],noFx).profit,null,'unknown RUB exchange is not silently 1');
  const observed=calculatePosting({...cny,products:cny.products.map(item=>({...item,commissionRate:'0.12'}))},[{...cost,commissionRate:'0.15'}],null);
  assert.equal(observed.commission,480);assert.equal(observed.lines[0]?.commissionSource,'platform_rate');
});
test('input schemas reject invalid calendar dates, unsupported currencies and out-of-range rates',()=>{
  assert.equal(v.safeParse(accountingDate,'2026-02-30').success,false);assert.equal(v.safeParse(accountingDate,'2024-02-29').success,true);
  const {id,...inputs}=rule;
  assert.equal(v.safeParse(rulesInput,{...inputs,storeId:'s',validFrom:'2026-11-01'}).success,true);
  assert.equal(v.safeParse(rulesInput,{...inputs,rubToCny:'',usdToCny:'',eurToCny:'',storeId:'s',validFrom:'2026-11-01'}).success,true);
  assert.equal(v.safeParse(rulesInput,{...inputs,storeId:'s',validFrom:'2026-11-01',commissionRate:'1.1'}).success,false);
  assert.equal(v.safeParse(costingInput,{storeId:'s',productId:'1',validFrom:'2026-11-01',purchasePrice:'0',purchaseCurrency:'CNY',labelFee:'0',weightGrams:1}).success,true);
});
