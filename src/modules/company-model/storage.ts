import { sqlManagesCompany, NOW_MS } from '../../platform/database/sql.ts';
import type { SettingsActor } from '../company-settings/storage.ts';
import type { ModelExecution,CompanyModelTestFailure } from '../../shared/company-model.ts';
import type { ModelSecret } from './security.ts';
export type ModelRecord=ModelSecret & {companyId:string;revision:number;baseUrl:string;model:string;execution:string|null};
const columns='organization_id AS companyId,revision,base_url AS baseUrl,model,key_version AS keyVersion,nonce,ciphertext,execution';
export function readCompanyModel(db:D1Database,companyId:string,revision?:number){
  return db.prepare(`SELECT ${columns} FROM company_ai_model_revision WHERE organization_id=?${revision===undefined?' ORDER BY revision DESC LIMIT 1':' AND revision=?'}`)
    .bind(companyId,...(revision===undefined?[]:[revision])).first<ModelRecord>();
}
export const modelManagerAccess=`EXISTS(SELECT 1 FROM member a JOIN user u ON u.id=a.user_id JOIN session s ON s.user_id=u.id
  WHERE a.organization_id=? AND a.user_id=? AND s.id=? AND s.expires_at>${NOW_MS} AND u.email_verified=1 AND ${sqlManagesCompany('a.role')})`;
const actorValues=(a:SettingsActor)=>[a.orgId,a.actorUserId,a.sessionId];
export function insertCompanyModel(db:D1Database,actor:SettingsActor,expectedVersion:number,baseUrl:string,model:string,secret:ModelSecret,execution:ModelExecution|null){
  return db.prepare(`INSERT INTO company_ai_model_revision(organization_id,revision,base_url,model,key_version,nonce,ciphertext,execution,created_at)
    SELECT ?,?,?,?,?,?,?,?,${NOW_MS} WHERE ${modelManagerAccess}
    AND (SELECT COALESCE(MAX(revision),0) FROM company_ai_model_revision WHERE organization_id=?)=?
    ON CONFLICT(organization_id,revision) DO NOTHING RETURNING revision`)
    .bind(actor.orgId,expectedVersion+1,baseUrl,model,secret.keyVersion,secret.nonce,secret.ciphertext,execution?JSON.stringify(execution):null,...actorValues(actor),actor.orgId,expectedVersion).first<{revision:number}>();
}
export function claimModelTest(db:D1Database,actor:SettingsActor,revision:number,attemptId:string){
  const now=Date.now();
  return db.prepare(`INSERT INTO company_ai_model_test(organization_id,revision,attempt_id,status,tested_at,next_test_at)
    SELECT ?,?,?,'pending',?,? WHERE ${modelManagerAccess}
    AND (SELECT MAX(revision) FROM company_ai_model_revision WHERE organization_id=?)=?
    ON CONFLICT(organization_id) DO UPDATE SET revision=excluded.revision,attempt_id=excluded.attempt_id,status='pending',failure_code=NULL,provider_status=NULL,tested_at=excluded.tested_at,next_test_at=excluded.next_test_at
    WHERE company_ai_model_test.next_test_at<=? RETURNING attempt_id`)
    .bind(actor.orgId,revision,attemptId,now,now+60000,...actorValues(actor),actor.orgId,revision,now).first();
}
// Reuse the persistent request limiter, with a company-scoped namespace and no provider data.
export function claimModelCatalog(db:D1Database,actor:SettingsActor,revision:number){
  const key=`dingbell:company-model:catalog:${actor.orgId}`,now=NOW_MS;
  return db.prepare(`INSERT INTO rate_limit(id,key,count,last_request)
    SELECT ?,?,1,${now} WHERE ${modelManagerAccess}
    AND (SELECT COALESCE(MAX(revision),0) FROM company_ai_model_revision WHERE organization_id=?)=?
    ON CONFLICT(key) DO UPDATE SET count=1,last_request=excluded.last_request
    WHERE rate_limit.last_request<=${now}-10000 RETURNING id`)
    .bind(crypto.randomUUID(),key,...actorValues(actor),actor.orgId,revision).first();
}
export function readModelTest(db:D1Database,companyId:string,revision:number){return db.prepare('SELECT status,tested_at AS testedAt,failure_code AS failureCode,provider_status AS providerStatus FROM company_ai_model_test WHERE organization_id=? AND revision=?').bind(companyId,revision).first<{status:'pending'|'passed'|'failed';testedAt:number;failureCode:CompanyModelTestFailure|null;providerStatus:number|null}>();}
