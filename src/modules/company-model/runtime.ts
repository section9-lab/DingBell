import type { SupportBindings } from '../ai-runs/execution.ts';
import { parseSupportConfiguration, supportConfigurationView } from '../ai-runs/configuration.ts';
import { readCompanyModel } from './storage.ts';
import { modelExecutionSchema, defaultModelGenerations } from '../../shared/company-model.ts';
import { credentialConfig } from '../stores/credentials.ts';
import { modelBaseUrl, modelEndpoint, openModelKey } from './security.ts';
import type { TranslationConfig } from '../translations/types.ts';
import * as v from 'valibot';

// A saved company connection overrides deployment defaults. Missing reviewed execution
// parameters are unavailable, not a zero-price substitute or another provider's configuration.
export async function resolveSupportConfiguration(env:SupportBindings,companyId:string){
  const row=env.DB?await readCompanyModel(env.DB,companyId):null;
  if(!row){
    try{return env.NVAPI_KEY?.trim()&&env.AI_RECEPTION_CONFIG_JSON&&env.AI_RECEPTION_CONFIG_JSON.length<=32768?parseSupportConfiguration(JSON.parse(env.AI_RECEPTION_CONFIG_JSON)):null;}catch{return null;}
  }
  if(!env.AGENT_RUNTIME||!credentialConfig(env)||modelBaseUrl(row.baseUrl,env)!==row.baseUrl)return null;
  try{
    if(!row.execution)return null;
    const execution=v.parse(modelExecutionSchema,JSON.parse(row.execution));
    const promptVersion=execution.autoReply?'support-reply-v1':'support-knowledge-v1';
    const maxGenerations=execution.maxGenerations??defaultModelGenerations;
    return parseSupportConfiguration({maxGenerations,model:{provider:'openai-compatible',model:row.model,modelConfigVersion:'company-model-v1',promptVersion,
      connection:{companyId,revision:row.revision,baseUrl:row.baseUrl},maxInputTokens:execution.maxInputTokens,maxOutputTokens:execution.maxOutputTokens,
      pricing:{version:`company-model-${row.revision}`,currency:'USD',inputMicrosPerMillion:execution.inputMicrosPerMillion,outputMicrosPerMillion:execution.outputMicrosPerMillion,
        cacheReadMicrosPerMillion:execution.cacheReadMicrosPerMillion,cacheWriteMicrosPerMillion:execution.cacheWriteMicrosPerMillion}}});
  }catch{return null;}
}
export async function companySupportConfigurationView(env:SupportBindings,companyId:string){
  const row=env.DB?await readCompanyModel(env.DB,companyId):null;
  if(!row)return supportConfigurationView(env);
  const cost=await resolveSupportConfiguration(env,companyId);
  const modelConfigured=!!env.AGENT_RUNTIME&&!!env.CONVERSATION_CONTROLLER&&!!credentialConfig(env)&&modelBaseUrl(row.baseUrl,env)===row.baseUrl;
  const enabled=modelConfigured&&!!cost&&(cost.config.model.promptVersion!=='support-reply-v1'||env.AI_OUTBOUND_ENABLED==='true'&&env.OUTBOUND_ENABLED==='true');
  return {enabled,modelConfigured,pricesConfigured:!!cost,model:cost?row.model:null,maxGenerations:cost?.config.maxGenerations??null,perGenerationMicros:cost?.per??null,runReservationMicros:cost?.total??null};
}
export async function frozenCompanyProvider(env:SupportBindings,config:TranslationConfig,companyId:string){
  const connection=config.connection;
  if(config.provider!=='openai-compatible'||!connection||connection.companyId!==companyId||!env.DB||modelBaseUrl(connection.baseUrl,env)!==connection.baseUrl)throw new Error('MODEL_CONNECTION_UNAVAILABLE');
  const row=await readCompanyModel(env.DB,companyId,connection.revision);
  if(!row||row.baseUrl!==connection.baseUrl||row.model!==config.model)throw new Error('MODEL_CONNECTION_UNAVAILABLE');
  return {endpoint:modelEndpoint(row.baseUrl),apiKey:await openModelKey(env,companyId,row.revision,row.baseUrl,row.model,row)};
}
