import type {Hono} from 'hono';
import * as v from 'valibot';
import {apiError,jsonResponse,type ApplicationEnv} from '../../http.ts';
import {budgetAuditIdSchema,budgetAuditKindSchema} from '../../shared/budget-audit.ts';
import {configured,signedIn} from '../identity/http.ts';
import {readCompanyBudgetAudit,readCompanyBudgetReconciliationSummary} from './storage.ts';

export function registerBudgetAuditRoutes(app:Hono<ApplicationEnv>){
  app.get('/api/companies/:companyId/budget-audits',configured,signedIn,async c=>{
    const companyId=c.req.param('companyId'),raw=c.req.header('X-DingBell-Member-Id');let memberId:string;
    const invalid=()=>apiError(c,'INVALID_REQUEST','Provide a valid company and current member identity.',400);
    if(new URL(c.req.url).search||!v.is(budgetAuditIdSchema,companyId)||!raw)return invalid();
    try{memberId=decodeURIComponent(raw);if(!v.is(budgetAuditIdSchema,memberId)||encodeURIComponent(memberId)!==raw)return invalid();}catch{return invalid();}
    const identity=c.get('identitySession');
    try{
      const summary=await readCompanyBudgetReconciliationSummary(c.env.DB!,{orgId:companyId,actorUserId:identity.user.id,sessionId:identity.session.id,expectedMemberId:memberId});
      return summary?jsonResponse(c,summary):apiError(c,'NOT_FOUND','The budget reconciliation summary is not available.',404);
    }catch{return apiError(c,'BUDGET_AUDIT_UNAVAILABLE','The budget monitoring state could not be read. No balances have been changed.',503);}
  });
  app.get('/api/companies/:companyId/budget-audits/:kind/:budgetId',configured,signedIn,async c=>{
    const companyId=c.req.param('companyId'),budgetId=c.req.param('budgetId'),kind=v.safeParse(budgetAuditKindSchema,c.req.param('kind'));
    const raw=c.req.header('X-DingBell-Member-Id');let memberId:string;
    const invalid=()=>apiError(c,'INVALID_REQUEST','Provide a valid budget, purpose and current member identity.',400);
    if(new URL(c.req.url).search||!v.is(budgetAuditIdSchema,companyId)||!v.is(budgetAuditIdSchema,budgetId)||!kind.success||!raw)return invalid();
    try{memberId=decodeURIComponent(raw);if(!v.is(budgetAuditIdSchema,memberId)||encodeURIComponent(memberId)!==raw)return invalid();}catch{return invalid();}
    const identity=c.get('identitySession');
    try{
      const audit=await readCompanyBudgetAudit(c.env.DB!,{orgId:companyId,actorUserId:identity.user.id,sessionId:identity.session.id,expectedMemberId:memberId},kind.output,budgetId);
      return audit?jsonResponse(c,audit):apiError(c,'NOT_FOUND','The budget audit is not available.',404);
    }catch{return apiError(c,'BUDGET_AUDIT_UNAVAILABLE','The budget records could not be compared. No balances have been changed.',503);}
  });
}
