import type { TranslationConfig } from './types.ts';
import { nvidiaProvider } from '@earendil-works/pi-ai/providers/nvidia';
import { freezeTranslationConfig } from './config.ts';
import { PREVIEW_MODEL,validatePreviewConfig } from './policy.ts';

export interface TranslationDeploymentEnv { TRANSLATION_ENABLED?:string;TRANSLATION_CONFIG_JSON?:string }
const model=nvidiaProvider().getModels().find(value=>value.id===PREVIEW_MODEL);
export function readTranslationDeploymentConfig(env:TranslationDeploymentEnv):TranslationConfig|null{
  if(env.TRANSLATION_ENABLED!=='true'||!env.TRANSLATION_CONFIG_JSON||!model)return null;
  try{
    const config=freezeTranslationConfig(JSON.parse(env.TRANSLATION_CONFIG_JSON));
    validatePreviewConfig(config,model.contextWindow);return config;
  }catch{return null;}
}
