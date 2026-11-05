import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readOzonFbsPosting,readOzonFbpPosting} from '../src/modules/orders/ozon.ts';
const credentials={clientId:'1',apiKey:'synthetic-read-only-key'};
const base={posting_number:'p-1',order_id:'1',order_number:'o-1',status:'delivered',products:[{sku:'111',offer_id:'offer',name:'Product',quantity:2,price:'20',currency_code:'CNY'}]};

test('FBS details request finance, retain only correlated commission rate and do not mix RUB amounts into CNY',async()=>{
 const result=await readOzonFbsPosting(credentials,{postingNumber:'p-1'},async(_input,init)=>{
  assert.deepEqual(JSON.parse(String(init?.body)),{posting_number:'p-1',with:{financial_data:true}});
  return Response.json({result:{...base,financial_data:{products:[{product_id:'111',quantity:2,commission_percent:12,commission_amount:-43.8,currency_code:'RUB',payout:321.2}]}}});
 });
 assert.equal(result.products[0]!.commissionRate,'0.12');assert.equal(result.products[0]!.price,'20');assert.equal(result.products[0]!.currency,'CNY');assert.equal('commission_amount' in result.products[0]!,false);
});
test('FBP details retain posting commission percent without treating an unqualified delivery zero as total freight',async()=>{
 const result=await readOzonFbpPosting(credentials,{postingNumber:'p-1'},async()=>Response.json({posting:{...base,status:380,products:[{...base.products[0],marketplace_seller_price:{amount:'20',currency:'CNY'}}],financial_data:{delivery_amount:0,products:[{sku:'111',quantity:2,posting_commission:{percent:12.5,amount:-43.8},commissions_price:{amount:'29.26',currency:'RUB'}}]}}}));
 assert.equal(result.products[0]!.commissionRate,'0.125');assert.equal('freight' in result,false);
});
test('unrelated, ambiguous and invalid optional finance rows cannot contaminate order observations',async()=>{
 for(const products of [[{product_id:'222',quantity:2,commission_percent:12}],[{product_id:'111',quantity:1,commission_percent:12}],[{product_id:'111',quantity:2,commission_percent:12},{product_id:'111',quantity:2,commission_percent:15}],[{product_id:'111',quantity:2,commission_percent:-1}],[{product_id:'111',quantity:2,commission_percent:101}]]){
  const result=await readOzonFbsPosting(credentials,{postingNumber:'p-1'},async()=>Response.json({result:{...base,financial_data:{products}}}));assert.equal(result.products[0]!.commissionRate,undefined);
 }
 const zero=await readOzonFbsPosting(credentials,{postingNumber:'p-1'},async()=>Response.json({result:{...base,financial_data:{products:[{product_id:'111',quantity:2,commission_percent:0}]}}}));assert.equal(zero.products[0]!.commissionRate,'0');
});
