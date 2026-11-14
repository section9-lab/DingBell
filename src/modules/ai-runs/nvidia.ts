import { nvidiaProvider as official } from '@earendil-works/pi-ai/providers/nvidia';
import type { Model } from '@earendil-works/pi-ai';

/**
 * The immutable model identity kept by existing business configurations.
 * `packages/agent-runtime/model.ts` carries the same record for the portable
 * runtime; this local copy lets the shared business core validate configuration
 * against the same pinned catalog without importing the package runtime.
 */
export const legacyNemotron: Model<'openai-completions'> = {
  id:'nvidia/nemotron-3-super-120b-a12b', name:'Nemotron 3 Super', api:'openai-completions', provider:'nvidia',
  baseUrl:'https://integrate.api.nvidia.com/v1', headers:{'NVCF-POLL-SECONDS':'3600'}, reasoning:true, input:['text'],
  cost:{input:0.2,output:0.8,cacheRead:0,cacheWrite:0}, contextWindow:262144,maxTokens:262144,
  compat:{supportsStore:false,supportsDeveloperRole:false,supportsReasoningEffort:false,maxTokensField:'max_tokens',supportsLongCacheRetention:false,supportsStrictMode:false},
};

/** The official NVIDIA catalog with the retained business model identity added when the SDK no longer lists it. */
export function nvidiaProvider() {
  const base = official();
  return {
    ...base,
    getModels: () => {
      const models = base.getModels();
      return models.some(model => model.id === legacyNemotron.id) ? models : [...models, legacyNemotron];
    },
  };
}
