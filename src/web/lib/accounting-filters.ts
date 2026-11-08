import * as v from 'valibot';
import {accountingFilter,type AccountingFilter} from '../../shared/accounting.ts';

export function resolveAccountingFilter(storeId:string,today:string,params:URLSearchParams):AccountingFilter {
  const fromDate=new Date(Date.parse(`${today}T00:00:00Z`)-29*86_400_000).toISOString().slice(0,10);
  const fallback:AccountingFilter={storeId,fromDate,toDate:today,fulfillment:'all',costMode:'current_estimate'};
  const parsed=v.safeParse(accountingFilter,{storeId,fromDate:params.get('fromDate')??fromDate,toDate:params.get('toDate')??today,fulfillment:params.get('fulfillment')??'all',costMode:params.get('costMode')??'current_estimate'});
  if(!parsed.success)return fallback;
  const days=(Date.parse(parsed.output.toDate)-Date.parse(parsed.output.fromDate))/86_400_000;
  return days<0||days>=20_000?fallback:parsed.output;
}
export function accountingSearch(filter:AccountingFilter,existing?:URLSearchParams){
  const params=new URLSearchParams(existing);
  params.set('store',filter.storeId);params.set('fromDate',filter.fromDate);params.set('toDate',filter.toDate);params.set('fulfillment',filter.fulfillment);params.set('costMode',filter.costMode??'current_estimate');
  return params;
}
