import * as v from 'valibot';
import { companyModelViewSchema,companyModelCatalogSchema,companyModelProvidersSchema,companyModelOAuthSessionSchema,type CompanyModelCommand,type CompanyModelCatalogCommand,type CompanyModelOAuthStart } from '../../shared/company-model.ts';
import { request,ApiError } from './api.ts';
const path=(companyId:string)=>`/api/companies/${encodeURIComponent(companyId)}/settings/ai-model`;
const schema=(companyId:string)=>v.pipe(companyModelViewSchema,v.check(data=>data.companyId===companyId));
export function readCompanyModel(companyId:string,signal?:AbortSignal){return request(path(companyId),schema(companyId),{signal});}
export function listCompanyModelProviders(companyId:string,signal?:AbortSignal){return request(path(companyId)+'/providers',v.pipe(companyModelProvidersSchema,v.check(data=>data.companyId===companyId)),{signal});}
export function saveCompanyModel(companyId:string,body:CompanyModelCommand){return request(path(companyId),schema(companyId),{method:'POST',body:JSON.stringify(body)});}
export async function listCompanyModels(companyId:string,body:CompanyModelCatalogCommand,signal?:AbortSignal){
  try{return await request(path(companyId)+'/models',v.pipe(companyModelCatalogSchema,v.check(data=>data.companyId===companyId&&data.version===body.expectedVersion&&data.baseUrl===body.baseUrl.replace(/\/$/,''))),{method:'POST',body:JSON.stringify(body),signal});}
  catch(error){
    // This POST only reads a catalog; a lost response never means model settings were saved.
    if(error instanceof ApiError&&error.code==='OPERATION_UNCONFIRMED')throw new ApiError('MODEL_CATALOG_UNAVAILABLE',error.requestId);
    throw error;
  }
}
export function testCompanyModel(companyId:string,expectedVersion:number){return request(path(companyId)+'/test',schema(companyId),{method:'POST',body:JSON.stringify({expectedVersion})});}
export function startCompanyModelOAuth(companyId:string,body:CompanyModelOAuthStart){return request(path(companyId)+'/oauth/start',v.pipe(companyModelOAuthSessionSchema,v.check(data=>data.provider===body.provider)),{method:'POST',body:JSON.stringify(body)});}
export function readCompanyModelOAuth(companyId:string,sessionId:string,signal?:AbortSignal){return request(path(companyId)+'/oauth/'+encodeURIComponent(sessionId),companyModelOAuthSessionSchema,{signal});}
