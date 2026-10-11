import * as v from 'valibot';
import { ApiError, request } from './api.ts';
import { isValidConversationReplyBody } from './conversation-control-api.ts';

export interface ReplyPreviewRequest {requestId:string;source:string;sourceRevision:number}
export interface ReplyPreview extends ReplyPreviewRequest {targetLanguage:'ru';status:'ready'|'pending'|'unconfirmed'|'unavailable';translation:string|null;reason:string|null;usageStatus:'held'|'settled'|'released'}
export interface ReplyPreviewResponse {companyId:string;conversationId:string;viewerMemberId:string;preview:ReplyPreview}

const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(value=>value===value.trim()&&value.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(value)));
const body=v.pipe(v.string(),v.check(isValidConversationReplyBody));
const inputSchema=v.strictObject({requestId:v.pipe(v.string(),v.uuid()),source:body,
  sourceRevision:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER))});
const reason=v.nullable(v.picklist(['RECEIPT_UNCONFIRMED','AUTHORITY_UNAVAILABLE','EXECUTION_UNCONFIRMED','EXECUTION_FAILED','EXECUTION_CLOSED','INVALID_OUTPUT','OUTPUT_UNCONFIRMED','USAGE_UNCONFIRMED','SETTLEMENT_UNCONFIRMED']));
const rejected=new Set(['INVALID_REQUEST','REQUEST_TOO_LARGE','ORIGIN_REJECTED','IDENTITY_NOT_CONFIGURED',
  'TRANSLATION_DISABLED','BUDGET_UNAVAILABLE','PRICING_UNAVAILABLE','RUNTIME_UNAVAILABLE']);
export function isValidReplyPreviewRequest(value:unknown):value is ReplyPreviewRequest {return v.is(inputSchema,value);}
// Only for a POST result. Read failures cannot prove that the original request was rejected.
export function isReplyPreviewRejected(error:unknown):boolean{return error instanceof ApiError&&rejected.has(error.code);}
function contract(companyId:string,conversationId:string,memberId:string,input:ReplyPreviewRequest){
  if(![companyId,conversationId,memberId].every(value=>v.is(id,value))||!isValidReplyPreviewRequest(input))throw new ApiError('INVALID_REQUEST');
  const preview=v.pipe(v.strictObject({requestId:v.literal(input.requestId),source:v.literal(input.source),sourceRevision:v.literal(input.sourceRevision),
    targetLanguage:v.literal('ru'),status:v.picklist(['ready','pending','unconfirmed','unavailable']),translation:v.nullable(body),reason,
    usageStatus:v.picklist(['held','settled','released']),
  }),v.check(value=>(value.usageStatus!=='released'||value.status==='unavailable')&&(value.status==='ready'
    ?value.translation!==null&&[null,'USAGE_UNCONFIRMED','SETTLEMENT_UNCONFIRMED'].includes(value.reason)
    :value.translation===null&&(value.status==='pending'?value.reason===null:value.reason!==null))));
  return {path:`/api/companies/${encodeURIComponent(companyId)}/conversations/${encodeURIComponent(conversationId)}/reply-previews`,
    headers:{'X-DingBell-Member-Id':encodeURIComponent(memberId)},
    schema:v.strictObject({companyId:v.literal(companyId),conversationId:v.literal(conversationId),viewerMemberId:v.literal(memberId),preview})};
}
export async function submitReplyPreview(companyId:string,conversationId:string,memberId:string,input:ReplyPreviewRequest):Promise<ReplyPreviewResponse>{
  const {path,headers,schema}=contract(companyId,conversationId,memberId,input);
  return request(path,schema,{method:'POST',headers,body:JSON.stringify(input)}).catch(error=>{
    if(error instanceof ApiError&&!isReplyPreviewRejected(error)&&!['PREVIEW_CONFLICT','NOT_FOUND','UNAUTHENTICATED','FORBIDDEN'].includes(error.code))throw new ApiError('OPERATION_UNCONFIRMED',error.requestId);
    throw error;
  });
}
export async function readReplyPreview(companyId:string,conversationId:string,memberId:string,input:ReplyPreviewRequest,signal?:AbortSignal):Promise<ReplyPreviewResponse>{
  const {path,headers,schema}=contract(companyId,conversationId,memberId,input);
  return request(`${path}/${input.requestId}`,schema,{headers,signal});
}
