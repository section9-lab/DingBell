import type { Hono } from 'hono';
import * as v from 'valibot';
import { apiError,jsonResponse,type ApplicationEnv } from '../../http.ts';
import { replyTestBudgetCommandSchema } from '../../shared/reply-test-budget.ts';
import { configured,limitedBody,signedIn } from '../identity/http.ts';
import { readCompanySettings } from '../company-settings/storage.ts';
import { changeAiBudget,readAiBudgets } from './budget.ts';
import { supportConfigurationView } from './configuration.ts';
const validId=(s:string)=>!!s&&s.length<=256&&s===s.trim()&&s.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(s);
export function registerAiBudgetRoutes(app:Hono<ApplicationEnv>){
  for(const method of ['get','post'] as const)app[method]('/api/companies/:companyId/ai-budgets',configured,limitedBody,signedIn,async c=>{
    const invalid=()=>apiError(c,'INVALID_REQUEST','Provide a valid budget command or history cursor.',400);
    const missing=()=>apiError(c,'NOT_FOUND','The budget workspace is not available.',404);
    const companyId=c.req.param('companyId'),url=new URL(c.req.url);if(!validId(companyId)||[...url.searchParams.keys()].some(key=>key!=='before')||[...url.searchParams.keys()].length>1||method==='post'&&url.search)return invalid();
    const raw=c.req.header('X-DingBell-Member-Id');let memberId:string|undefined;
    if(raw!==undefined){try{memberId=decodeURIComponent(raw);if(!validId(memberId)||encodeURIComponent(memberId)!==raw)return invalid();}catch{return invalid();}}
    if(method==='post'&&!memberId)return invalid();
    const identity=c.get('identitySession'),actor={orgId:companyId,actorUserId:identity.user.id,sessionId:identity.session.id,...(memberId?{expectedMemberId:memberId}:{})};
    const company=await readCompanySettings(c.env.DB!,actor);if(!company)return missing();
    if(!['owner','admin'].includes(company.role))return apiError(c,'FORBIDDEN','Only company owners and administrators can manage AI reception budgets.',403);
    if(method==='get'){
      const before=url.searchParams.get('before')??undefined;
      if(before!==undefined){try{if(before.length>1000||!v.is(v.tuple([v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(8640000000000000)),v.pipe(v.string(),v.minLength(1),v.maxLength(256))]),JSON.parse(before))||JSON.stringify(JSON.parse(before))!==before)return invalid();}catch{return invalid();}}
      try{const data=await readAiBudgets(c.env.DB!,actor,before);return data?jsonResponse(c,{...data,configuration:supportConfigurationView(c.env)}):missing();}
      catch{return apiError(c,'BUDGET_UNAVAILABLE','The budget records cannot currently be read.',503);}
    }
    const parsed=v.safeParse(replyTestBudgetCommandSchema,await c.req.json().catch(()=>null));if(!parsed.success)return invalid();
    try{
      const result=await changeAiBudget(c.env.DB!,actor,parsed.output);
      if(result.outcome==='applied'||result.outcome==='existing')return jsonResponse(c,{purpose:'production',companyId,viewerMemberId:memberId,budget:result.budget,command:result.command});
      if(result.outcome==='not_found')return missing();
      const codes={conflict:'BUDGET_COMMAND_CONFLICT',changed:'BUDGET_CHANGED',overlap:'BUDGET_WINDOW_OVERLAP',expired:'BUDGET_WINDOW_EXPIRED'};
      return apiError(c,codes[result.outcome],'Read the current budget before submitting a new command.',409);
    }catch{return apiError(c,'OPERATION_UNCONFIRMED','Read the current budget and audit record before retrying this command.',503);}
  });
}
