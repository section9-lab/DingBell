import { sqlManagesCompany, NOW_MS_WHOLE_SECONDS } from '../../platform/database/sql.ts';
import * as v from 'valibot';
import { replyPolicyConfigSchema, type ReplyPolicyConfig } from '../../shared/reply-policy.ts';
import type { SettingsActor } from '../company-settings/storage.ts';

export type PolicyActor=SettingsActor;
const access=`SELECT 1 FROM member actor JOIN user caller ON caller.id=actor.user_id JOIN session login ON login.user_id=caller.id
  WHERE actor.organization_id=? AND actor.user_id=? AND login.id=? AND login.expires_at>${NOW_MS_WHOLE_SECONDS}
  AND caller.email_verified=1 AND ${sqlManagesCompany('actor.role')}`;
const params=(actor:PolicyActor)=>[actor.orgId,actor.actorUserId,actor.sessionId];
const storesAvailable=(config:string)=>`NOT EXISTS (SELECT 1 FROM json_each(${config},'$.storeIds') requested
  WHERE NOT EXISTS (SELECT 1 FROM store WHERE store.id=requested.value AND store.organization_id=reply_policy.organization_id))`;
const noOverlap=`(kind<>'automatic' OR NOT EXISTS (
  SELECT 1 FROM reply_policy other JOIN policy_version active ON active.organization_id=other.organization_id
  AND active.policy_id=other.id AND active.revision=other.published_revision
  WHERE other.organization_id=reply_policy.organization_id AND other.id<>reply_policy.id AND other.kind='automatic' AND other.enabled=1
  AND json_extract(active.config,'$.priority')=json_extract(reply_policy.draft_config,'$.priority')
  AND (json_array_length(active.config,'$.storeIds')=0 OR json_array_length(reply_policy.draft_config,'$.storeIds')=0
    OR EXISTS (SELECT 1 FROM json_each(active.config,'$.storeIds') s JOIN json_each(reply_policy.draft_config,'$.storeIds') d ON s.value=d.value))
  AND json_extract(active.config,'$.stage')=json_extract(reply_policy.draft_config,'$.stage')))`;
type Row={id:string;kind:ReplyPolicyConfig['kind'];version:number;draft_revision:number;tested_revision:number|null;tested_time_zone:string|null;
  draft_base_revision:number|null;draft_rollback_of:number|null;draft_config:string;published_revision:number|null;enabled:number;updated_at:number};
type VersionRow={revision:number;schema_version:1;config:string;time_zone:string;published_by:string;published_at:number;rollback_of:number|null};
const versionDTO=(row:VersionRow)=>({revision:row.revision,schemaVersion:row.schema_version,config:v.parse(replyPolicyConfigSchema,JSON.parse(row.config)),
  timeZone:row.time_zone,publishedBy:row.published_by,publishedAt:new Date(row.published_at).toISOString(),rollbackOf:row.rollback_of});

export async function listPolicies(db:D1Database,actor:PolicyActor,kind:string,after='') {
  const rows=await db.prepare(`SELECT id,kind,version,draft_revision,tested_revision,published_revision,enabled,updated_at,
    COALESCE((SELECT json_extract(config,'$.name') FROM policy_version WHERE organization_id=reply_policy.organization_id
      AND policy_id=reply_policy.id AND revision=reply_policy.published_revision),json_extract(draft_config,'$.name')) AS name FROM reply_policy WHERE organization_id=? AND kind=? AND id>? AND EXISTS (${access}) ORDER BY id LIMIT 21`)
    .bind(actor.orgId,kind,after,...params(actor)).all<Row&{name:string}>();
  return {policies:rows.results.slice(0,20).map(row=>({id:row.id,kind:row.kind,name:row.name,version:row.version,draftRevision:row.draft_revision,
    testedRevision:row.tested_revision,publishedRevision:row.published_revision,enabled:!!row.enabled,updatedAt:new Date(row.updated_at).toISOString()})),
    nextAfter:rows.results.length>20?rows.results[19].id:null};
}
export async function readPolicyHistory(db:D1Database,actor:PolicyActor,id:string,before=Number.MAX_SAFE_INTEGER) {
  const rows=await db.prepare(`SELECT revision,schema_version,config,time_zone,published_by,published_at,rollback_of FROM policy_version
    WHERE organization_id=? AND policy_id=? AND revision<? AND EXISTS (${access}) ORDER BY revision DESC LIMIT 11`)
    .bind(actor.orgId,id,before,...params(actor)).all<VersionRow>();
  return {versions:rows.results.slice(0,10).map(versionDTO),nextBefore:rows.results.length>10?rows.results[9].revision:null};
}
export async function readPolicy(db:D1Database,actor:PolicyActor,id:string) {
  const row=await db.prepare(`SELECT * FROM reply_policy WHERE organization_id=? AND id=? AND EXISTS (${access})`).bind(actor.orgId,id,...params(actor)).first<Row>();
  if(!row)return null;
  const history=await readPolicyHistory(db,actor,id,(row.published_revision??0)+1);
  if(!await db.prepare(access).bind(...params(actor)).first())return null;
  const published=history.versions.find(version=>version.revision===row.published_revision)??null;
  if(row.published_revision!==null&&!published)throw new Error('Missing policy publication');
  return {companyId:actor.orgId,policy:{id:row.id,kind:row.kind,version:row.version,draftRevision:row.draft_revision,testedRevision:row.tested_revision,testedTimeZone:row.tested_time_zone,
    draftBaseRevision:row.draft_base_revision,draftRollbackOf:row.draft_rollback_of,draft:v.parse(replyPolicyConfigSchema,JSON.parse(row.draft_config)),
    published,enabled:!!row.enabled,updatedAt:new Date(row.updated_at).toISOString()},history};
}
export async function ownsPolicyStores(db:D1Database,actor:PolicyActor,config:ReplyPolicyConfig) {
  return !!await db.prepare(`SELECT 1 WHERE EXISTS (${access}) AND NOT EXISTS (SELECT 1 FROM json_each(?) requested
    WHERE NOT EXISTS (SELECT 1 FROM store WHERE store.organization_id=? AND store.id=requested.value))`)
    .bind(...params(actor),JSON.stringify(config.storeIds),actor.orgId).first();
}
/** 删除策略并级联删除不可变版本快照；审计事件不引用策略，因此保留。 */
export function deletePolicy(db:D1Database,actor:PolicyActor,id:string,expectedVersion:number) {
  return db.prepare(`DELETE FROM reply_policy WHERE organization_id=? AND id=? AND version=? AND EXISTS (${access}) RETURNING id`)
    .bind(actor.orgId,id,expectedVersion,...params(actor)).first();
}

export function createPolicy(db:D1Database,actor:PolicyActor,id:string,config:ReplyPolicyConfig) {
  return db.prepare(`INSERT INTO reply_policy (organization_id,id,kind,version,draft_revision,draft_config,enabled,updated_at)
    SELECT ?,?,?,1,1,?,0,${NOW_MS_WHOLE_SECONDS} WHERE EXISTS (${access}) AND NOT EXISTS (SELECT 1 FROM json_each(?) requested
    WHERE NOT EXISTS (SELECT 1 FROM store WHERE store.organization_id=? AND store.id=requested.value))
    ON CONFLICT(organization_id,id) DO NOTHING RETURNING version`)
    .bind(actor.orgId,id,config.kind,JSON.stringify(config),...params(actor),JSON.stringify(config.storeIds),actor.orgId).first();
}
const currentTimeZone="COALESCE((SELECT time_zone FROM company_settings WHERE organization_id=reply_policy.organization_id),'UTC')";
export async function checkPolicy(db:D1Database,actor:PolicyActor,id:string,publishing=false) {
  const row=await db.prepare(`SELECT ${storesAvailable('draft_config')} AS stores_available,${noOverlap} AS no_overlap,
    (tested_revision=draft_revision AND tested_time_zone=${currentTimeZone}) AS test_current
    FROM reply_policy WHERE organization_id=? AND id=? AND EXISTS (${access})`).bind(actor.orgId,id,...params(actor)).first<{stores_available:number;no_overlap:number;test_current:number}>();
  return !row?'NOT_FOUND':!row.stores_available?'POLICY_STORE_UNAVAILABLE':!row.no_overlap?'POLICY_OVERLAP':publishing&&!row.test_current?'POLICY_TEST_REQUIRED':null;
}
export async function checkPolicyConfig(db:D1Database,actor:PolicyActor,id:string,config:ReplyPolicyConfig) {
  const row=await db.prepare(`SELECT ${storesAvailable('draft_config')} AS stores_available,${noOverlap} AS no_overlap
    FROM (SELECT ? AS organization_id,? AS id,? AS kind,? AS draft_config) AS reply_policy WHERE EXISTS (${access})`)
    .bind(actor.orgId,id,config.kind,JSON.stringify(config),...params(actor)).first<{stores_available:number;no_overlap:number}>();
  return !row?'NOT_FOUND':!row.stores_available?'POLICY_STORE_UNAVAILABLE':!row.no_overlap?'POLICY_OVERLAP':null;
}

// All checks and the immutable version snapshot commit together; no intermediate
// saved configuration can leak out when a direct save is rejected.
export function savePolicy(db:D1Database,actor:PolicyActor,id:string,expectedVersion:number,config:ReplyPolicyConfig,requestId:string) {
  const candidate='(SELECT config FROM candidate)';
  const scope=`NOT EXISTS (SELECT 1 FROM json_each(${candidate},'$.storeIds') requested
    WHERE NOT EXISTS (SELECT 1 FROM store WHERE store.organization_id=? AND store.id=requested.value))
    AND (json_extract(${candidate},'$.kind')<>'automatic' OR NOT EXISTS (
      SELECT 1 FROM reply_policy other JOIN policy_version active ON active.organization_id=other.organization_id
      AND active.policy_id=other.id AND active.revision=other.published_revision
      WHERE other.organization_id=? AND other.id<>? AND other.kind='automatic' AND other.enabled=1
      AND json_extract(active.config,'$.priority')=json_extract(${candidate},'$.priority')
      AND (json_array_length(active.config,'$.storeIds')=0 OR json_array_length(${candidate},'$.storeIds')=0
        OR EXISTS (SELECT 1 FROM json_each(active.config,'$.storeIds') s JOIN json_each(${candidate},'$.storeIds') d ON s.value=d.value))
      AND json_extract(active.config,'$.stage')=json_extract(${candidate},'$.stage')))`;
  const zone="COALESCE((SELECT time_zone FROM company_settings WHERE organization_id=?),'UTC')";
  if(expectedVersion===0) return db.prepare(`WITH candidate(config) AS (SELECT ?)
    INSERT INTO reply_policy (organization_id,id,kind,version,draft_revision,draft_config,tested_revision,tested_time_zone,
      draft_base_revision,published_revision,enabled,published_by,published_at,published_request_id,published_time_zone,updated_at)
    SELECT ?,?,?,1,1,${candidate},1,${zone},1,1,1,?,${NOW_MS_WHOLE_SECONDS},?,${zone},${NOW_MS_WHOLE_SECONDS}
    WHERE EXISTS (${access}) AND ${scope} ON CONFLICT(organization_id,id) DO NOTHING RETURNING version`)
    .bind(JSON.stringify(config),actor.orgId,id,config.kind,actor.orgId,actor.actorUserId,requestId,actor.orgId,
      ...params(actor),actor.orgId,actor.orgId,id).first();
  return db.prepare(`WITH candidate(config) AS (SELECT ?)
    UPDATE reply_policy SET draft_config=${candidate},draft_revision=draft_revision+1,tested_revision=draft_revision+1,
      tested_time_zone=${zone},draft_base_revision=COALESCE(published_revision,0)+1,draft_rollback_of=NULL,
      published_revision=COALESCE(published_revision,0)+1,enabled=1,published_by=?,published_at=${NOW_MS_WHOLE_SECONDS},
      published_request_id=?,published_time_zone=${zone},version=version+1,updated_at=${NOW_MS_WHOLE_SECONDS}
    WHERE organization_id=? AND id=? AND version=? AND version<9007199254740991 AND kind=?
      AND EXISTS (${access}) AND ${scope} RETURNING version`)
    .bind(JSON.stringify(config),actor.orgId,actor.actorUserId,requestId,actor.orgId,actor.orgId,id,expectedVersion,config.kind,
      ...params(actor),actor.orgId,actor.orgId,id).first();
}

export type PolicyChange={action:'draft';config:ReplyPolicyConfig}|{action:'test'|'publish'|'pause'}|{action:'restore';revision:number};
export function changePolicy(db:D1Database,actor:PolicyActor,id:string,expectedVersion:number,change:PolicyChange,requestId:string) {
  let set='',guard='',setValues:(string|number)[]=[],guardValues:(string|number)[]=[];
  if(change.action==='draft') {
    set='draft_config=?,draft_revision=draft_revision+1,tested_revision=NULL,tested_time_zone=NULL,draft_base_revision=published_revision,draft_rollback_of=NULL';
    setValues.push(JSON.stringify(change.config));
    guard=`AND kind=? AND NOT EXISTS (SELECT 1 FROM json_each(?) requested WHERE NOT EXISTS
      (SELECT 1 FROM store WHERE store.organization_id=reply_policy.organization_id AND store.id=requested.value))`;
    guardValues.push(change.config.kind,JSON.stringify(change.config.storeIds));
  } else if(change.action==='test') {set=`tested_revision=draft_revision,tested_time_zone=${currentTimeZone}`;guard=`AND ${storesAvailable('draft_config')} AND ${noOverlap}`;}
  else if(change.action==='pause') {set='enabled=0';guard='AND enabled=1';}
  else if(change.action==='restore') {
    set=`draft_config=(SELECT config FROM policy_version WHERE organization_id=reply_policy.organization_id AND policy_id=reply_policy.id AND revision=?),
      draft_revision=draft_revision+1,tested_revision=NULL,tested_time_zone=NULL,draft_base_revision=published_revision,draft_rollback_of=?`;
    setValues.push(change.revision,change.revision);guard='AND published_revision>=?';guardValues.push(change.revision);
  } else {
    set=`published_revision=COALESCE(published_revision,0)+1,draft_base_revision=COALESCE(published_revision,0)+1,enabled=1,
      published_by=?,published_at=${NOW_MS_WHOLE_SECONDS},published_request_id=?,
      published_time_zone=tested_time_zone`;
    setValues.push(actor.actorUserId,requestId);guard=`AND tested_revision=draft_revision AND tested_time_zone=${currentTimeZone} AND ${storesAvailable('draft_config')} AND ${noOverlap}`;
  }
  return db.prepare(`UPDATE reply_policy SET ${set},version=version+1,updated_at=${NOW_MS_WHOLE_SECONDS}
    WHERE organization_id=? AND id=? AND version=? AND version<9007199254740991 AND EXISTS (${access}) ${guard} RETURNING version`)
    .bind(...setValues,actor.orgId,id,expectedVersion,...params(actor),...guardValues).first();
}
