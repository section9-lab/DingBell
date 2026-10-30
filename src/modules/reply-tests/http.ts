import type { Context,Hono } from 'hono';
import * as v from 'valibot';
import { apiError,jsonResponse,type ApplicationEnv } from '../../http.ts';
import { replyTestRequestSchema,type ReplyTestRequest,type ReplyTestView } from '../../shared/reply-test.ts';
import { configured,limitedBody,signedIn } from '../identity/http.ts';
import { readCompanySettings } from '../company-settings/storage.ts';
import { readControlAccess } from '../conversations/control-storage.ts';
import type { ControlActor } from '../conversations/control-types.ts';
import { prepareReplyTest,replyTestModelInput,type ReplyTestControlReader } from './service.ts';
import { executeReplyTest,readExecutedReplyTest,replyTestControl,type ReplyTestRuntime } from './execution.ts';
import { reserveReplyTest,readReplyTestRun } from './storage.ts';
import { admitReplyTestQuery,readReplyTestQuery,retrieveReplyTestQuery,type ReplyTestQuery } from './query.ts';

export interface ReplyTestHttpBindings {REPLY_TEST_CONFIG_JSON?:string;REPLY_TEST_QUERY_CONFIG_JSON?:string}
export interface ReplyTestHttpDependencies {replyTestControl?:ReplyTestControlReader;replyTestRuntime?:ReplyTestRuntime}
const base='/api/companies/:companyId/conversations/:id/reply-tests';
const validId=(s:string|undefined):s is string=>!!s&&s.length<=128&&s===s.trim()&&s.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(s);
const invalid=(c:Context<ApplicationEnv>)=>apiError(c,'INVALID_REQUEST','Provide only the test target and canonical member identity.',400);
const missing=(c:Context<ApplicationEnv>)=>apiError(c,'NOT_FOUND','This answer test is not available.',404);
const conflict=(c:Context<ApplicationEnv>)=>apiError(c,'REPLY_TEST_CONFLICT','The identifier belongs to a different test. Read the original request.',409);
function memberHeader(c:Context<ApplicationEnv>){
  const raw=c.req.header('X-DingBell-Member-Id');if(!raw)return null;
  try{const value=decodeURIComponent(raw);return validId(value)&&encodeURIComponent(value)===raw?value:null;}catch{return null;}
}
async function access(c:Context<ApplicationEnv>,actor:ControlActor,memberId:string){
  const current=await readControlAccess(c.env.DB!,actor,c.req.param('id')!);if(!current||current.memberId!==memberId)return missing(c);
  const settings=await readCompanySettings(c.env.DB!,actor);if(!settings)return missing(c);
  return ['owner','admin'].includes(settings.role)?null:apiError(c,'FORBIDDEN','Only owners and administrators can test AI replies.',403);
}
function original(q:ReplyTestQuery):ReplyTestRequest{const {conversationId,...input}=q.payload.context.input;return {requestId:q.requestId,...input};}
function status(q:ReplyTestQuery):ReplyTestView['status']{
  if(q.attemptedAt===null&&q.quotaDay!==new Date(Date.now()).toISOString().slice(0,10))return 'changed';
  return q.evidence?'ready':q.vectors?'index_unavailable':q.errorCode?'unconfirmed':q.attemptedAt===null?'prepared':Date.now()-q.attemptedAt<25000?'retrieving':'unconfirmed';
}
export function registerReplyTestRoutes(app:Hono<ApplicationEnv>,deps:ReplyTestHttpDependencies={}){
  for(const operation of ['retrieve','read','generate'] as const){
    const path=operation==='retrieve'?base:operation==='read'?`${base}/:requestId`:`${base}/:requestId/generate`;
    app[operation==='read'?'get':'post'](path,configured,limitedBody,signedIn,async c=>{
      const memberId=memberHeader(c),requestId=c.req.param('requestId');
      if(!memberId||!validId(c.req.param('companyId'))||!validId(c.req.param('id'))||new URL(c.req.url).search
        ||(operation!=='retrieve'&&!v.is(v.pipe(v.string(),v.uuid()),requestId)))return invalid(c);
      const actor:ControlActor={orgId:c.req.param('companyId')!,actorUserId:c.get('identitySession').user.id,sessionId:c.get('identitySession').session.id,expectedMemberId:memberId};
      const denied=await access(c,actor,memberId);if(denied)return denied;
      const control=deps.replyTestControl??replyTestControl(c.env),native={control,runtime:deps.replyTestRuntime};
      let input:ReplyTestRequest|undefined;
      if(operation!=='read'){
        const raw=await c.req.json().catch(()=>null);
        if(operation==='retrieve'){const parsed=v.safeParse(replyTestRequestSchema,raw);if(!parsed.success)return invalid(c);input=parsed.output;}
        else if(!v.is(v.strictObject({}),raw))return invalid(c);
      }
      const id=input?.requestId??requestId!;
      try{
        let query=await readReplyTestQuery(c.env.DB!,actor,id,memberId);
        if(query&&query.conversationId!==c.req.param('id'))return missing(c);
        if(operation==='retrieve'){
          if(query&&JSON.stringify(original(query))!==JSON.stringify(input))return conflict(c);
          if(!query){
            if(c.env.REPLY_TEST_ENABLED!=='true')return apiError(c,'REPLY_TEST_DISABLED','Answer testing is disabled.',403);
            if(!c.env.KNOWLEDGE_AI||!c.env.KNOWLEDGE_INDEX||(!c.env.FLUE_REPLY_TEST_AGENT&&!c.env.AGENT_RUNTIME)||!c.env.NVAPI_KEY?.trim())return apiError(c,'REPLY_TEST_UNAVAILABLE','The answer test runtime is not configured.',503);
            let answerConfig:unknown,queryConfig:unknown;
            try{answerConfig=JSON.parse(c.env.REPLY_TEST_CONFIG_JSON??'');queryConfig=JSON.parse(c.env.REPLY_TEST_QUERY_CONFIG_JSON??'');}catch{return apiError(c,'PRICING_UNAVAILABLE','Answer and retrieval prices must be configured.',503);}
            const budget=await c.env.DB!.prepare("SELECT id FROM reply_test_budget WHERE organization_id=? AND enabled=1 AND starts_at<=unixepoch()*1000 AND ends_at>unixepoch()*1000 ORDER BY starts_at DESC LIMIT 1").bind(actor.orgId).first<{id:string}>();
            if(!budget)return apiError(c,'BUDGET_UNAVAILABLE','The answer-test budget is unavailable.',412);
            const {requestId:unused,...target}=input!;
            const context=await prepareReplyTest(c.env.DB!,control,actor,{...target,conversationId:c.req.param('id')});
            const admitted=await admitReplyTestQuery(c.env.DB!,control,actor,{requestId:id,budgetId:budget.id,context,answerConfig,queryConfig});
            if(!('query' in admitted)){
              const concurrent=await readReplyTestQuery(c.env.DB!,actor,id,memberId);
              if(concurrent&&JSON.stringify(original(concurrent))===JSON.stringify(input))query=concurrent;
              else if(admitted.outcome==='pricing_unavailable')return apiError(c,'PRICING_UNAVAILABLE','The configured model or pricing is unsupported.',503);
              else if(admitted.outcome==='budget_unavailable')return apiError(c,'BUDGET_UNAVAILABLE','The answer-test budget is unavailable.',412);
              else if(admitted.outcome==='query_limit')return apiError(c,'REPLY_TEST_QUERY_LIMIT','The daily retrieval allowance is unavailable.',429);
              else return admitted.outcome==='not_found'?missing(c):conflict(c);
            }else query=admitted.query;
          }
          await retrieveReplyTestQuery({...c.env,DB:c.env.DB!},actor,id,memberId,control);
          query=await readReplyTestQuery(c.env.DB!,actor,id,memberId);
        }
        if(!query)return missing(c);
        let currentStatus=status(query),answer:ReplyTestView['answer']=null;
        try{
          await replyTestModelInput(query.payload.context,query.evidence??{runId:query.id,contextHash:query.payload.context.contextHash,chunks:[]},{db:c.env.DB!,control,actor});
        }catch(error){if(error instanceof Error&&error.message.startsWith('REPLY_TEST_'))currentStatus='changed';else throw error;}
        if(currentStatus==='ready'){
          if(operation==='generate'){
            if(!await readReplyTestRun(c.env.DB!,actor,id,memberId)){
              if(c.env.REPLY_TEST_ENABLED!=='true')return apiError(c,'REPLY_TEST_DISABLED','Answer testing is disabled.',403);
              const reserved=await reserveReplyTest(c.env.DB!,control,actor,{requestId:id,budgetId:query.budgetId,context:query.payload.context,evidence:query.evidence!},query.payload.answerConfig);
              if(!('run' in reserved))return reserved.outcome==='not_found'?missing(c):reserved.outcome==='conflict'?conflict(c):apiError(c,'BUDGET_UNAVAILABLE','The answer-test budget is unavailable.',412);
            }
          }
          const result=operation==='generate'?await executeReplyTest(c.env,actor,{requestId:id,memberId},native):await readExecutedReplyTest(c.env,actor,{requestId:id,memberId},native);
          if(result.outcome==='found'){const {status,review,reason,usageStatus}=result;answer={status,review,reason,usageStatus};}
        }
        // Generation and observation can await a provider. Recheck before returning evidence to the browser.
        if(currentStatus==='ready')try{
          await replyTestModelInput(query.payload.context,query.evidence!,{db:c.env.DB!,control,actor});
        }catch(error){if(error instanceof Error&&error.message.startsWith('REPLY_TEST_')){currentStatus='changed';answer=null;}else throw error;}
        const finalDenied=await access(c,actor,memberId);if(finalDenied)return finalDenied;
        if(!await readReplyTestQuery(c.env.DB!,actor,id,memberId))return missing(c);
        const view:ReplyTestView={...original(query),question:query.payload.context.question,policyRevision:query.payload.context.policy.revision,status:currentStatus,
          sources:currentStatus==='ready'?query.evidence!.chunks.map(({documentId,revision,chunkId,bodyHash,body,score})=>({documentId,revision,chunkId,bodyHash,body,score})):[],answer};
        return jsonResponse(c,{companyId:actor.orgId,conversationId:query.conversationId,viewerMemberId:memberId,test:view});
      }catch(error){
        if(error instanceof Error&&error.message.startsWith('REPLY_TEST_'))return apiError(c,'REPLY_TEST_CHANGED','The selected message, policy, access or knowledge changed. Start a new test after review.',409);
        return apiError(c,operation==='read'?'REPLY_TEST_UNAVAILABLE':'OPERATION_UNCONFIRMED','Read the saved request before retrying this operation.',503);
      }
    });
  }
}
