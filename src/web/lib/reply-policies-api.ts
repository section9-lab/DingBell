import * as v from 'valibot';
import { replyPolicyConfigSchema, type ReplyPolicyConfig } from '../../shared/reply-policy.ts';
import { canonicalTimeZone } from '../../shared/time-zone.ts';
import { request } from './api.ts';

const version=v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(Number.MAX_SAFE_INTEGER));
const time=v.pipe(v.string(),v.isoTimestamp(),v.check(value=>Number.isFinite(Date.parse(value))));
const kind=v.picklist(['automatic','notification']);
const publication=v.pipe(v.object({revision:version,schemaVersion:v.literal(1),config:replyPolicyConfigSchema,
  timeZone:v.pipe(v.string(),v.check(value=>canonicalTimeZone(value)!==null)),publishedBy:v.string(),publishedAt:time,rollbackOf:v.nullable(version)}),
  v.check(value=>value.rollbackOf===null||value.rollbackOf<value.revision));
const historyFields={versions:v.pipe(v.array(publication),v.maxLength(10)),nextBefore:v.nullable(version)};
const history=v.pipe(v.object(historyFields),v.check(value=>
  value.versions.every((row,index)=>index===0||row.revision<value.versions[index-1].revision)&&
  (value.nextBefore===null||(value.versions.length===10&&value.nextBefore===value.versions.at(-1)?.revision))));
const summary={id:v.string(),kind,name:v.string(),version,draftRevision:version,testedRevision:v.nullable(version),publishedRevision:v.nullable(version),enabled:v.boolean(),updatedAt:time};
const schema=(companyId:string,id:string)=>v.pipe(v.object({companyId:v.literal(companyId),policy:v.object({
  id:v.literal(id),kind,version,draftRevision:version,testedRevision:v.nullable(version),testedTimeZone:v.nullable(v.pipe(v.string(),v.check(value=>canonicalTimeZone(value)!==null))),draftBaseRevision:v.nullable(version),draftRollbackOf:v.nullable(version),
  draft:replyPolicyConfigSchema,published:v.nullable(publication),enabled:v.boolean(),updatedAt:time,
}),history}),v.check(({policy:p,history:h})=>p.kind===p.draft.kind&&p.draftRevision<=p.version&&
  (p.testedRevision===null?p.testedTimeZone===null:p.testedRevision===p.draftRevision&&p.testedTimeZone!==null)&&(!p.enabled||p.published!==null)&&
  (p.published===null?h.versions.length===0&&p.draftBaseRevision===null&&p.draftRollbackOf===null:
    p.published.config.kind===p.kind&&p.published.revision<=p.version&&p.draftBaseRevision===p.published.revision&&
    (p.draftRollbackOf===null||p.draftRollbackOf<=p.published.revision)&&
    JSON.stringify(p.published)===JSON.stringify(h.versions[0])&&h.versions.every(row=>row.config.kind===p.kind))));
const path=(companyId:string,id?:string)=>`/api/companies/${encodeURIComponent(companyId)}/reply-policies${id?`/${encodeURIComponent(id)}`:''}`;
export type ReplyPolicyDetail=v.InferOutput<ReturnType<typeof schema>>;
export type PolicyPublication=v.InferOutput<typeof publication>;
export type PolicyKind=ReplyPolicyConfig['kind'];
export function readReplyPolicies(companyId:string,policyKind:PolicyKind,after='',signal?:AbortSignal) {
  return request(`${path(companyId)}?kind=${policyKind}&after=${encodeURIComponent(after)}`,v.object({companyId:v.literal(companyId),kind:v.literal(policyKind),
    policies:v.pipe(v.array(v.object({...summary,kind:v.literal(policyKind)})),v.maxLength(20),v.check(rows=>rows.every((row,index)=>
      row.draftRevision<=row.version&&(row.testedRevision===null||row.testedRevision===row.draftRevision)&&(!row.enabled||row.publishedRevision!==null)&&
      (index===0?row.id>after:row.id>rows[index-1].id)))),nextAfter:v.nullable(v.string())}),{signal});
}
export function readReplyPolicy(companyId:string,id:string,signal?:AbortSignal) {return request(path(companyId,id),schema(companyId,id),{signal});}
export function readPolicyVersions(companyId:string,id:string,before:number,signal?:AbortSignal) {
  return request(`${path(companyId,id)}/versions?before=${before}`,v.pipe(v.object({companyId:v.literal(companyId),policyId:v.literal(id),...historyFields}),
    v.check(value=>v.safeParse(history,value).success&&value.versions.every(row=>row.revision<before))),{signal});
}
export function createReplyPolicy(companyId:string,id:string,config:ReplyPolicyConfig) {
  return request(path(companyId),schema(companyId,id),{method:'POST',body:JSON.stringify({id,config})});
}
type Changes={draft:{expectedVersion:number;config:ReplyPolicyConfig};test:{expectedVersion:number};publish:{expectedVersion:number};pause:{expectedVersion:number};restore:{expectedVersion:number;revision:number}};
export function updateReplyPolicy<A extends keyof Changes>(companyId:string,id:string,action:A,body:Changes[A]) {
  return request(`${path(companyId,id)}/${action}`,schema(companyId,id),{method:'POST',body:JSON.stringify(body)});
}
