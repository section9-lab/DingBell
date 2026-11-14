import { integer,primaryKey,sqliteTable,text } from 'drizzle-orm/sqlite-core';
import { organization } from '../identity/schema.ts';
export const companyAiModelRevision=sqliteTable('company_ai_model_revision',{
  organizationId:text('organization_id').notNull().references(()=>organization.id,{onDelete:'cascade'}),revision:integer('revision').notNull(),
  provider:text('provider').notNull().default('custom'),api:text('api').notNull().default('openai-completions'),authType:text('auth_type').notNull().default('api_key'),
  baseUrl:text('base_url').notNull(),model:text('model').notNull(),keyVersion:text('key_version').notNull(),nonce:text('nonce').notNull(),ciphertext:text('ciphertext').notNull(),
  execution:text('execution'),createdAt:integer('created_at').notNull(),
},table=>[primaryKey({columns:[table.organizationId,table.revision]})]);
export const companyAiModelCredential=sqliteTable('company_ai_model_credential',{
  organizationId:text('organization_id').notNull().references(()=>organization.id,{onDelete:'cascade'}),provider:text('provider').notNull(),
  authType:text('auth_type').notNull(),credentialVersion:integer('credential_version').notNull(),
  keyVersion:text('key_version').notNull(),nonce:text('nonce').notNull(),ciphertext:text('ciphertext').notNull(),
  expiresAt:integer('expires_at'),accountLabel:text('account_label'),createdAt:integer('created_at').notNull(),updatedAt:integer('updated_at').notNull(),
},table=>[primaryKey({columns:[table.organizationId,table.provider]})]);
export const companyAiModelAuthSession=sqliteTable('company_ai_model_auth_session',{
  id:text('id').primaryKey(),organizationId:text('organization_id').notNull().references(()=>organization.id,{onDelete:'cascade'}),provider:text('provider').notNull(),status:text('status').notNull(),
  deviceCodeKeyVersion:text('device_code_key_version').notNull(),deviceCodeNonce:text('device_code_nonce').notNull(),deviceCodeCiphertext:text('device_code_ciphertext').notNull(),
  userCode:text('user_code').notNull(),verificationUri:text('verification_uri').notNull(),intervalSeconds:integer('interval_seconds').notNull(),
  expiresAt:integer('expires_at').notNull(),nextPollAt:integer('next_poll_at').notNull(),failureCode:text('failure_code'),createdAt:integer('created_at').notNull(),updatedAt:integer('updated_at').notNull(),
});
export const companyAiModelTest=sqliteTable('company_ai_model_test',{
  organizationId:text('organization_id').primaryKey().references(()=>organization.id,{onDelete:'cascade'}),revision:integer('revision').notNull(),
  attemptId:text('attempt_id').notNull(),status:text('status').notNull(),failureCode:text('failure_code'),providerStatus:integer('provider_status'),testedAt:integer('tested_at').notNull(),nextTestAt:integer('next_test_at').notNull(),
});
export const companyAiModelAudit=sqliteTable('company_ai_model_audit',{
  id:text('id').primaryKey(),requestId:text('request_id').notNull(),organizationId:text('organization_id').notNull().references(()=>organization.id,{onDelete:'cascade'}),
  actorUserId:text('actor_user_id').notNull(),action:text('action').notNull(),revision:integer('revision').notNull(),outcome:text('outcome').notNull(),createdAt:integer('created_at').notNull(),
});
