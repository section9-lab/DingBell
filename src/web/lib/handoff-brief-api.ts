import * as v from 'valibot';
import {acknowledgeHandoffRequestSchema,acknowledgeHandoffResponseSchema,changeHandoffItemRequestSchema,changeHandoffItemResponseSchema,handoffBriefResponseSchema} from '../../shared/handoff-brief.ts';
import {ApiError,request} from './api.ts';

const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(value=>value===value.trim()&&value.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(value)));
export async function readHandoffBrief(companyId:string,conversationId:string,signal?:AbortSignal){
 if(!v.is(id,companyId)||!v.is(id,conversationId))throw new ApiError('INVALID_REQUEST');
 const schema=v.pipe(handoffBriefResponseSchema,v.check(value=>value.companyId===companyId&&value.conversationId===conversationId));
 return request(`/api/companies/${encodeURIComponent(companyId)}/conversations/${encodeURIComponent(conversationId)}/handoff-brief`,schema,{signal});
}
export async function acknowledgeHandoffRequirements(companyId:string,conversationId:string,memberId:string,input:unknown,signal?:AbortSignal){
 if(!v.is(id,companyId)||!v.is(id,conversationId)||!v.is(id,memberId))throw new ApiError('INVALID_REQUEST');const parsed=v.safeParse(acknowledgeHandoffRequestSchema,input);if(!parsed.success)throw new ApiError('INVALID_REQUEST');
 const schema=v.pipe(acknowledgeHandoffResponseSchema,v.check(value=>value.companyId===companyId&&value.conversationId===conversationId&&value.viewerMemberId===memberId&&value.commandId===parsed.output.commandId&&value.runId===parsed.output.runId&&value.sourceSequence===parsed.output.expectedSequence));
 return request(`/api/companies/${encodeURIComponent(companyId)}/conversations/${encodeURIComponent(conversationId)}/handoff-reviews`,schema,{method:'POST',headers:{'X-DingBell-Member-Id':encodeURIComponent(memberId)},body:JSON.stringify(parsed.output),signal});
}
export async function changeHandoffItem(companyId:string,conversationId:string,memberId:string,input:unknown,signal?:AbortSignal){
 if(!v.is(id,companyId)||!v.is(id,conversationId)||!v.is(id,memberId))throw new ApiError('INVALID_REQUEST');const parsed=v.safeParse(changeHandoffItemRequestSchema,input);if(!parsed.success)throw new ApiError('INVALID_REQUEST');
 const schema=v.pipe(changeHandoffItemResponseSchema,v.check(value=>value.companyId===companyId&&value.conversationId===conversationId&&value.viewerMemberId===memberId&&value.commandId===parsed.output.commandId&&value.runId===parsed.output.runId&&value.sourceSequence===parsed.output.expectedSequence&&value.item.itemIndex===parsed.output.itemIndex&&value.item.revision===parsed.output.expectedRevision+1&&value.item.status===parsed.output.status));
 return request(`/api/companies/${encodeURIComponent(companyId)}/conversations/${encodeURIComponent(conversationId)}/handoff-items`,schema,{method:'POST',headers:{'X-DingBell-Member-Id':encodeURIComponent(memberId)},body:JSON.stringify(parsed.output),signal});
}
