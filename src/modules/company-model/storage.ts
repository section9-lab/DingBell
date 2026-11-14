import { sqlManagesCompany, NOW_MS } from '../../platform/database/sql.ts';
import type { SettingsActor } from '../company-settings/storage.ts';
import type { ModelExecution,CompanyModelTestFailure } from '../../shared/company-model.ts';
import type { ModelSecret } from './security.ts';
export type ModelAuthType='api_key'|'oauth';
export type ModelRecord=ModelSecret & {companyId:string;revision:number;provider:string;api:string;authType:ModelAuthType;baseUrl:string;model:string;execution:string|null};
const columns='organization_id AS companyId,revision,provider,api,auth_type AS authType,base_url AS baseUrl,model,key_version AS keyVersion,nonce,ciphertext,execution';
export type CompanyCredentialRecord=ModelSecret & {companyId:string;provider:string;authType:ModelAuthType;credentialVersion:number;expiresAt:number|null;accountLabel:string|null;updatedAt:number};
export type AuthSessionRecord={id:string;organizationId:string;provider:string;status:'pending'|'complete'|'failed'|'expired';deviceCodeKeyVersion:string;deviceCodeNonce:string;deviceCodeCiphertext:string;userCode:string;verificationUri:string;intervalSeconds:number;expiresAt:number;nextPollAt:number;failureCode:string|null;createdAt:number;updatedAt:number};
const credentialColumns='organization_id AS companyId,provider,auth_type AS authType,credential_version AS credentialVersion,key_version AS keyVersion,nonce,ciphertext,expires_at AS expiresAt,account_label AS accountLabel,updated_at AS updatedAt';
export function readCompanyModel(db:D1Database,companyId:string,revision?:number){
  return db.prepare(`SELECT ${columns} FROM company_ai_model_revision WHERE organization_id=?${revision===undefined?' ORDER BY revision DESC LIMIT 1':' AND revision=?'}`)
    .bind(companyId,...(revision===undefined?[]:[revision])).first<ModelRecord>();
}
export const modelManagerAccess=`EXISTS(SELECT 1 FROM member a JOIN user u ON u.id=a.user_id JOIN session s ON s.user_id=u.id
  WHERE a.organization_id=? AND a.user_id=? AND s.id=? AND s.expires_at>${NOW_MS} AND u.email_verified=1 AND ${sqlManagesCompany('a.role')})`;
const actorValues=(a:SettingsActor)=>[a.orgId,a.actorUserId,a.sessionId];
export function insertCompanyModel(db:D1Database,actor:SettingsActor,expectedVersion:number,provider:string,api:string,baseUrl:string,model:string,secret:ModelSecret,execution:ModelExecution|null,authType:ModelAuthType='api_key'){
  return db.prepare(`INSERT INTO company_ai_model_revision(organization_id,revision,provider,api,auth_type,base_url,model,key_version,nonce,ciphertext,execution,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,${NOW_MS} WHERE ${modelManagerAccess}
    AND (SELECT COALESCE(MAX(revision),0) FROM company_ai_model_revision WHERE organization_id=?)=?
    ON CONFLICT(organization_id,revision) DO NOTHING RETURNING revision`)
    .bind(actor.orgId,expectedVersion+1,provider,api,authType,baseUrl,model,secret.keyVersion,secret.nonce,secret.ciphertext,execution?JSON.stringify(execution):null,...actorValues(actor),actor.orgId,expectedVersion).first<{revision:number}>();
}
export function readCompanyCredential(db:D1Database,companyId:string,provider:string){
  return db.prepare(`SELECT ${credentialColumns} FROM company_ai_model_credential WHERE organization_id=? AND provider=?`).bind(companyId,provider).first<CompanyCredentialRecord>();
}
/** Monotonic write: a losing concurrent refresh keeps the newer credential. */
export function saveCompanyCredential(db:D1Database,record:CompanyCredentialRecord){
  return db.prepare(`INSERT INTO company_ai_model_credential(organization_id,provider,auth_type,credential_version,key_version,nonce,ciphertext,expires_at,account_label,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,provider) DO UPDATE SET
    auth_type=excluded.auth_type,credential_version=excluded.credential_version,key_version=excluded.key_version,nonce=excluded.nonce,ciphertext=excluded.ciphertext,
    expires_at=excluded.expires_at,account_label=excluded.account_label,updated_at=excluded.updated_at
    WHERE excluded.credential_version>company_ai_model_credential.credential_version RETURNING credential_version`)
    .bind(record.companyId,record.provider,record.authType,record.credentialVersion,record.keyVersion,record.nonce,record.ciphertext,record.expiresAt,record.accountLabel,record.updatedAt,record.updatedAt).first<{credential_version:number}>();
}
export function deleteCompanyCredential(db:D1Database,companyId:string,provider:string){
  return db.prepare('DELETE FROM company_ai_model_credential WHERE organization_id=? AND provider=?').bind(companyId,provider).run();
}
export function insertAuthSession(db:D1Database,record:AuthSessionRecord){return db.prepare(`INSERT INTO company_ai_model_auth_session(id,organization_id,provider,status,device_code_key_version,device_code_nonce,device_code_ciphertext,user_code,verification_uri,interval_seconds,expires_at,next_poll_at,failure_code,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(record.id,record.organizationId,record.provider,record.status,record.deviceCodeKeyVersion,record.deviceCodeNonce,record.deviceCodeCiphertext,record.userCode,record.verificationUri,record.intervalSeconds,record.expiresAt,record.nextPollAt,record.failureCode,record.createdAt,record.updatedAt).run();}
export function readAuthSession(db:D1Database,organizationId:string,id:string){return db.prepare(`SELECT id,organization_id AS organizationId,provider,status,device_code_key_version AS deviceCodeKeyVersion,device_code_nonce AS deviceCodeNonce,device_code_ciphertext AS deviceCodeCiphertext,user_code AS userCode,verification_uri AS verificationUri,interval_seconds AS intervalSeconds,expires_at AS expiresAt,next_poll_at AS nextPollAt,failure_code AS failureCode,created_at AS createdAt,updated_at AS updatedAt FROM company_ai_model_auth_session WHERE organization_id=? AND id=?`).bind(organizationId,id).first<AuthSessionRecord>();}
export function updateAuthSession(db:D1Database,organizationId:string,id:string,status:AuthSessionRecord['status'],nextPollAt:number,intervalSeconds:number,failureCode:string|null){return db.prepare(`UPDATE company_ai_model_auth_session SET status=?,next_poll_at=?,interval_seconds=?,failure_code=?,updated_at=? WHERE organization_id=? AND id=? RETURNING id`).bind(status,nextPollAt,intervalSeconds,failureCode,Date.now(),organizationId,id).first<{id:string}>();}
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
