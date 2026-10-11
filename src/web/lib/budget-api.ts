import * as v from 'valibot';
import {replyTestBudgetCommandSchema,replyTestBudgetSchema,replyTestBudgetReceiptSchema,type ReplyTestBudgetCommand,type ReplyTestBudgetWorkspace} from '../../shared/reply-test-budget.ts';
import {ApiError,request} from './api.ts';
export type BudgetKind='test'|'reception';
export const budgetId=v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(s=>s===s.trim()&&s.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(s)));
const id=budgetId;
const known=new Set(['INVALID_REQUEST','REQUEST_TOO_LARGE','ORIGIN_REJECTED','IDENTITY_NOT_CONFIGURED','NOT_FOUND','UNAUTHENTICATED','FORBIDDEN','BUDGET_COMMAND_CONFLICT','BUDGET_CHANGED','BUDGET_WINDOW_OVERLAP','BUDGET_WINDOW_EXPIRED']);
export const budgetPath=(kind:BudgetKind,companyId:string)=>`/api/companies/${encodeURIComponent(companyId)}/${kind==='test'?'reply-test-budgets':'ai-budgets'}`;
export function validBudgetHistory(data:Pick<ReplyTestBudgetWorkspace,'currentBudget'|'at'|'budgets'|'nextBefore'>){
 return (data.currentBudget===null||data.currentBudget.startsAt<=data.at&&data.currentBudget.endsAt>data.at)&&
  data.budgets.every((b,i)=>i===0||b.endsAt<=data.budgets[i-1].startsAt)&&
  (data.nextBefore===null||data.budgets.length===20&&data.nextBefore===JSON.stringify([data.budgets.at(-1)!.startsAt,data.budgets.at(-1)!.id]));
}
export function usdToMicros(value:string):number|null{
  if(!/^\d{1,10}(?:\.\d{1,6})?$/.test(value))return null;
  const [whole,fraction='']=value.split('.'),micros=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));
  return micros<=BigInt(Number.MAX_SAFE_INTEGER)?Number(micros):null;
}
export function formatBudgetUsd(micros:number):string{
  if(!Number.isSafeInteger(micros)||micros<0)throw new RangeError('INVALID_BUDGET_AMOUNT');
  const value=BigInt(micros),whole=new Intl.NumberFormat('en-US').format(value/1000000n),fraction=(value%1000000n).toString().padStart(6,'0').replace(/0+$/,'').padEnd(2,'0');
  return `$${whole}.${fraction}`;
}
export function utcBudgetDay(value:string):number|null{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
  const result=Date.parse(`${value}T00:00:00.000Z`);return Number.isFinite(result)&&result>=0&&new Date(result).toISOString().slice(0,10)===value?result:null;
}
export async function changeBudget(kind:BudgetKind,companyId:string,memberId:string,value:ReplyTestBudgetCommand){
  const parsed=v.safeParse(replyTestBudgetCommandSchema,value);if(!v.is(id,companyId)||!v.is(id,memberId)||!parsed.success)throw new ApiError('INVALID_REQUEST');
  const input=parsed.output,target=input.action==='create'?input.id:input.budgetId,revision=input.action==='create'?0:input.expectedRevision+1,enabled=input.action==='create'?false:input.enabled;
  const fields={companyId:v.literal(companyId),viewerMemberId:v.literal(memberId),budget:replyTestBudgetSchema,
    command:v.strictObject({...replyTestBudgetReceiptSchema.entries,id:v.literal(input.id),action:v.literal(input.action),budgetId:v.literal(target),revision:v.literal(revision),enabled:v.literal(enabled)})};
  const response=kind==='reception'?v.strictObject({...fields,purpose:v.literal('production')}):v.strictObject(fields);
  const schema=v.pipe(response,
    v.check(data=>data.budget.id===target&&data.budget.revision>=revision&&(data.budget.revision!==revision||data.budget.enabled===enabled)&&
      (input.action!=='create'||data.budget.startsAt===input.startsAt&&data.budget.endsAt===input.endsAt&&data.budget.limitMicros===input.limitMicros&&data.budget.maxRuns===input.maxRuns)));
  return request(budgetPath(kind,companyId),schema,{method:'POST',headers:{'X-DingBell-Member-Id':encodeURIComponent(memberId)},body:JSON.stringify(input)}).catch(error=>{
    if(error instanceof ApiError&&!known.has(error.code))throw new ApiError('OPERATION_UNCONFIRMED',error.requestId);throw error;
  });
}
