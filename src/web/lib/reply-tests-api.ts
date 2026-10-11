import * as v from 'valibot';
import { replyTestRequestSchema,replyTestViewSchema,type ReplyTestRequest } from '../../shared/reply-test.ts';
import { ApiError,request } from './api.ts';
export type { ReplyTestRequest,ReplyTestView } from '../../shared/reply-test.ts';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(128),v.check(value=>value===value.trim()&&value.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(value)));
const known=new Set(['INVALID_REQUEST','REQUEST_TOO_LARGE','ORIGIN_REJECTED','IDENTITY_NOT_CONFIGURED','REPLY_TEST_DISABLED',
  'BUDGET_UNAVAILABLE','REPLY_TEST_QUERY_LIMIT','PRICING_UNAVAILABLE','REPLY_TEST_CONFLICT','REPLY_TEST_CHANGED','NOT_FOUND','UNAUTHENTICATED','FORBIDDEN']);
function contract(companyId:string,conversationId:string,memberId:string,input:ReplyTestRequest){
  if(![companyId,conversationId,memberId].every(value=>v.is(id,value))||!v.is(replyTestRequestSchema,input))throw new ApiError('INVALID_REQUEST');
  const test=v.pipe(v.strictObject({...replyTestViewSchema.entries,requestId:v.literal(input.requestId),messageId:v.literal(input.messageId),
    policyId:v.literal(input.policyId),stage:v.literal(input.stage),language:v.literal(input.language)}),
    v.check(value=>value.status==='ready'||value.sources.length===0&&value.answer===null));
  return {path:`/api/companies/${encodeURIComponent(companyId)}/conversations/${encodeURIComponent(conversationId)}/reply-tests`,
    headers:{'X-DingBell-Member-Id':encodeURIComponent(memberId)},
    schema:v.strictObject({companyId:v.literal(companyId),conversationId:v.literal(conversationId),viewerMemberId:v.literal(memberId),test})};
}
async function post(companyId:string,conversationId:string,memberId:string,input:ReplyTestRequest,generate:boolean){
  const {path,headers,schema}=contract(companyId,conversationId,memberId,input);
  return request(generate?`${path}/${input.requestId}/generate`:path,schema,{method:'POST',headers,body:JSON.stringify(generate?{}:input)}).catch(error=>{
    if(error instanceof ApiError&&!known.has(error.code))throw new ApiError('OPERATION_UNCONFIRMED',error.requestId);throw error;
  });
}
export function retrieveReplyTest(companyId:string,conversationId:string,memberId:string,input:ReplyTestRequest){return post(companyId,conversationId,memberId,input,false);}
export function generateReplyTest(companyId:string,conversationId:string,memberId:string,input:ReplyTestRequest){return post(companyId,conversationId,memberId,input,true);}
export function readReplyTest(companyId:string,conversationId:string,memberId:string,input:ReplyTestRequest,signal?:AbortSignal){
  const {path,headers,schema}=contract(companyId,conversationId,memberId,input);return request(`${path}/${input.requestId}`,schema,{headers,signal});
}
