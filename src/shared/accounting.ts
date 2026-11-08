import * as v from 'valibot';

export const decimalInput=v.pipe(v.string(),v.regex(/^(0|[1-9]\d{0,8})(\.\d{1,4})?$/,'请输入非负金额，最多 4 位小数'));
const rateInput=v.pipe(decimalInput,v.check(value=>Number(value)<=1,'费率需在 0 到 1 之间'));
export const accountingDate=v.pipe(v.string(),v.regex(/^\d{4}-\d{2}-\d{2}$/),v.check(value=>!Number.isNaN(Date.parse(value))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value,'日期无效'));
const storeId=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
export const costingInput=v.strictObject({
  storeId,productId:v.pipe(v.string(),v.regex(/^(0|[1-9]\d{0,39})$/)),
  validFrom:accountingDate,purchasePrice:decimalInput,purchaseCurrency:v.picklist(['CNY','RUB','USD','EUR']),
  labelFee:decimalInput,weightGrams:v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(3_000_000)),
});
const rate=v.union([v.literal(''),v.pipe(decimalInput,v.check(value=>Number(value)>0,'汇率必须大于零'))]);
export const rulesInput=v.strictObject({
  storeId,validFrom:accountingDate,
  commissionRate:rateInput,withdrawalRate:rateInput,freightPerKg:decimalInput,freightPerPosting:decimalInput,
  rubToCny:rate,usdToCny:rate,eurToCny:rate,
});
export const expenseInput=v.strictObject({
  id:v.pipe(v.string(),v.uuid()),storeId,date:accountingDate,category:v.picklist(['advertising','other']),
  amount:v.pipe(decimalInput,v.check(value=>Number(value)>0&&Number(value)*100>=1,'费用至少为 0.01 元')),
  note:v.pipe(v.string(),v.trim(),v.minLength(1),v.maxLength(200)),
});
export type CostingInput=v.InferOutput<typeof costingInput>;
export type RulesInput=v.InferOutput<typeof rulesInput>;
export type ExpenseInput=v.InferOutput<typeof expenseInput>;
export const accountingFilter=v.strictObject({storeId,fromDate:accountingDate,toDate:accountingDate,fulfillment:v.picklist(['all','fbs','fbo','fbp']),costMode:v.optional(v.picklist(['historical','current_estimate']))});
export type AccountingFilter=v.InferOutput<typeof accountingFilter>;
export type CostBasis={id:string;productId:string;purchasePrice:string;purchaseCurrency:string;labelFee:string|null;weightGrams:number|null;commissionRate:string|null;validFrom?:number};
export type RuleBasis=Omit<RulesInput,'storeId'|'validFrom'>&{id:string};
export type FrozenBasis={version:1;rules:RuleBasis;lines:CostBasis[]};
const nullableMoney=v.nullable(v.pipe(v.number(),v.integer()));
export const accountingLine=v.object({
  productId:v.nullable(v.string()),offerId:v.string(),name:v.string(),quantity:v.number(),
  purchaseUnitPrice:v.optional(v.nullable(v.string())),purchaseCurrency:v.optional(v.nullable(v.string())),weightGrams:v.optional(v.nullable(v.number())),
  revenue:nullableMoney,purchase:nullableMoney,label:nullableMoney,commission:nullableMoney,freight:nullableMoney,commissionSource:v.optional(v.nullable(v.picklist(['platform_rate','cost_model','store_rule']))),
});
export type AccountingLine=v.InferOutput<typeof accountingLine>;
export const accountingPosting=v.object({
  postingNumber:v.string(),orderNumber:v.string(),fulfillment:v.picklist(['fbs','fbo','fbp']),date:v.string(),
  revenue:nullableMoney,cost:nullableMoney,profit:nullableMoney,purchase:nullableMoney,label:nullableMoney,
  commission:nullableMoney,freight:nullableMoney,withdrawal:nullableMoney,frozen:v.boolean(),costSource:v.picklist(['historical','current_estimate','frozen']),missing:v.array(v.string()),lines:v.array(accountingLine),
});
export type AccountingPosting=v.InferOutput<typeof accountingPosting>;
export const accountingExpense=v.object({id:v.string(),date:v.string(),category:v.picklist(['advertising','other']),amount:v.pipe(v.number(),v.integer()),note:v.string()});
const int=v.pipe(v.number(),v.integer());
const costComponent=v.object({amount:int,knownPostings:int,totalPostings:int,platformRatePostings:v.optional(int)});
export const accountingOverview=v.object({
  costComponents:v.optional(v.object({purchase:costComponent,label:costComponent,commission:costComponent,freight:costComponent,withdrawal:costComponent})),
  companyId:v.string(),storeId:v.string(),timeZone:v.string(),fromDate:v.string(),toDate:v.string(),
  postings:v.array(accountingPosting),expenses:v.array(accountingExpense),
  counts:v.object({eligible:v.number(),complete:v.number(),frozen:v.number(),excluded:v.number(),undated:v.number(),revenueKnown:v.number(),purchaseKnown:v.number(),currentEstimate:v.number()}),
  totals:v.object({revenue:v.number(),knownPurchase:v.number(),knownContribution:v.number(),knownCost:v.optional(int),cost:nullableMoney,profit:nullableMoney,margin:v.nullable(v.number()),purchase:nullableMoney,label:nullableMoney,commission:nullableMoney,freight:nullableMoney,withdrawal:nullableMoney,advertising:v.number(),other:v.number()}),
  trend:v.array(v.object({date:v.string(),revenue:v.number(),cost:nullableMoney,profit:nullableMoney,knownCost:v.optional(nullableMoney),knownContribution:v.optional(v.number())})),
  trendGranularity:v.optional(v.picklist(['day','month'])),
});
export type AccountingOverview=v.InferOutput<typeof accountingOverview>;
const costingRecord=v.object({...costingInput.entries,id:v.string()});
export const accountingConfig=v.object({
  coverage:v.optional(v.object({products:v.number(),costed:v.number(),earliestDate:v.nullable(v.string()),latestDate:v.nullable(v.string())})),
  rules:v.array(v.object({...rulesInput.entries,id:v.string()})),
  products:v.array(v.object({id:v.string(),offerId:v.string(),name:v.string(),cost:v.nullable(costingRecord)})),
  nextProductId:v.nullable(v.string()),
});
export type AccountingConfig=v.InferOutput<typeof accountingConfig>;
