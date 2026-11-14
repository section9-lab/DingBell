import type { Hono } from 'hono';
import * as v from 'valibot';
import { apiError,jsonResponse,type ApplicationEnv } from '../../http.ts';
import { companyModelCommandSchema,companyModelCatalogCommandSchema,companyModelOAuthStartSchema,modelExecutionSchema, type CompanyModelView } from '../../shared/company-model.ts';
import { configured,limitedBody,signedIn } from '../identity/http.ts';
import { readCompanySettings, type SettingsActor } from '../company-settings/storage.ts';
import { credentialConfig } from '../stores/credentials.ts';
import { auditedChange,type AuditOutcome } from '../audit/operation.ts';
import { readCompanyModel,insertCompanyModel,claimModelTest,readModelTest,claimModelCatalog,readCompanyCredential } from './storage.ts';
import { modelBaseUrl,sealModelKey,openModelKey,type ModelSecret } from './security.ts';
import {listProviderModels,ModelCatalogError} from './catalog.ts';
import { providerCatalog,resolveProviderModel } from './providers.ts';
import {probeCompanyModel} from './probe.ts';
import {OAuthLoginError,pollKimiLogin,startKimiLogin} from './oauth.ts';
export interface CompanyModelDependencies { modelFetch?:typeof fetch }
const versionSchema=v.strictObject({expectedVersion:v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(Number.MAX_SAFE_INTEGER-1))});
async function manager(db:D1Database,actor:SettingsActor){const row=await readCompanySettings(db,actor);return row&&['owner','admin'].includes(row.role);}
async function view(env:ApplicationEnv['Bindings'],companyId:string):Promise<CompanyModelView>{
  const row=await readCompanyModel(env.DB!,companyId),test=row?await readModelTest(env.DB!,companyId,row.revision):null;
  const credential=row?.authType==='oauth'?await readCompanyCredential(env.DB!,companyId,row.provider):null;
  return {companyId,version:row?.revision??0,provider:row?.provider??'custom',baseUrl:row?.baseUrl??null,model:row?.model??null,hasKey:!!row,
    authType:row?.authType??'api_key',credentialExpiresAt:credential?.expiresAt?new Date(credential.expiresAt).toISOString():null,
    encryptionConfigured:!!credentialConfig(env),runtimeEnabled:!!env.CONVERSATION_CONTROLLER&&!!env.AGENT_RUNTIME,
    execution:row?.execution?v.parse(modelExecutionSchema,JSON.parse(row.execution)):null,
    test:test?{status:test.status,testedAt:new Date(test.testedAt).toISOString(),failureCode:test.failureCode,providerStatus:test.providerStatus}:null};
}
export function registerCompanyModelRoutes(app:Hono<ApplicationEnv>,deps:CompanyModelDependencies={}){
  const base='/api/companies/:companyId/settings/ai-model';
  app.get(`${base}/providers`,configured,signedIn,async c=>{
    const identity=c.get('identitySession'),actor={orgId:c.req.param('companyId')!,actorUserId:identity.user.id,sessionId:identity.session.id},db=c.env.DB!;
    if(new URL(c.req.url).search)return apiError(c,'INVALID_REQUEST','Unexpected query parameters.',400);
    const company=await readCompanySettings(db,actor);if(!company||!['owner','admin'].includes(company.role))return apiError(c,'NOT_FOUND','The company model configuration is not available.',404);
    return jsonResponse(c,{companyId:actor.orgId,providers:providerCatalog().map(entry=>({...entry,models:entry.supported?entry.models.filter(model=>model.api==='openai-completions'):[]}))});
  });
  app.post(`${base}/oauth/start`,configured,limitedBody,signedIn,async c=>{
    const identity=c.get('identitySession'),actor={orgId:c.req.param('companyId')!,actorUserId:identity.user.id,sessionId:identity.session.id},db=c.env.DB!;
    if(new URL(c.req.url).search)return apiError(c,'INVALID_REQUEST','Unexpected query parameters.',400);
    const company=await readCompanySettings(db,actor);if(!company)return apiError(c,'NOT_FOUND','The company model configuration is not available.',404);
    if(!['owner','admin'].includes(company.role))return apiError(c,'FORBIDDEN','Only company owners and administrators can manage model connections.',403);
    const parsed=v.safeParse(companyModelOAuthStartSchema,await c.req.json().catch(()=>null));
    if(!parsed.success)return apiError(c,'INVALID_REQUEST','Choose a supported OAuth provider.',400);
    try{return jsonResponse(c,await startKimiLogin(c.env,actor.orgId,deps.modelFetch??fetch,c.req.raw.signal));}
    catch(error){const code=error instanceof OAuthLoginError?error.code:'oauth_unavailable';return apiError(c,code.toUpperCase(),'The provider login could not be started.',502);}
  });
  app.get(`${base}/oauth/:sessionId`,configured,signedIn,async c=>{
    const identity=c.get('identitySession'),actor={orgId:c.req.param('companyId')!,actorUserId:identity.user.id,sessionId:identity.session.id},db=c.env.DB!;
    if(new URL(c.req.url).search)return apiError(c,'INVALID_REQUEST','Unexpected query parameters.',400);
    const sessionId=c.req.param('sessionId')!;if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId))return apiError(c,'INVALID_REQUEST','Invalid login session.',400);
    const company=await readCompanySettings(db,actor);if(!company)return apiError(c,'NOT_FOUND','The company model configuration is not available.',404);
    if(!['owner','admin'].includes(company.role))return apiError(c,'FORBIDDEN','Only company owners and administrators can manage model connections.',403);
    try{const result=await pollKimiLogin(c.env,actor.orgId,sessionId,deps.modelFetch??fetch,c.req.raw.signal);return result?jsonResponse(c,result):apiError(c,'NOT_FOUND','The login session is not available.',404);}
    catch(error){const code=error instanceof OAuthLoginError?error.code:'oauth_unavailable';return apiError(c,code.toUpperCase(),'The provider login could not be completed.',502);}
  });
  app.post(`${base}/models`,configured,limitedBody,signedIn,async c=>{
    const identity=c.get('identitySession'),actor={orgId:c.req.param('companyId')!,actorUserId:identity.user.id,sessionId:identity.session.id},db=c.env.DB!;
    const missing=()=>apiError(c,'NOT_FOUND','The company model configuration is not available.',404);
    const changed=()=>apiError(c,'SETTINGS_CHANGED','Read the latest model configuration before listing models.',409);
    if(new URL(c.req.url).search)return apiError(c,'INVALID_REQUEST','Unexpected query parameters.',400);
    const company=await readCompanySettings(db,actor);if(!company)return missing();
    if(!['owner','admin'].includes(company.role))return apiError(c,'FORBIDDEN','Only company managers can list provider models.',403);
    const parsed=v.safeParse(companyModelCatalogCommandSchema,await c.req.json().catch(()=>null));
    if(!parsed.success)return apiError(c,'INVALID_REQUEST','Provide the Base URL, optional provider key and current version only.',400);
    const command=parsed.output,current=await readCompanyModel(db,actor.orgId);
    if((current?.revision??0)!==command.expectedVersion)return changed();
    const baseUrl=modelBaseUrl(command.baseUrl,c.env);
    if(!baseUrl)return apiError(c,'MODEL_URL_REJECTED','Use an approved HTTPS Base URL.',400);
    let key=command.apiKey;
    if(!key){
      if(!current||new URL(current.baseUrl).origin!==new URL(baseUrl).origin)return apiError(c,'MODEL_KEY_REQUIRED','Provide the provider key for this host.',400);
      try{key=await openModelKey(c.env,actor.orgId,current.revision,current.baseUrl,current.model,current);}catch{return apiError(c,'CREDENTIALS_UNAVAILABLE','The saved provider key cannot be opened.',503);}
    }
    if(!await claimModelCatalog(db,actor,command.expectedVersion)){
      if(!await manager(db,actor))return missing();
      if((await readCompanyModel(db,actor.orgId))?.revision!==(current?.revision))return changed();
      return apiError(c,'MODEL_CATALOG_RATE_LIMITED','Wait ten seconds before listing models again.',429);
    }
    // A key may be reused only while the original configuration and manager access remain current.
    if(!await manager(db,actor))return missing();
    if((await readCompanyModel(db,actor.orgId))?.revision!==current?.revision)return changed();
    let catalog:Awaited<ReturnType<typeof listProviderModels>>|undefined,failure:unknown;
    try{catalog=await listProviderModels(baseUrl,key,deps.modelFetch??fetch,c.req.raw.signal);}catch(error){failure=error;}
    if(!await manager(db,actor))return missing();
    if((await readCompanyModel(db,actor.orgId))?.revision!==current?.revision)return changed();
    if(!catalog){const code=failure instanceof ModelCatalogError?failure.code:'MODEL_CATALOG_UNAVAILABLE';return apiError(c,code,'The provider model list could not be read. Manual model IDs remain supported.',code==='MODEL_CATALOG_RATE_LIMITED'?429:502);}
    return jsonResponse(c,{companyId:actor.orgId,version:command.expectedVersion,baseUrl,...catalog});
  });
  for(const [method,path,test]of [['get',base,false],['post',base,false],['post',`${base}/test`,true]] as const){
    app[method](path,configured,limitedBody,signedIn,async c=>{
      const identity=c.get('identitySession'),actor={orgId:c.req.param('companyId')!,actorUserId:identity.user.id,sessionId:identity.session.id},db=c.env.DB!;
      const missing=()=>apiError(c,'NOT_FOUND','The company model configuration is not available.',404);
      const conflict=()=>apiError(c,'SETTINGS_CHANGED','The saved model configuration changed. Read it before continuing.',409);
      if(new URL(c.req.url).search)return apiError(c,'INVALID_REQUEST','Unexpected query parameters.',400);
      const company=await readCompanySettings(db,actor);if(!company)return missing();
      if(!['owner','admin'].includes(company.role))return apiError(c,'FORBIDDEN','Only company owners and administrators can manage model connections.',403);
      if(method==='get'){const result=await view(c.env,actor.orgId);return await manager(db,actor)?jsonResponse(c,result):missing();}
      const body=await c.req.json().catch(()=>null),current=await readCompanyModel(db,actor.orgId);
      const parsed=v.safeParse(test?versionSchema:companyModelCommandSchema,body);
      if(!parsed.success)return apiError(c,'INVALID_REQUEST','Provide a valid model configuration and current version.',400);
      const expectedVersion=parsed.output.expectedVersion;
      if((current?.revision??0)!==expectedVersion)return conflict();
      if(!credentialConfig(c.env))return apiError(c,'CREDENTIALS_NOT_CONFIGURED','Configure deployment encryption before storing provider keys.',503);
      const audit=async(outcome:AuditOutcome)=>{await db.prepare('INSERT INTO company_ai_model_audit(id,request_id,organization_id,actor_user_id,action,revision,outcome,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .bind(crypto.randomUUID(),c.get('requestId'),actor.orgId,actor.actorUserId,test?'test':'save',test?expectedVersion:expectedVersion+1,outcome,Date.now()).run();};
      if(test){
        if(!current)return missing();
        const result=await auditedChange(audit,async()=>{
          const attemptId=crypto.randomUUID();
          if(!await claimModelTest(db,actor,current.revision,attemptId)){
            if(!await manager(db,actor))return missing();
            return conflict();
          }
          if(!await manager(db,actor))return missing();
          if((await readCompanyModel(db,actor.orgId))?.revision!==current.revision)return conflict();
          const diagnostic=await probeCompanyModel(c.env,current,deps.modelFetch??fetch,c.req.raw.signal,async()=>!!await manager(db,actor)&&(await readCompanyModel(db,actor.orgId))?.revision===current.revision);
          // Persist only sanitized enums/status, never raw provider bodies, keys or prompts.
          await db.prepare('UPDATE company_ai_model_test SET status=?,failure_code=?,provider_status=?,tested_at=? WHERE organization_id=? AND attempt_id=?').bind(diagnostic.status,diagnostic.failureCode,diagnostic.providerStatus,Date.now(),actor.orgId,attemptId).run();
          if(!await manager(db,actor))return missing();
          if((await readCompanyModel(db,actor.orgId))?.revision!==current.revision)return conflict();
          return jsonResponse(c,await view(c.env,actor.orgId));
        });
        return result.auditComplete?result.response:apiError(c,'OPERATION_UNCONFIRMED','Read the saved configuration and original test status before continuing.',503);
      }
      const command=v.parse(companyModelCommandSchema,body),provider=command.provider??'custom',authType=command.authType??'api_key';
      let baseUrl:string|null,api='openai-completions',secret:ModelSecret;
      if(authType==='oauth'){
        if(provider!=='kimi-coding')return apiError(c,'MODEL_PROVIDER_UNSUPPORTED','This provider does not have an OAuth login flow yet.',400);
        const resolved=resolveProviderModel(provider,command.model);
        if(!resolved)return apiError(c,'MODEL_PROVIDER_UNSUPPORTED','Choose a model that the selected provider offers for OAuth.',400);
        api=resolved.model.api;baseUrl=modelBaseUrl(resolved.model.baseUrl,c.env);
        if(!baseUrl)return apiError(c,'MODEL_URL_REJECTED','Use an approved HTTPS Base URL. Custom gateway hosts require AI_MODEL_ALLOWED_HOSTS at deployment.',400);
        const credential=await readCompanyCredential(db,actor.orgId,provider);
        if(!credential)return apiError(c,'OAUTH_LOGIN_REQUIRED','Sign in to the provider before saving this model.',400);
        secret=credential;
      }else{
        if(provider==='custom'){
          if(!command.baseUrl)return apiError(c,'INVALID_REQUEST','Provide a Base URL for a custom provider.',400);
          baseUrl=modelBaseUrl(command.baseUrl,c.env);
        }else{
          const resolved=resolveProviderModel(provider,command.model);
          if(!resolved)return apiError(c,'MODEL_PROVIDER_UNSUPPORTED','Choose a model that the selected provider offers for OpenAI Chat Completions.',400);
          api=resolved.model.api;baseUrl=modelBaseUrl(resolved.model.baseUrl,c.env);
        }
        if(!baseUrl)return apiError(c,'MODEL_URL_REJECTED','Use an approved HTTPS Base URL. Custom gateway hosts require AI_MODEL_ALLOWED_HOSTS at deployment.',400);
        let key=command.apiKey;
        if(!key){
          if(!current)return apiError(c,'MODEL_KEY_REQUIRED','Provide an API key for the first connection.',400);
          if(new URL(current.baseUrl).origin!==new URL(baseUrl).origin)return apiError(c,'MODEL_KEY_REQUIRED','Re-enter the provider key when changing its host.',400);
          try{key=await openModelKey(c.env,actor.orgId,current.revision,current.baseUrl,current.model,current);}catch{return apiError(c,'CREDENTIALS_UNAVAILABLE','The saved provider key cannot be opened.',503);}
        }
        secret=await sealModelKey(c.env,actor.orgId,expectedVersion+1,baseUrl,command.model,key);
      }
      if(!baseUrl)return apiError(c,'MODEL_URL_REJECTED','Use an approved HTTPS Base URL. Custom gateway hosts require AI_MODEL_ALLOWED_HOSTS at deployment.',400);
      const result=await auditedChange(audit,async()=>{
        const saved=await insertCompanyModel(db,actor,expectedVersion,provider,api,baseUrl,command.model,secret,command.execution,authType);
        if(!await manager(db,actor))return missing();
        if(!saved)return conflict();
        const latest=await view(c.env,actor.orgId);if(latest.version!==saved.revision)return conflict();
        return jsonResponse(c,latest);
      });
      return result.auditComplete?result.response:apiError(c,'OPERATION_UNCONFIRMED','Read the saved configuration before submitting another change.',503);
    });
  }
}
