import type { StoreActor } from '../stores/storage.ts';

export type TranslationActor = StoreActor;
export interface TranslationScope { organizationId:string;storeId:string;conversationId:string }
export interface TranslationConfig {
  provider:'nvidia';model:string;modelConfigVersion:string;promptVersion:string;
  // Conservative total of input + cacheRead + cacheWrite; not an SDK input limit.
  maxInputTokens:number;maxOutputTokens:number;
  pricing:{version:string;currency:'USD';inputMicrosPerMillion:number;outputMicrosPerMillion:number;cacheReadMicrosPerMillion:number;cacheWriteMicrosPerMillion:number};
}
export interface TranslationUsage {input:number;output:number;cacheRead:number;cacheWrite:number}
export interface TranslationReceipt {submissionId:string;uid:string;acceptedAt:string}
export interface TranslationOutput {runId:string;body:string;bodyHash:string;receipt:TranslationReceipt;recordedAt:number}
export interface TranslationBudget {
  id:string;organizationId:string;startsAt:number;endsAt:number;enabled:boolean;revision:number;
  limitMicros:number;reservedMicros:number;spentMicros:number;
}
export interface TranslationInput {
  requestId:string;storeId:string;conversationId:string;expectedMemberId:string;
  source:string;sourceRevision:number;budgetId:string;
}
export interface TranslationRun extends TranslationScope {
  id:string;requestId:string;actorUserId:string;actorMemberId:string;source:string;sourceHash:string;sourceRevision:number;
  budgetId:string;config:TranslationConfig;reservedMicros:number;createdAt:number;
  // Observation only; a saved marker never grants a retry of the provider request.
  providerRequestClaimedAt:number|null;
  receipt:TranslationReceipt|null;settlement:'held'|'settled'|'released';usage:TranslationUsage|null;
  chargedMicros:number|null;settledAt:number|null;releaseEvidence:UnstartedTranslationEvidence|null;
}
export interface UnstartedTranslationEvidence {
  kind:'execution_closed_without_provider_request';evidenceId:string;instanceId:string;
  verifiedAt:number;providerRequests:0;executionClosed:true;
}
export type TranslationReservation = {outcome:'reserved'|'existing';run:TranslationRun}
  |{outcome:'not_found'|'conflict'|'budget_unavailable'|'pricing_unavailable'};
