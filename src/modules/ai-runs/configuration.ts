import {nvidiaProvider} from '@earendil-works/pi-ai/providers/nvidia';
import {freezeAiConfig} from './storage.ts';
import {SUPPORT_BASE_URL,SUPPORT_MODEL_TEMPLATE_ID,validateSupportModel} from './policy.ts';
import type {SupportBindings} from './execution.ts';
import type {AiBudgetWorkspace} from '../../shared/ai-budget.ts';
import {isOutboundPromptVersion} from '../../shared/ai-versions.ts';

const model=nvidiaProvider().getModels().find(m=>m.id===SUPPORT_MODEL_TEMPLATE_ID);
export function parseSupportConfiguration(value:unknown){
 if(!model||model.baseUrl!==SUPPORT_BASE_URL)throw new Error('SUPPORT_MODEL_UNAVAILABLE');
 const cost=freezeAiConfig(value);validateSupportModel(cost.config.model,model.contextWindow);return cost;
}
/** Deployment metadata only: inspecting configuration grants no execution or spending permission. */
export function supportConfigurationView(env:SupportBindings):AiBudgetWorkspace['configuration']{
 const base={modelConfigured:!!env.NVAPI_KEY?.trim()&&!(!env.FLUE_SUPPORT_AGENT&&!env.AGENT_RUNTIME)&&!!env.CONVERSATION_CONTROLLER};
 try{
  const raw=env.AI_RECEPTION_CONFIG_JSON;if(!raw||raw.length>32768)throw new Error('SUPPORT_CONFIG_MISSING');
  const cost=parseSupportConfiguration(JSON.parse(raw)),enabled=base.modelConfigured&&(!isOutboundPromptVersion(cost.config.model.promptVersion)||env.AI_OUTBOUND_ENABLED==='true'&&env.OUTBOUND_ENABLED==='true');
  return {...base,enabled,pricesConfigured:true,model:cost.config.model.model,maxGenerations:cost.config.maxGenerations,perGenerationMicros:cost.per,runReservationMicros:cost.total};
 }catch{return {...base,enabled:false,pricesConfigured:false,model:null,maxGenerations:null,perGenerationMicros:null,runReservationMicros:null};}
}
