import assert from 'node:assert/strict';
import * as v from 'valibot';
import {test} from 'node:test';
import {conversationsFixture} from './fixtures/conversations.ts';
import {accountingConfig,accountingOverview} from '../src/shared/accounting.ts';

async function fixture(){
  const f=await conversationsFixture();
  const request=(path:string,body?:unknown,who='owner')=>f.app.request(`${f.env.APP_BASE_URL}/api/companies/company/accounting${path}`,{method:body===undefined?'GET':'POST',headers:{cookie:f.cookies[who]??'',origin:f.env.APP_BASE_URL,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},f.env as never);
  await f.DB.prepare(`INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,facts,facts_observed_at,detail_epoch,detail_generation,detail_due_at) VALUES('100','company','store-a',?,1,?,1,1,1,9999999999999)`).bind(JSON.stringify({id:'100',offerId:'offer-100'}),JSON.stringify({id:'100',offerId:'offer-100',name:'商品 A'})).run();
  const add=async(number:string,status='delivered',mode:'fbs'|'fbo'|'fbp'='fbs',date:string|null='2026-10-01T20:30:00Z')=>{
    const raw={postingNumber:number,orderId:'9001',orderNumber:'order-'+number,status,orderDate:date,inProcessAt:null,products:[{offerId:'offer-100',sku:'11',name:'商品 A',quantity:2,price:'200',currency:'RUB'}]};
    await f.DB.prepare(`INSERT INTO ${mode}_posting(posting_number,organization_id,store_id,order_id,order_number,list_facts,list_observed_at,detail_epoch,detail_generation,detail_due_at) VALUES(?,'company','store-a','9001',?,?,1,1,1,9999999999999)`).bind(number,raw.orderNumber,JSON.stringify(raw)).run();
  };
  await add('parcel');
  const rules={storeId:'store-a',validFrom:'2026-10-01',commissionRate:'0.1',withdrawalRate:'0.01',freightPerKg:'10',freightPerPosting:'2',rubToCny:'0.1',usdToCny:'7',eurToCny:'8'};
  const cost={storeId:'store-a',productId:'100',validFrom:'2026-10-01',purchasePrice:'5',purchaseCurrency:'CNY',labelFee:'1',weightGrams:100};
  const filter={storeId:'store-a',fromDate:'2026-10-01',toDate:'2026-10-31',fulfillment:'all'};
  const query='?'+new URLSearchParams(filter);
  const read=async()=>{const response=await request(query);assert.equal(response.status,200,await response.clone().text());return v.parse(accountingOverview, await response.json());};
  return {...f,request,add,rules,cost,filter,query,read};
}

test('accounting API versions costs, freezes atomic basis, preserves history and audits idempotent expenses',{timeout:90_000},async t=>{
  const f=await fixture();t.after(f.close);
  let data=await f.read();assert.equal(data.counts.eligible,1);assert.equal(data.counts.complete,0);assert.equal(data.postings[0]!.profit,null);assert.equal(data.totals.revenue,0);
  assert.equal((await f.request('/rules',f.rules)).status,200);assert.equal((await f.request('/costing',f.cost)).status,200);
  let response=await f.request('/config?storeId=store-a');assert.equal(response.status,200);const config=v.parse(accountingConfig, await response.json());assert.equal(config.products[0]!.cost?.purchasePrice,'5');
  data=await f.read();assert.equal(data.totals.profit,1968);assert.equal(data.postings[0]!.frozen,false);
  assert.equal((await f.request('/capture',f.filter)).status,200);assert.equal((await f.request('/capture',f.filter)).status,200);
  data=await f.read();assert.equal(data.counts.frozen,1);
  assert.equal((await f.DB.prepare('SELECT COUNT(*) AS n FROM accounting_posting_basis').first<{n:number}>())!.n,1);
  await assert.rejects(f.DB.prepare("UPDATE accounting_posting_basis SET inputs='{}'").run(),/IMMUTABLE/);
  assert.equal((await f.request('/costing',{...f.cost,purchasePrice:'100'})).status,409,'same-day replacement is not allowed');
  assert.equal((await f.request('/costing',{...f.cost,validFrom:'2026-10-02',purchasePrice:'100'})).status,200);
  assert.equal((await f.request('/rules',{...f.rules,validFrom:'2026-10-02',rubToCny:'0.2'})).status,200);
  assert.equal((await f.request('/rules',f.rules)).status,409);
  data=await f.read();assert.equal(data.totals.profit,1968,'historical frozen basis does not drift');
  await f.add('next','delivered','fbo','2026-10-02T10:00:00Z');
  data=await f.read();assert.equal(data.postings.find(row=>row.postingNumber==='next')!.revenue,8000);assert.ok(data.postings.find(row=>row.postingNumber==='next')!.profit!<0);
  const expense={id:crypto.randomUUID(),storeId:'store-a',date:'2026-10-01',category:'advertising',amount:'10',note:'广告日报'};
  assert.equal((await f.request('/expenses',expense)).status,200);assert.equal((await f.request('/expenses',expense)).status,200);
  assert.equal((await f.request('/expenses',{...expense,amount:'20'})).status,409,'same id cannot silently replace a cost');
  data=await f.read();assert.equal(data.expenses.length,1);assert.equal(data.totals.advertising,1000);
  response=await f.request('?'+new URLSearchParams({...f.filter,fulfillment:'fbs'}));assert.equal(response.status,200);const lane=v.parse(accountingOverview, await response.json());assert.equal(lane.totals.advertising,0,'no whole-store expense allocation to a lane');assert.equal(lane.totals.profit,1968);
  assert.equal((await f.request('/expenses/void',{storeId:'store-a',id:expense.id})).status,200);assert.equal((await f.request('/expenses/void',{storeId:'store-a',id:expense.id})).status,200);
  data=await f.read();assert.equal(data.expenses.length,0);assert.equal(data.totals.advertising,0);
  const audit=await f.DB.prepare('SELECT created_by AS creator,voided_by AS editor FROM accounting_expense WHERE id=?').bind(expense.id).first();assert.deepEqual(audit,{creator:'owner',editor:'owner'});
  assert.equal((await f.request('/expenses',expense)).status,409,'voided expense cannot be resurrected by retry');
});

test('accounting enforces live company/store permissions, validates input and uses business dates and FBP delivery status',{timeout:90_000},async t=>{
  const f=await fixture();t.after(f.close);
  assert.equal((await f.request(f.query,undefined,'staff')).status,200);assert.equal((await f.request(f.query,undefined,'other')).status,404);
  for(const [path,body] of [['/rules',f.rules],['/costing',f.cost],['/capture',f.filter],['/expenses',{id:crypto.randomUUID(),storeId:'store-a',date:'2026-10-01',category:'other',amount:'2',note:'fee'}]] as const)assert.equal((await f.request(path,body,'staff')).status,404);
  assert.equal((await f.request(f.query.replace('store-a','store-b'),undefined,'staff')).status,404);
  for(const query of [f.query+'&storeId=store-a',f.query+'&unknown=1',f.query.replace('2026-10-01','2026-02-30'),f.query.replace('2026-10-31','2026-09-01')])assert.equal((await f.request(query)).status,400);
  assert.equal((await f.request('/rules',{...f.rules,commissionRate:'1.1'})).status,400);
  assert.equal((await f.request('/costing',{...f.cost,purchasePrice:'-1'})).status,400);
  assert.equal((await f.request('/costing',{...f.cost,productId:'999'})).status,409);
  await f.request('/rules',f.rules);await f.request('/costing',f.cost);
  await f.add('cancel','cancelled');await f.add('transit','delivering');await f.add('undated','delivered','fbs',null);await f.add('numeric','380','fbp');
  let data=await f.read();assert.equal(data.counts.eligible,2);assert.equal(data.counts.excluded,2);assert.equal(data.counts.undated,1);
  await f.DB.prepare("INSERT INTO company_settings(organization_id,time_zone,version,updated_at) VALUES('company','Asia/Shanghai',1,1)").run();
  const response=await f.request('?'+new URLSearchParams({...f.filter,fromDate:'2026-10-02',toDate:'2026-10-02'}));assert.equal(response.status,200);data=v.parse(accountingOverview, await response.json());assert.equal(data.counts.eligible,2);assert.equal(data.postings[0]!.date,'2026-10-02');
  await f.DB.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();assert.equal((await f.request(f.query,undefined,'staff')).status,404);
});

test('frozen parcel identity is lane scoped and changed products fail closed',{timeout:90_000},async t=>{
  const f=await fixture();t.after(f.close);await f.request('/rules',f.rules);await f.request('/costing',f.cost);await f.add('parcel','delivered','fbo');
  assert.equal((await f.request('/capture',f.filter)).status,200);
  assert.equal((await f.DB.prepare('SELECT COUNT(*) AS n FROM accounting_posting_basis').first<{n:number}>())!.n,2);
  await f.DB.prepare("UPDATE fbs_posting SET list_facts=json_set(list_facts,'$.products[0].quantity',3)").run();
  const data=await f.read(),changed=data.postings.find(row=>row.fulfillment==='fbs')!;
  assert.equal(changed.profit,null);assert.ok(changed.missing.some(text=>text.includes('冻结依据不一致')));assert.equal(data.counts.complete,1);
  await f.DB.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<5001)
    INSERT INTO fbs_posting(posting_number,organization_id,store_id,order_id,order_number,list_facts,list_observed_at,detail_epoch,detail_generation,detail_due_at)
    SELECT 'bulk-'||n,'company','store-a','2','bulk-order',json_object('postingNumber','bulk-'||n,'orderId','2','orderNumber','bulk-order','status','delivered','orderDate','2026-10-01T00:00:00Z','products',json('[]')),1,1,1,9999999999999 FROM numbers`).run();
  const limited=await f.request(f.query);assert.equal(limited.status,400);assert.equal((await limited.json() as {error:{code:string}}).error.code,'ACCOUNTING_LIMIT','large periods fail explicitly rather than returning partial totals');
});

test('newly imported current costs can preview history without hiding CNY revenue or falsifying historical profit',{timeout:90_000},async t=>{
 const f=await fixture();t.after(f.close);
 await f.DB.prepare("UPDATE fbs_posting SET list_facts=json_set(list_facts,'$.products[0].price','20','$.products[0].currency','CNY')").run();
 assert.equal((await f.request('/costing',{...f.cost,validFrom:'2026-11-02'})).status,200);
 let data=await f.read();assert.equal(data.totals.revenue,4000);assert.equal(data.totals.profit,null);assert.equal(data.counts.purchaseKnown,0);assert.equal(data.totals.cost,null);
 const preview=await f.request(f.query+'&costMode=current_estimate');assert.equal(preview.status,200,await preview.clone().text());data=v.parse(accountingOverview, await preview.json());
 assert.equal(data.totals.revenue,4000);assert.equal(data.totals.knownPurchase,1000);assert.equal(data.counts.purchaseKnown,1);assert.equal(data.counts.currentEstimate,1);assert.equal(data.postings[0]!.costSource,'current_estimate');
 assert.equal(data.totals.profit,null,'unknown logistics and fees are not free');assert.equal(data.trend.find(row=>row.date==='2026-10-01')!.profit,null);
 assert.equal((await f.request('/capture',{...f.filter,costMode:'current_estimate'})).status,400);
 const basisCount=await f.DB.prepare('SELECT COUNT(*) AS n FROM accounting_posting_basis').first<{n:number}>();assert.equal(basisCount!.n,0);
 const config=v.parse(accountingConfig, await(await f.request('/config?storeId=store-a')).json());assert.equal(config.coverage?.costed,1);assert.equal(config.coverage?.earliestDate,'2026-11-02');
 const version=await f.DB.prepare('SELECT valid_from AS at FROM product_costing').first<{at:number}>();assert.equal(new Date(version!.at).toISOString().slice(0,10),'2026-11-02','preview cannot backdate imported facts');
});

test('known platform commission and product identity remain available while procurement is missing',{timeout:90_000},async t=>{
 const f=await fixture();t.after(f.close);
 await f.DB.prepare("UPDATE fbs_posting SET detail_facts=json_set(list_facts,'$.products[0].commissionRate','0.12'),detail_observed_at=2,list_observed_at=3").run();
 // A fresher status-only list cannot discard correlated finance in the detail snapshot.
 let data=await f.read();assert.equal(data.postings[0]!.lines[0]!.productId,'100');assert.equal(data.postings[0]!.lines[0]!.commissionSource,null,'RUB still needs an exchange rate');
 await f.DB.prepare("UPDATE fbs_posting SET list_facts=json_set(list_facts,'$.products[0].currency','CNY','$.products[0].price','20'),detail_facts=json_set(detail_facts,'$.products[0].currency','CNY','$.products[0].price','20')").run();
 data=await f.read();assert.equal(data.postings[0]!.commission,480);assert.equal(data.postings[0]!.lines[0]!.commissionSource,'platform_rate');assert.equal(data.totals.knownCost,480);assert.equal(data.totals.profit,null);assert.equal(data.costComponents?.commission.knownPostings,1);assert.equal(data.costComponents?.commission.platformRatePostings,1);
 const response=await f.request('/config?storeId=store-a&productId=100');assert.equal(response.status,200);const config=v.parse(accountingConfig, await response.json());assert.equal(config.products.length,1);assert.equal(config.products[0]!.id,'100');assert.equal(config.products[0]!.cost,null);
 assert.equal((await f.request('/config?storeId=store-b&productId=100',undefined,'staff')).status,404);
 await f.DB.prepare("UPDATE fbs_posting SET list_facts=json_set(list_facts,'$.products[0].quantity',3)").run();data=await f.read();assert.equal(data.postings[0]!.commission,null,'mismatched old detail quantity must not supply a finance rate');
});
