import {useState,type ReactNode} from 'react';
import {useForm} from 'react-hook-form';
import {valibotResolver} from '@hookform/resolvers/valibot';
import {costingInput,expenseInput,rulesInput,type AccountingConfig,type CostingInput,type ExpenseInput,type RulesInput} from '../../shared/accounting';
import {saveAccountingCost,saveAccountingExpense,saveAccountingRules} from '../lib/accounting-api';
import {ErrorNotice} from './identity-shared';
import {Button} from './ui/button';
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from './ui/dialog';
import {Field,FieldDescription,FieldLabel} from './ui/field';
import {Input} from './ui/input';
import {NativeSelect,NativeSelectOption} from './ui/native-select';
import {Spinner} from './ui/spinner';

function FormField({label,id,error,description,children}:{label:string;id:string;error?:string;description?:string;children:ReactNode}){
  return <Field><FieldLabel htmlFor={id}>{label}</FieldLabel>{children}{(error||description)&&<FieldDescription id={`${id}-description`} className={error?'text-destructive':undefined}>{error??description}</FieldDescription>}</Field>;
}
function Result({pending,error}:{pending:boolean;error:unknown}){return <>{error!=null&&<ErrorNotice error={error}/>}<Button type="submit" disabled={pending}>{pending&&<Spinner/>}保存</Button></>;}
export function AccountingCostDialog({companyId,storeId,product,startDate,close,saved}:{companyId:string;storeId:string;product:AccountingConfig['products'][number];startDate:string;close:()=>void;saved:()=>Promise<void>}){
  const [error,setError]=useState<unknown>(null);
  const form=useForm<CostingInput>({resolver:valibotResolver(costingInput),defaultValues:{storeId,productId:product.id,validFrom:startDate,purchasePrice:product.cost?.purchasePrice??'',purchaseCurrency:product.cost?.purchaseCurrency??'CNY',labelFee:product.cost?.labelFee??'0',weightGrams:product.cost?.weightGrams}});
  const {errors,isSubmitting}=form.formState;
  const submit=form.handleSubmit(async input=>{setError(null);try{await saveAccountingCost(companyId,input);await saved();close();}catch(cause){setError(cause);}});
  return <Dialog open onOpenChange={open=>{if(!open&&!isSubmitting)close();}}><DialogContent className="max-h-[85svh] overflow-y-auto"><DialogHeader><DialogTitle>维护核算成本</DialogTitle><DialogDescription>{product.name} · {product.offerId}。核算采购价独立版本管理，不会覆盖商品资料中的当前货源参考价。</DialogDescription></DialogHeader><form className="grid gap-4" onSubmit={submit} noValidate aria-busy={isSubmitting}><fieldset disabled={isSubmitting} className="grid gap-4">
    <FormField label="生效日期" id="cost-date" error={errors.validFrom?.message} description={product.cost?`已有版本自 ${product.cost.validFrom} 生效；新版本日期必须更晚。历史冻结依据不变。`:'首次可选择历史日期，以便补算历史订单。'}><Input id="cost-date" type="date" {...form.register('validFrom')} aria-invalid={!!errors.validFrom} aria-describedby="cost-date-description"/></FormField>
    <div className="grid grid-cols-2 gap-3"><FormField label="单件采购价" id="cost-price" error={errors.purchasePrice?.message}><Input id="cost-price" inputMode="decimal" {...form.register('purchasePrice')} aria-invalid={!!errors.purchasePrice}/></FormField><FormField label="采购币种" id="cost-currency" error={errors.purchaseCurrency?.message}><NativeSelect id="cost-currency" {...form.register('purchaseCurrency')}>{['CNY','RUB','USD','EUR'].map(value=><NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}</NativeSelect></FormField></div>
    <FormField label="单件贴单费（CNY）" id="cost-label" error={errors.labelFee?.message}><Input id="cost-label" inputMode="decimal" {...form.register('labelFee')} aria-invalid={!!errors.labelFee}/></FormField>
    <FormField label="单件计费重量（克）" id="cost-weight" error={errors.weightGrams?.message}><Input id="cost-weight" type="number" min={1} max={3000000} {...form.register('weightGrams',{valueAsNumber:true})} aria-invalid={!!errors.weightGrams}/></FormField>
  </fieldset><Result pending={isSubmitting} error={error}/></form></DialogContent></Dialog>;
}
const ruleFields=[['commissionRate','平台佣金费率','例如 0.15 表示 15%'],['withdrawalRate','提现手续费率','按销售额扣佣金及物流后的非负结算基数估算'],['freightPerKg','每公斤运费（CNY）','按商品重量线性预估，不是平台实际物流账单'],['freightPerPosting','每包裹基础运费（CNY）','每个包裹只计一次'],['rubToCny','1 RUB 折合 CNY','可留空；仅涉及 RUB 时需要，不默认按 1 换算'],['usdToCny','1 USD 折合 CNY','可留空；仅涉及 USD 时需要'],['eurToCny','1 EUR 折合 CNY','可留空；仅涉及 EUR 时需要']] as const;
export function AccountingRulesDialog({companyId,storeId,current,startDate,close,saved}:{companyId:string;storeId:string;current:AccountingConfig['rules'][number]|undefined;startDate:string;close:()=>void;saved:()=>Promise<void>}){
  const [error,setError]=useState<unknown>(null);
  const form=useForm<RulesInput>({resolver:valibotResolver(rulesInput),defaultValues:{storeId,validFrom:startDate,commissionRate:current?.commissionRate??'',withdrawalRate:current?.withdrawalRate??'',freightPerKg:current?.freightPerKg??'',freightPerPosting:current?.freightPerPosting??'',rubToCny:current?.rubToCny??'',usdToCny:current?.usdToCny??'',eurToCny:current?.eurToCny??''}});
  const {errors,isSubmitting}=form.formState;
  return <Dialog open onOpenChange={open=>{if(!open&&!isSubmitting)close();}}><DialogContent className="max-h-[85svh] overflow-y-auto"><DialogHeader><DialogTitle>费用与汇率规则</DialogTitle><DialogDescription>所有金额折算为 CNY。规则按订单日期选取；首次可回填历史日期，后续只追加更晚版本。{current&&` 最新版本：${current.validFrom}。`}</DialogDescription></DialogHeader><form noValidate className="grid gap-4" aria-busy={isSubmitting} onSubmit={form.handleSubmit(async input=>{setError(null);try{await saveAccountingRules(companyId,input);await saved();close();}catch(cause){setError(cause);}})}><fieldset disabled={isSubmitting} className="grid gap-4 sm:grid-cols-2">
    <FormField label="生效日期" id="rule-date" error={errors.validFrom?.message}><Input type="date" id="rule-date" {...form.register('validFrom')} aria-invalid={!!errors.validFrom}/></FormField>
    {ruleFields.map(([name,label,description])=><FormField key={name} label={label} id={`rule-${name}`} error={errors[name]?.message} description={description}><Input id={`rule-${name}`} inputMode="decimal" {...form.register(name)} aria-invalid={!!errors[name]} aria-describedby={`rule-${name}-description`}/></FormField>)}
  </fieldset><Result pending={isSubmitting} error={error}/></form></DialogContent></Dialog>;
}
export function AccountingExpenseDialog({companyId,storeId,today,close,saved}:{companyId:string;storeId:string;today:string;close:()=>void;saved:()=>Promise<void>}){
  const [error,setError]=useState<unknown>(null);
  const form=useForm<ExpenseInput>({resolver:valibotResolver(expenseInput),defaultValues:{id:crypto.randomUUID(),storeId,date:today,category:'advertising',amount:'',note:''}});
  const {errors,isSubmitting}=form.formState;
  return <Dialog open onOpenChange={open=>{if(!open&&!isSubmitting)close();}}><DialogContent><DialogHeader><DialogTitle>登记期间费用</DialogTitle><DialogDescription>按发生日期登记 CNY 实际支出。期间费用归属于整个店铺，不向商品或履约方式分摊。</DialogDescription></DialogHeader><form className="grid gap-4" noValidate aria-busy={isSubmitting} onSubmit={form.handleSubmit(async input=>{setError(null);try{await saveAccountingExpense(companyId,input);await saved();close();}catch(cause){setError(cause);}})}><fieldset disabled={isSubmitting} className="grid gap-4">
    <FormField label="费用日期" id="expense-date" error={errors.date?.message}><Input id="expense-date" type="date" {...form.register('date')} aria-invalid={!!errors.date}/></FormField>
    <FormField label="费用类别" id="expense-category"><NativeSelect id="expense-category" {...form.register('category')}><NativeSelectOption value="advertising">广告支出</NativeSelectOption><NativeSelectOption value="other">其他经营费用</NativeSelectOption></NativeSelect></FormField>
    <FormField label="支出金额（CNY）" id="expense-amount" error={errors.amount?.message}><Input id="expense-amount" inputMode="decimal" {...form.register('amount')} aria-invalid={!!errors.amount}/></FormField>
    <FormField label="费用说明" id="expense-note" error={errors.note?.message}><Input id="expense-note" maxLength={200} {...form.register('note')} aria-invalid={!!errors.note}/></FormField>
  </fieldset><Result pending={isSubmitting} error={error}/></form></DialogContent></Dialog>;
}
