import type { Model } from '@earendil-works/pi-ai';
/** Existing immutable business configurations keep their model identity across the SDK migration.
 * Availability is a separate provider acceptance check; never substitute a newer model silently.
 */
export const legacyNemotron: Model<'openai-completions'> = {
  id:'nvidia/nemotron-3-super-120b-a12b', name:'Nemotron 3 Super', api:'openai-completions', provider:'nvidia',
  baseUrl:'https://integrate.api.nvidia.com/v1', headers:{'NVCF-POLL-SECONDS':'3600'}, reasoning:true, input:['text'],
  cost:{input:0.2,output:0.8,cacheRead:0,cacheWrite:0}, contextWindow:262144,maxTokens:262144,
  compat:{supportsStore:false,supportsDeveloperRole:false,supportsReasoningEffort:false,maxTokensField:'max_tokens',supportsLongCacheRetention:false,supportsStrictMode:false},
};
