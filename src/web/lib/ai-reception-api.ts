import * as v from 'valibot';
import {aiReceptionCommandSchema,aiReceptionSchema,type AiReceptionCommand} from '../../shared/ai-reception.ts';
import {ApiError,request} from './api.ts';
export type {AiReception,AiReceptionCommand} from '../../shared/ai-reception.ts';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(s=>s===s.trim()&&s.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(s)));
function contract(companyId:string,conversationId:string,memberId:string,command?:AiReceptionCommand){
 if(![companyId,conversationId,memberId].every(s=>v.is(id,s))||command!==undefined&&!v.is(aiReceptionCommandSchema,command))throw new ApiError('INVALID_REQUEST');
 return {path:`/api/companies/${encodeURIComponent(companyId)}/conversations/${encodeURIComponent(conversationId)}`,
  headers:{'X-DingBell-Member-Id':encodeURIComponent(memberId)},
  schema:v.pipe(aiReceptionSchema,v.check(value=>value.companyId===companyId&&value.conversationId===conversationId&&value.viewerMemberId===memberId
   &&(command?value.resumption?.commandId===command.commandId&&value.resumption.expectedVersion===command.expectedVersion:value.resumption===null)))};
}
export async function readAiReception(companyId:string,conversationId:string,memberId:string,signal?:AbortSignal){
 const {path,headers,schema}=contract(companyId,conversationId,memberId);return request(`${path}/ai-reception`,schema,{headers,signal});
}
export async function readAiResumption(companyId:string,conversationId:string,memberId:string,command:AiReceptionCommand,signal?:AbortSignal){
 if(!v.is(aiReceptionCommandSchema,command))throw new ApiError('INVALID_REQUEST');
 const {path,headers,schema}=contract(companyId,conversationId,memberId,command);return request(`${path}/ai-resumptions/${command.commandId}`,schema,{headers,signal});
}
export async function resumeAiReception(companyId:string,conversationId:string,memberId:string,command:AiReceptionCommand){
 if(!v.is(aiReceptionCommandSchema,command))throw new ApiError('INVALID_REQUEST');
 const {path,headers,schema}=contract(companyId,conversationId,memberId,command);return request(`${path}/ai-resumptions`,schema,{method:'POST',headers,body:JSON.stringify(command)});
}
