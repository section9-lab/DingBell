import type { SupportBindings } from '../ai-runs/execution.ts';
import { parseSupportConfiguration, supportConfigurationView } from '../ai-runs/configuration.ts';
import { readCompanyModel } from './storage.ts';
import { modelExecutionSchema, defaultModelGenerations } from '../../shared/company-model.ts';
import { SUPPORT_REPLY_V2, isOutboundPromptVersion } from '../../shared/ai-versions.ts';
import { credentialConfig } from '../stores/credentials.ts';
import { modelBaseUrl, modelEndpoint } from './security.ts';
import { modelAccessToken } from './oauth.ts';
import { providerRequestHeaders } from './providers.ts';
import type { AiModelConfig } from '../ai-runs/finance.ts';
import * as v from 'valibot';

// A saved company connection overrides deployment defaults. A connection without reviewed
// execution parameters runs with the default token envelope and zero recorded cost, so AI
// reception never depends on maintaining prices or usage limits first.
const defaultExecution={
  maxInputTokens:131072,maxOutputTokens:2048,maxGenerations:defaultModelGenerations,
  inputMicrosPerMillion:0,outputMicrosPerMillion:0,cacheReadMicrosPerMillion:0,cacheWriteMicrosPerMillion:0,
} as const;
export async function resolveSupportConfiguration(env:SupportBindings,companyId:string){
  const row=env.DB?await readCompanyModel(env.DB,companyId):null;
  if(!row){
    try{return env.NVAPI_KEY?.trim()&&env.AI_RECEPTION_CONFIG_JSON&&env.AI_RECEPTION_CONFIG_JSON.length<=32768?parseSupportConfiguration(JSON.parse(env.AI_RECEPTION_CONFIG_JSON)):null;}catch{return null;}
  }
  if(!env.AGENT_RUNTIME||!credentialConfig(env)||modelBaseUrl(row.baseUrl,env)!==row.baseUrl)return null;
  try{
    const execution=row.execution?v.parse(modelExecutionSchema,JSON.parse(row.execution)):defaultExecution;
    const promptVersion=SUPPORT_REPLY_V2;
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
  const enabled=modelConfigured&&!!cost&&(!isOutboundPromptVersion(cost.config.model.promptVersion)||env.AI_OUTBOUND_ENABLED==='true'&&env.OUTBOUND_ENABLED==='true');
  return {enabled,modelConfigured,pricesConfigured:!!cost,model:cost?row.model:null,maxGenerations:cost?.config.maxGenerations??null,perGenerationMicros:cost?.per??null,runReservationMicros:cost?.total??null};
}
export async function frozenCompanyProvider(env:SupportBindings,config:AiModelConfig,companyId:string,sessionId:string,send:typeof fetch=fetch){
  const connection=config.connection;
  if(config.provider!=='openai-compatible'||!connection||connection.companyId!==companyId||!env.DB||modelBaseUrl(connection.baseUrl,env)!==connection.baseUrl)throw new Error('MODEL_CONNECTION_UNAVAILABLE');
  const row=await readCompanyModel(env.DB,companyId,connection.revision);
  if(!row||row.baseUrl!==connection.baseUrl||row.model!==config.model)throw new Error('MODEL_CONNECTION_UNAVAILABLE');
  return {endpoint:modelEndpoint(row.baseUrl),apiKey:await modelAccessToken(env,row,send),headers:providerRequestHeaders(row.provider,sessionId)};
}
