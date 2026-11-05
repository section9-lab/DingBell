import * as v from 'valibot';
import { companyModelViewSchema,companyModelCatalogSchema,type CompanyModelCommand,type CompanyModelCatalogCommand } from '../../shared/company-model.ts';
import { request,ApiError } from './api.ts';
const path=(companyId:string)=>`/api/companies/${encodeURIComponent(companyId)}/settings/ai-model`;
const schema=(companyId:string)=>v.pipe(companyModelViewSchema,v.check(data=>data.companyId===companyId));
export function readCompanyModel(companyId:string,signal?:AbortSignal){return request(path(companyId),schema(companyId),{signal});}
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
