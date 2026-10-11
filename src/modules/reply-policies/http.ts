import type { Context, Hono } from 'hono';
import * as v from 'valibot';
import { apiError, jsonResponse, type ApplicationEnv } from '../../http.ts';
import { policyVersionSchema, replyPolicyConfigSchema } from '../../shared/reply-policy.ts';
import { auditedChange, type AuditOutcome } from '../audit/operation.ts';
import { readCompanySettings } from '../company-settings/storage.ts';
import { configured, limitedBody, signedIn } from '../identity/http.ts';
import { changePolicy, checkPolicy, createPolicy, listPolicies, ownsPolicyStores, readPolicy, readPolicyHistory, type PolicyActor, type PolicyChange } from './storage.ts';

const createSchema=v.strictObject({id:v.pipe(v.string(),v.uuid()),config:replyPolicyConfigSchema});
const expected={expectedVersion:policyVersionSchema};
const schemas={draft:v.strictObject({...expected,config:replyPolicyConfigSchema}),test:v.strictObject(expected),
  publish:v.strictObject(expected),pause:v.strictObject(expected),restore:v.strictObject({...expected,revision:policyVersionSchema})};
const unavailable=(c:Context<ApplicationEnv>)=>apiError(c,'NOT_FOUND','The reply policy is not available.',404);
const forbidden=(c:Context<ApplicationEnv>)=>apiError(c,'FORBIDDEN','Only company owners and administrators can configure reply policies.',403);
const conflict=(c:Context<ApplicationEnv>)=>apiError(c,'POLICY_CHANGED','Read and review the latest policy before retrying.',409);
const unconfirmed=(c:Context<ApplicationEnv>)=>apiError(c,'OPERATION_UNCONFIRMED','The policy may have changed. Read its latest version before retrying.',503);
const actorFor=(c:Context<ApplicationEnv>):PolicyActor=>({orgId:c.req.param('companyId')!,actorUserId:c.get('identitySession').user.id,sessionId:c.get('identitySession').session.id});
async function authorize(c:Context<ApplicationEnv>,actor:PolicyActor) {
  const settings=await readCompanySettings(c.env.DB!,actor);
  return !settings?unavailable(c):!['owner','admin'].includes(settings.role)?forbidden(c):null;
}
function record(c:Context<ApplicationEnv>,actor:PolicyActor,id:string,action:string,version:number) {
  return async(outcome:AuditOutcome)=>{await c.env.DB!.prepare(`INSERT INTO reply_policy_audit_event
    (id,request_id,organization_id,policy_id,actor_user_id,action,outcome,expected_version,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(),c.get('requestId'),actor.orgId,id,actor.actorUserId,action,outcome,version,Date.now()).run();};
}
export function registerReplyPolicyRoutes(app:Hono<ApplicationEnv>) {
  const base='/api/companies/:companyId/reply-policies';
  app.get(base,configured,signedIn,async c=>{
    const actor=actorFor(c),denied=await authorize(c,actor);if(denied)return denied;
    const kind=c.req.query('kind')??'automatic',after=c.req.query('after')??'';
    if(!['automatic','notification'].includes(kind)||after.length>128||Object.entries(c.req.queries()).some(([key,values])=>!['kind','after'].includes(key)||values.length!==1))
      return apiError(c,'INVALID_REQUEST','Provide one kind and an optional continuation ID.',400);
    const result=await listPolicies(c.env.DB!,actor,kind,after);
    return await authorize(c,actor)??jsonResponse(c,{companyId:actor.orgId,kind,...result});
  });
  app.get(`${base}/:id`,configured,signedIn,async c=>{
    const actor=actorFor(c),denied=await authorize(c,actor);if(denied)return denied;
    const result=await readPolicy(c.env.DB!,actor,c.req.param('id'));return result?jsonResponse(c,result):unavailable(c);
  });
  app.get(`${base}/:id/versions`,configured,signedIn,async c=>{
    const actor=actorFor(c),denied=await authorize(c,actor);if(denied)return denied;
    const before=c.req.query('before'),parsed=v.safeParse(policyVersionSchema,Number(before));
    if(!parsed.success||Object.entries(c.req.queries()).some(([key,values])=>key!=='before'||values.length!==1))return apiError(c,'INVALID_REQUEST','Provide the history continuation revision.',400);
    if(!await readPolicy(c.env.DB!,actor,c.req.param('id')))return unavailable(c);
    const result=await readPolicyHistory(c.env.DB!,actor,c.req.param('id'),parsed.output);
    return await authorize(c,actor)??jsonResponse(c,{companyId:actor.orgId,policyId:c.req.param('id'),...result});
  });
  app.post(base,configured,limitedBody,signedIn,async c=>{
    const actor=actorFor(c),denied=await authorize(c,actor);if(denied)return denied;
    const parsed=v.safeParse(createSchema,await c.req.json().catch(()=>null));
    if(!parsed.success||!await ownsPolicyStores(c.env.DB!,actor,parsed.output.config))return apiError(c,'INVALID_REQUEST','Provide a valid policy and stores in this company.',400);
    const {id,config}=parsed.output;
    const result=await auditedChange(record(c,actor,id,'create',0),async()=>{
      const changed=await createPolicy(c.env.DB!,actor,id,config),denied=await authorize(c,actor);
      if(denied)return changed?unconfirmed(c):denied;
      if(!changed)return conflict(c);
      const current=await readPolicy(c.env.DB!,actor,id);return current?jsonResponse(c,current):unconfirmed(c);
    });
    return result.auditComplete?result.response:unconfirmed(c);
  });
  for(const action of ['draft','test','publish','pause','restore'] as const) app.post(`${base}/:id/${action}`,configured,limitedBody,signedIn,async c=>{
    const actor=actorFor(c),denied=await authorize(c,actor);if(denied)return denied;
    const parsed=v.safeParse(schemas[action],await c.req.json().catch(()=>null));
    if(!parsed.success)return apiError(c,'INVALID_REQUEST','Provide valid configuration and the current policy version.',400);
    const id=c.req.param('id'),current=await readPolicy(c.env.DB!,actor,id);if(!current)return unavailable(c);
    const change={action,...parsed.output} as PolicyChange;
    if(change.action==='draft'&&(change.config.kind!==current.policy.kind||!await ownsPolicyStores(c.env.DB!,actor,change.config)))
      return apiError(c,'INVALID_REQUEST','The kind is fixed and stores must belong to this company.',400);
    const result=await auditedChange(record(c,actor,id,action,parsed.output.expectedVersion),async()=>{
      if(current.policy.version!==parsed.output.expectedVersion)return conflict(c);
      if(action==='publish'&&current.policy.testedRevision!==current.policy.draftRevision)return apiError(c,'POLICY_TEST_REQUIRED','Check the saved draft before publishing.',409);
      if(action==='test'||action==='publish') {
        const problem=await checkPolicy(c.env.DB!,actor,id,action==='publish');
        if(problem)return apiError(c,problem,problem==='POLICY_OVERLAP'?'An active automatic policy overlaps at the same priority.':'One or more policy stores are unavailable.',409);
      }
      if(change.action==='restore'&&change.revision>(current.policy.published?.revision??0))return unavailable(c);
      const changed=await changePolicy(c.env.DB!,actor,id,parsed.output.expectedVersion,change,c.get('requestId'));
      const denied=await authorize(c,actor);if(denied)return changed?unconfirmed(c):denied;
      if(!changed)return conflict(c);
      const latest=await readPolicy(c.env.DB!,actor,id);return latest?jsonResponse(c,latest):unconfirmed(c);
    });
    return result.auditComplete?result.response:unconfirmed(c);
  });
}
