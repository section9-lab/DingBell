import * as v from 'valibot';
import {replyTestBudgetWorkspaceSchema,type ReplyTestBudgetCommand} from '../../shared/reply-test-budget.ts';
import {ApiError,request} from './api.ts';
import {budgetId,budgetPath,validBudgetHistory,changeBudget} from './budget-api.ts';
export {usdToMicros,formatBudgetUsd,utcBudgetDay} from './budget-api.ts';
export type {ReplyTestBudgetCommand,ReplyTestBudgetView,ReplyTestBudgetWorkspace} from '../../shared/reply-test-budget.ts';
export const changeReplyTestBudget=(companyId:string,memberId:string,value:ReplyTestBudgetCommand)=>changeBudget('test',companyId,memberId,value);
export async function readReplyTestBudgets(companyId:string,before?:string,signal?:AbortSignal){
  if(!v.is(budgetId,companyId)||before!==undefined&&(before.length>1000||!before))throw new ApiError('INVALID_REQUEST');
  const schema=v.pipe(v.object({...replyTestBudgetWorkspaceSchema.entries,companyId:v.literal(companyId)}),v.check(data=>
    validBudgetHistory(data)&&
    (data.configuration.pricesConfigured?data.configuration.answerReservationMicros!==null&&data.configuration.queryReservationMicros!==null:data.configuration.answerReservationMicros===null&&data.configuration.queryReservationMicros===null)));
  return request(`${budgetPath('test',companyId)}${before!==undefined?`?before=${encodeURIComponent(before)}`:''}`,schema,{signal});
}
