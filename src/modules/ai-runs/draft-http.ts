import type {Hono} from 'hono';
import {apiError,jsonResponse,type ApplicationEnv} from '../../http.ts';
import {configured,signedIn} from '../identity/http.ts';
import {readAiDraft} from './draft.ts';
const valid=(s:string|undefined):s is string=>!!s&&s.length<=256&&s===s.trim()&&s.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(s);
export function registerAiDraftRoutes(app:Hono<ApplicationEnv>){
 app.get('/api/companies/:companyId/conversations/:id/ai-draft',configured,signedIn,async c=>{
  const companyId=c.req.param('companyId'),conversationId=c.req.param('id'),raw=c.req.header('X-DingBell-Member-Id');let member:string;
  const invalid=()=>apiError(c,'INVALID_REQUEST','Provide a conversation and the current member identity only.',400);
  if(new URL(c.req.url).search||!valid(companyId)||!valid(conversationId))return invalid();
  try{member=decodeURIComponent(raw??'');if(!valid(member)||encodeURIComponent(member)!==raw)return invalid();}catch{return invalid();}
  const identity=c.get('identitySession');
  try{
   const value=await readAiDraft(c.env.DB!,{orgId:companyId,actorUserId:identity.user.id,sessionId:identity.session.id,expectedMemberId:member},conversationId);
   return value?jsonResponse(c,value):apiError(c,'NOT_FOUND','The company, store or conversation is not available.',404);
  }catch{return apiError(c,'AI_DRAFT_UNAVAILABLE','The draft could not be checked. Refresh it before adopting any text.',503);}
 });
}
