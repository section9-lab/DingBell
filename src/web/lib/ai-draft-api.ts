import * as v from 'valibot';
import {aiDraftSchema} from '../../shared/ai-draft.ts';
import {ApiError,request} from './api.ts';
export type {AiDraft} from '../../shared/ai-draft.ts';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(s=>s===s.trim()&&s.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(s)));
export function readAiDraft(companyId:string,conversationId:string,memberId:string,signal?:AbortSignal){
 if(![companyId,conversationId,memberId].every(s=>v.is(id,s)))return Promise.reject(new ApiError('INVALID_REQUEST'));
 const schema=v.pipe(aiDraftSchema,v.check(r=>r.companyId===companyId&&r.conversationId===conversationId&&r.viewerMemberId===memberId));
 return request(`/api/companies/${encodeURIComponent(companyId)}/conversations/${encodeURIComponent(conversationId)}/ai-draft`,schema,{headers:{'X-DingBell-Member-Id':encodeURIComponent(memberId)},signal});
}
