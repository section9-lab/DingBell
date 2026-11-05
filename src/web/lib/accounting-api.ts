import * as v from 'valibot';
import {accountingConfig,accountingOverview,type AccountingFilter,type CostingInput,type ExpenseInput,type RulesInput} from '../../shared/accounting.ts';
import {request} from './api.ts';
const base=(companyId:string)=>`/api/companies/${encodeURIComponent(companyId)}/accounting`;
const ok=v.object({ok:v.literal(true)});
const accountingResponse=<T extends v.GenericSchema>(schema:T,check:(value:v.InferOutput<T>)=>boolean)=>v.pipe(schema,v.check(check));
export function readAccounting(companyId:string,filter:AccountingFilter,signal?:AbortSignal){return request(`${base(companyId)}?${new URLSearchParams(filter)}`,accountingResponse(accountingOverview,value=>value.companyId===companyId&&value.storeId===filter.storeId&&value.fromDate===filter.fromDate&&value.toDate===filter.toDate&&value.postings.every(row=>filter.fulfillment==='all'||row.fulfillment===filter.fulfillment)),{signal});}
export function readAccountingConfig(companyId:string,storeId:string,after?:string,signal?:AbortSignal,productId?:string){return request(`${base(companyId)}/config?${new URLSearchParams({storeId,...(after?{after}:{}),...(productId?{productId}:{})})}`,accountingResponse(accountingConfig,value=>value.rules.every(rule=>rule.storeId===storeId)&&value.products.every(product=>(!productId||product.id===productId)&&(!product.cost||product.cost.storeId===storeId&&product.cost.productId===product.id))),{signal});}
function post(companyId:string,path:string,body:unknown){return request(`${base(companyId)}/${path}`,ok,{method:'POST',body:JSON.stringify(body)});}
export const saveAccountingCost=(companyId:string,input:CostingInput)=>post(companyId,'costing',input);
export const saveAccountingRules=(companyId:string,input:RulesInput)=>post(companyId,'rules',input);
export const saveAccountingExpense=(companyId:string,input:ExpenseInput)=>post(companyId,'expenses',input);
export const voidAccountingExpense=(companyId:string,storeId:string,id:string)=>post(companyId,'expenses/void',{storeId,id});
export const captureAccounting=(companyId:string,filter:AccountingFilter)=>post(companyId,'capture',filter);
