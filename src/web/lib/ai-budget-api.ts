import * as v from 'valibot';
import {aiBudgetWorkspaceSchema} from '../../shared/ai-budget.ts';
import type {ReplyTestBudgetCommand} from '../../shared/reply-test-budget.ts';
import {ApiError,request} from './api.ts';
import {budgetId,budgetPath,validBudgetHistory,changeBudget} from './budget-api.ts';
export const changeAiBudget=(companyId:string,memberId:string,value:ReplyTestBudgetCommand)=>changeBudget('reception',companyId,memberId,value);
export async function readAiBudgets(companyId:string,before?:string,signal?:AbortSignal){
 if(!v.is(budgetId,companyId)||before!==undefined&&(before.length>1000||!before))throw new ApiError('INVALID_REQUEST');
 const schema=v.pipe(v.object({...aiBudgetWorkspaceSchema.entries,companyId:v.literal(companyId)}),v.check(data=>validBudgetHistory(data)));
 return request(`${budgetPath('reception',companyId)}${before!==undefined?`?before=${encodeURIComponent(before)}`:''}`,schema,{signal});
}
