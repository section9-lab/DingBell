import * as v from 'valibot';
import {companyBudgetAuditSchema,companyBudgetReconciliationSummarySchema,type BudgetAuditKind} from '../../shared/budget-audit.ts';
import {ApiError,request} from './api.ts';
import {budgetId} from './budget-api.ts';

export async function readBudgetAudit(companyId:string,memberId:string,kind:BudgetAuditKind,targetBudgetId:string,signal?:AbortSignal){
 if(!v.is(budgetId,companyId)||!v.is(budgetId,memberId)||!v.is(budgetId,targetBudgetId))throw new ApiError('INVALID_REQUEST');
 const schema=v.pipe(companyBudgetAuditSchema,v.check(a=>a.companyId===companyId&&a.viewerMemberId===memberId&&a.kind===kind&&a.budgetId===targetBudgetId));
 return request(`/api/companies/${encodeURIComponent(companyId)}/budget-audits/${kind}/${encodeURIComponent(targetBudgetId)}`,schema,{signal,headers:{'X-DingBell-Member-Id':encodeURIComponent(memberId)}});
}
export async function readBudgetReconciliationSummary(companyId:string,memberId:string,signal?:AbortSignal){
 if(!v.is(budgetId,companyId)||!v.is(budgetId,memberId))throw new ApiError('INVALID_REQUEST');
 const schema=v.pipe(companyBudgetReconciliationSummarySchema,v.check(s=>s.companyId===companyId&&s.viewerMemberId===memberId));
 return request(`/api/companies/${encodeURIComponent(companyId)}/budget-audits`,schema,{signal,headers:{'X-DingBell-Member-Id':encodeURIComponent(memberId)}});
}
export function formatAuditMicros(value:string){
 if(!/^-?(?:0|[1-9]\d*)$/.test(value))throw new RangeError('INVALID_AUDIT_AMOUNT');
 const amount=BigInt(value),sign=amount<0n?'-':'',absolute=amount<0n?-amount:amount;
 const whole=new Intl.NumberFormat('en-US').format(absolute/1000000n),fraction=(absolute%1000000n).toString().padStart(6,'0').replace(/0+$/,'').padEnd(2,'0');
 return `${sign}$${whole}.${fraction}`;
}
