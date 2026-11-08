import type {AccountingConfig,AccountingFilter,AccountingOverview,CostBasis,CostingInput,ExpenseInput,FrozenBasis,RuleBasis,RulesInput} from '../../shared/accounting.ts';
import {orderStatusLabel} from '../../shared/order-status.ts';
import {localDate,zonedStart,nextDate} from '../../shared/time-zone.ts';
import {postingBusinessTimeSQL,postingFactsSQL} from '../commerce/storage.ts';
import {storeAccess,type StoreActor} from '../stores/storage.ts';
import {calculatePosting,frozenBasis,moneyCents,summarize,type SalePosting} from './calculation.ts';

const maximumRows=5000;
const orderAt=`CAST(ROUND((julianday(${postingBusinessTimeSQL})-2440587.5)*86400000) AS INTEGER)`;
function selectedCostSQL(currentEstimate:boolean){
  const valid=`version.valid_from<=${orderAt} AND (version.valid_to IS NULL OR version.valid_to>${orderAt})`;
  return `(SELECT CASE WHEN COUNT(*)=1 THEN json_object('id',MAX(c.id),'productId',MAX(p.id),'purchasePrice',MAX(c.purchase_price),'purchaseCurrency',MAX(c.purchase_currency),'labelFee',MAX(c.label_fee),'weightGrams',MAX(c.weight_grams),'commissionRate',MAX(c.commission_rate),'validFrom',MAX(c.valid_from)) END
    FROM product p JOIN product_costing c ON c.organization_id=p.organization_id AND c.store_id=p.store_id AND c.product_id=p.id
    AND c.id=COALESCE((SELECT version.id FROM product_costing version WHERE version.organization_id=p.organization_id AND version.store_id=p.store_id AND version.product_id=p.id
      AND ${valid} ORDER BY version.valid_from DESC LIMIT 1),${currentEstimate?'(SELECT current.id FROM product_costing current WHERE current.organization_id=p.organization_id AND current.store_id=p.store_id AND current.product_id=p.id AND current.valid_to IS NULL)':'NULL'})
    WHERE p.organization_id=posting.organization_id AND p.store_id=posting.store_id
    AND (COALESCE(json_extract(p.facts,'$.offerId'),json_extract(p.listing,'$.offerId'))=json_extract(item.value,'$.offerId')
      OR EXISTS(SELECT 1 FROM product_name_map m WHERE m.organization_id=p.organization_id AND m.store_id=p.store_id AND m.product_id=p.id AND m.offer_id=json_extract(item.value,'$.offerId')))
    AND c.purchase_price IS NOT NULL)`;
}
const identity=(sale:SalePosting)=>JSON.stringify({orderNumber:sale.orderNumber,date:sale.date,products:sale.products.map(item=>[item.offerId,item.quantity])});
type Row={postingNumber:string;orderNumber:string;fulfillment:'fbs'|'fbo'|'fbp';at:number|null;raw:string;details:string|null;costs:string;ruleId:string|null;ruleInputs:string|null;basis:string|null;saleIdentity:string|null};
export class AccountingLimit extends Error {}
export class AccountingConflict extends Error {}
async function zone(db:D1Database,actor:StoreActor){return (await db.prepare('SELECT time_zone AS zone FROM company_settings WHERE organization_id=?').bind(actor.orgId).first<{zone:string}>())?.zone??'UTC';}
export async function readAccounting(db:D1Database,actor:StoreActor,filter:AccountingFilter){
  const timeZone=await zone(db,actor),from=zonedStart(filter.fromDate,timeZone),to=zonedStart(nextDate(filter.toDate),timeZone);
  const days=(Date.parse(filter.toDate)-Date.parse(filter.fromDate))/86_400_000+1;
  if(days<1||days>20000||to<=from)throw new RangeError('INVALID_ACCOUNTING_PERIOD');
  const where=`posting.organization_id=? AND posting.store_id=? AND ${storeAccess('store.organization_id',false)} AND (?='all' OR posting.fulfillment_type=?)`;
  const scope=[actor.orgId,filter.storeId,actor.actorUserId,actor.sessionId,filter.fulfillment,filter.fulfillment];
  const rows=(await db.prepare(`SELECT posting.posting_number AS postingNumber,posting.order_number AS orderNumber,posting.fulfillment_type AS fulfillment,${orderAt} AS at,${postingFactsSQL} AS raw,posting.detail_facts AS details,
    (SELECT json_group_array(json(${selectedCostSQL(filter.costMode==='current_estimate')})) FROM json_each(${postingFactsSQL},'$.products') item) AS costs,
    rule.id AS ruleId,rule.inputs AS ruleInputs,basis.inputs AS basis,basis.sale_identity AS saleIdentity
    FROM commerce_posting posting JOIN store ON store.id=posting.store_id AND store.organization_id=posting.organization_id
    LEFT JOIN accounting_rule rule ON rule.id=(SELECT r.id FROM accounting_rule r WHERE r.organization_id=posting.organization_id AND r.store_id=posting.store_id AND r.effective_at<=${orderAt} ORDER BY r.effective_at DESC LIMIT 1)
    LEFT JOIN accounting_posting_basis basis ON basis.organization_id=posting.organization_id AND basis.store_id=posting.store_id AND basis.fulfillment=posting.fulfillment_type AND basis.posting_number=posting.posting_number
    WHERE ${where} AND ${orderAt}>=? AND ${orderAt}<? ORDER BY ${orderAt} DESC,posting.posting_number,posting.fulfillment_type LIMIT ?`)
    .bind(...scope,from,to,maximumRows+1).all<Row>()).results;
  if(rows.length>maximumRows)throw new AccountingLimit();
  const undated=(await db.prepare(`SELECT COUNT(*) AS total FROM commerce_posting posting JOIN store ON store.id=posting.store_id AND store.organization_id=posting.organization_id WHERE ${where} AND ${orderAt} IS NULL`).bind(...scope).first<{total:number}>())?.total??0;
  const expenses=(await db.prepare(`SELECT expense.id,expense.expense_date AS date,expense.category,expense.amount_cents AS amount,expense.note FROM accounting_expense expense JOIN store ON store.id=expense.store_id AND store.organization_id=expense.organization_id WHERE expense.organization_id=? AND expense.store_id=? AND expense.expense_date>=? AND expense.expense_date<=? AND expense.voided_at IS NULL AND ${storeAccess('store.organization_id',false)} ORDER BY expense.expense_date DESC,expense.id LIMIT ?`)
    .bind(actor.orgId,filter.storeId,filter.fromDate,filter.toDate,actor.actorUserId,actor.sessionId,maximumRows+1).all<AccountingOverview['expenses'][number]>()).results;
  if(expenses.length>maximumRows)throw new AccountingLimit();
  const candidates:{sale:SalePosting;basis:FrozenBasis}[]=[];let excluded=0;
  const postings:AccountingOverview['postings']=[];
  for(const row of rows){
    const raw=JSON.parse(row.raw) as {status:string;substatus?:string;products:SalePosting['products']};
    // Unknown, returned, cancelled and in-flight states are never recognized as delivered revenue.
    const delivered=orderStatusLabel({status:raw.status,substatus:raw.substatus})==='已送达';
    if(!delivered){excluded++;continue;}
    const detail=row.details?JSON.parse(row.details) as {products?:SalePosting['products']}:null;
    const products=(raw.products??[]).map(item=>{
      if(item.commissionRate!=null)return item;
      const matching=detail?.products?.filter(older=>older.offerId===item.offerId&&older.quantity===item.quantity&&older.price===item.price&&older.currency===item.currency);
      return matching?.length===1&&matching[0]!.commissionRate!=null?{...item,commissionRate:matching[0]!.commissionRate}:item;
    });
    const sale:SalePosting={postingNumber:row.postingNumber,orderNumber:row.orderNumber,fulfillment:row.fulfillment,date:localDate(row.at!,timeZone),products};
    const saved=row.basis?JSON.parse(row.basis) as FrozenBasis:null;
    const costs=JSON.parse(row.costs) as (CostBasis|null)[],rules=row.ruleInputs?{...JSON.parse(row.ruleInputs),id:row.ruleId} as RuleBasis:null;
    const result=calculatePosting(sale,saved?.lines??costs,saved?.rules??rules,!!saved);
    if(!saved&&costs.some(cost=>cost?.validFrom!==undefined&&cost.validFrom>row.at!))result.costSource='current_estimate';
    if(saved&&row.saleIdentity!==identity(sale)){result.missing.push('商品或数量与冻结依据不一致，需人工核对');result.cost=null;result.profit=null;}
    postings.push(result);
    const basis=frozenBasis(costs,rules);if(!saved&&basis&&result.cost!==null&&result.costSource==='historical')candidates.push({sale,basis});
  }
  if(postings.some(posting=>posting.lines.some(line=>line.productId===null))){
    const rows=(await db.prepare(`SELECT p.id,COALESCE(json_extract(p.facts,'$.offerId'),json_extract(p.listing,'$.offerId')) AS offerId FROM product p
      JOIN store ON store.id=p.store_id AND store.organization_id=p.organization_id WHERE p.organization_id=? AND p.store_id=? AND ${storeAccess('store.organization_id',false)}
      UNION SELECT m.product_id AS id,m.offer_id AS offerId FROM product_name_map m JOIN store ON store.id=m.store_id AND store.organization_id=m.organization_id
      WHERE m.organization_id=? AND m.store_id=? AND m.offer_id IS NOT NULL AND ${storeAccess('store.organization_id',false)}`)
      .bind(actor.orgId,filter.storeId,actor.actorUserId,actor.sessionId,actor.orgId,filter.storeId,actor.actorUserId,actor.sessionId).all<{id:string;offerId:string}>()).results;
    const identities=new Map<string,Set<string>>();for(const row of rows){const ids=identities.get(row.offerId)??new Set<string>();ids.add(row.id);identities.set(row.offerId,ids);}
    for(const posting of postings)for(const line of posting.lines){const ids=identities.get(line.offerId);if(line.productId===null&&ids?.size===1)line.productId=[...ids][0]!;}
  }
  const visibleExpenses=filter.fulfillment==='all'?expenses:[];
  const earliest=[...postings.map(posting=>posting.date),...visibleExpenses.map(expense=>expense.date)].sort()[0];
  // For open-ended/all-history ranges, start the trend at the first real record instead of a sentinel date.
  const effectiveFrom=days>366?(earliest&&earliest>filter.fromDate?earliest:earliest?filter.fromDate:filter.toDate):filter.fromDate;
  const summary=summarize(postings,visibleExpenses,effectiveFrom,filter.toDate);
  const overview:AccountingOverview={companyId:actor.orgId,storeId:filter.storeId,timeZone,fromDate:filter.fromDate,toDate:filter.toDate,postings,expenses,
    counts:{eligible:postings.length,complete:postings.filter(row=>row.cost!==null).length,frozen:postings.filter(row=>row.frozen).length,excluded,undated,revenueKnown:postings.filter(row=>row.revenue!==null).length,purchaseKnown:postings.filter(row=>row.purchase!==null).length,currentEstimate:postings.filter(row=>row.costSource==='current_estimate').length},...summary};
  return {overview,candidates};
}
export async function captureAccounting(db:D1Database,actor:StoreActor,filter:AccountingFilter){
  if(filter.costMode==='current_estimate')throw new RangeError('CURRENT_COST_ESTIMATE_CANNOT_BE_FROZEN');
  const {candidates}=await readAccounting(db,actor,filter);
  // Small bounded batches. Each insert rechecks current manage permission. Retries cannot replace a basis.
  for(let offset=0;offset<candidates.length;offset+=40)await db.batch(candidates.slice(offset,offset+40).map(({sale,basis})=>db.prepare(`INSERT INTO accounting_posting_basis(organization_id,store_id,fulfillment,posting_number,sale_identity,inputs,captured_at,captured_by)
    SELECT ?,store.id,?,?,?,?,?,? FROM store WHERE store.organization_id=? AND store.id=? AND ${storeAccess('store.organization_id')} ON CONFLICT DO NOTHING`)
    .bind(actor.orgId,sale.fulfillment,sale.postingNumber,identity(sale),JSON.stringify(basis),Date.now(),actor.actorUserId,actor.orgId,filter.storeId,actor.actorUserId,actor.sessionId)));
}
export async function readAccountingConfig(db:D1Database,actor:StoreActor,storeId:string,after='',productId?:string):Promise<AccountingConfig>{
  const timeZone=await zone(db,actor);
  const rules=(await db.prepare(`SELECT rule.id,rule.valid_from AS validFrom,rule.inputs FROM accounting_rule rule JOIN store ON store.id=rule.store_id AND store.organization_id=rule.organization_id WHERE rule.organization_id=? AND rule.store_id=? AND ${storeAccess('store.organization_id',false)} ORDER BY rule.effective_at DESC LIMIT 10`).bind(actor.orgId,storeId,actor.actorUserId,actor.sessionId).all<{id:string;validFrom:string;inputs:string}>()).results.map(row=>({id:row.id,storeId,validFrom:row.validFrom,...JSON.parse(row.inputs) as Omit<RuleBasis,'id'>}));
  const rows=(await db.prepare(`SELECT p.id,COALESCE(json_extract(p.facts,'$.offerId'),json_extract(p.listing,'$.offerId')) AS offerId,COALESCE(json_extract(p.facts,'$.name'),json_extract(p.listing,'$.offerId')) AS name,
    c.id AS costId,c.purchase_price AS purchasePrice,c.purchase_currency AS purchaseCurrency,c.label_fee AS labelFee,c.weight_grams AS weightGrams,c.valid_from AS validFrom
    FROM product p JOIN store ON store.id=p.store_id AND store.organization_id=p.organization_id LEFT JOIN product_costing c ON c.organization_id=p.organization_id AND c.store_id=p.store_id AND c.product_id=p.id AND c.valid_to IS NULL
    WHERE p.organization_id=? AND p.store_id=? AND p.id>? AND (? IS NULL OR p.id=?) AND ${storeAccess('store.organization_id',false)} ORDER BY p.id LIMIT 51`).bind(actor.orgId,storeId,after,productId??null,productId??null,actor.actorUserId,actor.sessionId).all<{id:string;offerId:string;name:string;costId:string|null;purchasePrice:string|null;purchaseCurrency:CostingInput['purchaseCurrency']|null;labelFee:string|null;weightGrams:number|null;validFrom:number|null}>()).results;
  const coverage=await db.prepare(`SELECT COUNT(*) AS products,COALESCE(SUM(c.purchase_price IS NOT NULL),0) AS costed,MIN(c.valid_from) AS earliest,MAX(c.valid_from) AS latest
    FROM product p JOIN store ON store.id=p.store_id AND store.organization_id=p.organization_id LEFT JOIN product_costing c ON c.organization_id=p.organization_id AND c.store_id=p.store_id AND c.product_id=p.id AND c.valid_to IS NULL
    WHERE p.organization_id=? AND p.store_id=? AND ${storeAccess('store.organization_id',false)}`).bind(actor.orgId,storeId,actor.actorUserId,actor.sessionId).first<{products:number;costed:number;earliest:number|null;latest:number|null}>();
  return {coverage:coverage?{products:coverage.products,costed:coverage.costed,earliestDate:coverage.earliest===null?null:localDate(coverage.earliest,timeZone),latestDate:coverage.latest===null?null:localDate(coverage.latest,timeZone)}:undefined,rules,products:rows.slice(0,50).map(row=>({id:row.id,offerId:row.offerId,name:row.name,cost:row.costId&&row.purchasePrice!==null&&row.purchaseCurrency&&['CNY','RUB','USD','EUR'].includes(row.purchaseCurrency)&&row.labelFee!==null&&row.weightGrams!==null?{id:row.costId,storeId,productId:row.id,purchasePrice:row.purchasePrice,purchaseCurrency:row.purchaseCurrency,labelFee:row.labelFee,weightGrams:row.weightGrams,validFrom:localDate(row.validFrom!,timeZone)}:null})),nextProductId:rows.length>50?rows[49]!.id:null};
}
export async function saveCosting(db:D1Database,actor:StoreActor,input:CostingInput){
  const at=zonedStart(input.validFrom,await zone(db,actor)),id=crypto.randomUUID(),now=Date.now();
  // The rollover trigger closes the old window in the same authorized INSERT.
  // A stale date or an expired session cannot leave an orphaned closed window.
  const allowed=`NOT EXISTS(SELECT 1 FROM product_costing c WHERE c.organization_id=? AND c.store_id=? AND c.product_id=? AND c.valid_from>=?)`;
  const allowedValues=[actor.orgId,input.storeId,input.productId,at];
  const auth=`EXISTS(SELECT 1 FROM store WHERE store.organization_id=? AND store.id=? AND ${storeAccess('store.organization_id')})`;
  const authValues=[actor.orgId,input.storeId,actor.actorUserId,actor.sessionId];
  const row=await db.prepare(`WITH previous AS (SELECT * FROM product_costing WHERE organization_id=? AND store_id=? AND product_id=? ORDER BY valid_from DESC LIMIT 1)
      INSERT INTO product_costing(id,organization_id,store_id,product_id,purchase_price,purchase_currency,label_fee,weight_grams,valid_from,updated_at,updated_by,list_price,promo_discount,ad_budget_rate,commission_rate,supply_source)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,(SELECT list_price FROM previous),(SELECT promo_discount FROM previous),(SELECT ad_budget_rate FROM previous),(SELECT commission_rate FROM previous),(SELECT supply_source FROM previous)
      WHERE ${allowed} AND ${auth} AND EXISTS(SELECT 1 FROM product WHERE organization_id=? AND store_id=? AND id=?) RETURNING id`)
      .bind(actor.orgId,input.storeId,input.productId,id,actor.orgId,input.storeId,input.productId,input.purchasePrice,input.purchaseCurrency,input.labelFee,input.weightGrams,at,now,actor.actorUserId,...allowedValues,...authValues,actor.orgId,input.storeId,input.productId).first();
  if(!row)throw new AccountingConflict();
}
export async function saveRules(db:D1Database,actor:StoreActor,input:RulesInput){
  const {storeId,validFrom,...inputs}=input,at=zonedStart(validFrom,await zone(db,actor));
  const row=await db.prepare(`INSERT INTO accounting_rule(id,organization_id,store_id,effective_at,valid_from,inputs,created_at,created_by)
    SELECT ?,store.organization_id,store.id,?,?,?,?,? FROM store WHERE store.organization_id=? AND store.id=? AND ${storeAccess('store.organization_id')}
    AND NOT EXISTS(SELECT 1 FROM accounting_rule r WHERE r.organization_id=store.organization_id AND r.store_id=store.id AND r.effective_at>=?) RETURNING id`)
    .bind(crypto.randomUUID(),at,validFrom,JSON.stringify(inputs),Date.now(),actor.actorUserId,actor.orgId,storeId,actor.actorUserId,actor.sessionId,at).first();
  if(!row)throw new AccountingConflict();
}
export async function saveExpense(db:D1Database,actor:StoreActor,input:ExpenseInput){
  const amount=moneyCents(input.amount)!;
  await db.prepare(`INSERT INTO accounting_expense(id,organization_id,store_id,expense_date,category,amount_cents,note,created_at,created_by)
    SELECT ?,store.organization_id,store.id,?,?,?,?,?,? FROM store WHERE store.organization_id=? AND store.id=? AND ${storeAccess('store.organization_id')} ON CONFLICT DO NOTHING`)
    .bind(input.id,input.date,input.category,amount,input.note,Date.now(),actor.actorUserId,actor.orgId,input.storeId,actor.actorUserId,actor.sessionId).run();
  const row=await db.prepare(`SELECT expense.expense_date AS date,expense.category,expense.amount_cents AS amount,expense.note,expense.voided_at AS voided FROM accounting_expense expense JOIN store ON store.id=expense.store_id AND store.organization_id=expense.organization_id WHERE expense.id=? AND expense.organization_id=? AND expense.store_id=? AND ${storeAccess('store.organization_id')}`).bind(input.id,actor.orgId,input.storeId,actor.actorUserId,actor.sessionId).first<{date:string;category:string;amount:number;note:string;voided:number|null}>();
  if(!row||row.date!==input.date||row.category!==input.category||row.amount!==amount||row.note!==input.note||row.voided!==null)throw new AccountingConflict();
}
export async function voidExpense(db:D1Database,actor:StoreActor,storeId:string,id:string){
  await db.prepare(`UPDATE accounting_expense SET voided_at=?,voided_by=? WHERE id=? AND organization_id=? AND store_id=? AND voided_at IS NULL AND EXISTS(SELECT 1 FROM store WHERE store.id=accounting_expense.store_id AND store.organization_id=accounting_expense.organization_id AND ${storeAccess('store.organization_id')})`).bind(Date.now(),actor.actorUserId,id,actor.orgId,storeId,actor.actorUserId,actor.sessionId).run();
}
