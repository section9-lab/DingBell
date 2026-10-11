import type { TranslationReceipt,TranslationRun,TranslationScope } from './types.ts';
import type { PreviewEvidence } from './transport.ts';

export interface ReplyPreviewView {
  requestId:string;source:string;sourceRevision:number;targetLanguage:'ru';
  status:'ready'|'pending'|'unconfirmed'|'unavailable';translation:string|null;reason:string|null;
  usageStatus:'held'|'settled'|'released';
}
export type ReplyPreviewResult={outcome:'found';preview:ReplyPreviewView}|{outcome:'not_found'|'conflict'}
  |{outcome:'rejected';code:'TRANSLATION_DISABLED'|'BUDGET_UNAVAILABLE'|'PRICING_UNAVAILABLE'|'RUNTIME_UNAVAILABLE'};
export interface PreviewInspection {run:TranslationRun;generation:number;http:number;closed:boolean;evidence:PreviewEvidence|null}
export interface TranslationRuntime {
  lookup(runId:string):Promise<{uid?:string}|null>;
  inspect(runId:string):Promise<PreviewInspection|null>;
  prepare(scope:TranslationScope,runId:string):Promise<void>;
  dispatch(run:TranslationRun):Promise<TranslationReceipt>;
  read(runId:string,receipt:TranslationReceipt):Promise<{outcome:'completed';text:string;metadata:unknown}|{outcome:'pending'}|{outcome:'failed'}>;
  close(scope:TranslationScope,runId:string):Promise<void>;
}
export interface TranslationServiceDeps {translationRuntime?:TranslationRuntime}
