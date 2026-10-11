import type { TranslationConfig,TranslationRun } from './types.ts';
export const PREVIEW_MODEL='nvidia/nemotron-3-super-120b-a12b';
export const PREVIEW_PROMPT_VERSION='ru-translation-v1';
export const PREVIEW_MODEL_VERSION='nvidia-nemotron-super-v1';
export const previewInstance=(runId:string)=>`reply-preview:${runId}`;
export function validatePreviewConfig(c:TranslationConfig,contextWindow:number){
  if(c.provider!=='nvidia'||c.model!==PREVIEW_MODEL||c.promptVersion!==PREVIEW_PROMPT_VERSION||c.modelConfigVersion!==PREVIEW_MODEL_VERSION
    ||c.maxInputTokens<contextWindow||c.maxOutputTokens<1||c.maxOutputTokens>512)throw new Error('PREVIEW_CONFIG_UNSUPPORTED');
}
export function validatePreviewRun(run:TranslationRun,contextWindow:number){validatePreviewConfig(run.config,contextWindow);}
