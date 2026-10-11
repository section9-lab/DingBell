import {nvidiaProvider} from '@earendil-works/pi-ai/providers/nvidia';
import {freezeAiConfig} from './storage.ts';
import {SUPPORT_MODEL,validateSupportModel} from './policy.ts';
import type {SupportBindings} from './execution.ts';
import type {AiBudgetWorkspace} from '../../shared/ai-budget.ts';

const model=nvidiaProvider().getModels().find(m=>m.id===SUPPORT_MODEL);
export function parseSupportConfiguration(value:unknown){
 if(!model||model.baseUrl!=='https://integrate.api.nvidia.com/v1')throw new Error('SUPPORT_MODEL_UNAVAILABLE');
 const cost=freezeAiConfig(value);validateSupportModel(cost.config.model,model.contextWindow);return cost;
}
/** Deployment metadata only: inspecting configuration grants no execution or spending permission. */
export function supportConfigurationView(env:SupportBindings):AiBudgetWorkspace['configuration']{
 const base={enabled:env.AI_RECEPTION_ENABLED==='true',modelConfigured:!!env.NVAPI_KEY?.trim()&&!!env.FLUE_SUPPORT_AGENT&&!!env.CONVERSATION_CONTROLLER};
 try{
  const raw=env.AI_RECEPTION_CONFIG_JSON;if(!raw||raw.length>32768)throw new Error('SUPPORT_CONFIG_MISSING');
  const cost=parseSupportConfiguration(JSON.parse(raw)),enabled=base.enabled&&(cost.config.model.promptVersion!=='support-reply-v1'||env.AI_OUTBOUND_ENABLED==='true'&&env.OUTBOUND_ENABLED==='true');
  return {...base,enabled,pricesConfigured:true,model:cost.config.model.model,maxGenerations:cost.config.maxGenerations,perGenerationMicros:cost.per,runReservationMicros:cost.total};
 }catch{return {...base,pricesConfigured:false,model:null,maxGenerations:null,perGenerationMicros:null,runReservationMicros:null};}
}
