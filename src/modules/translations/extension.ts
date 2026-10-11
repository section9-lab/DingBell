import { extend } from '@flue/runtime/cloudflare';
import type { Agent } from 'agents';
import type { TranslationScope } from './types.ts';
import { PreviewLedger } from './ledger.ts';
import { readTranslationExecutionContext,releaseUnstartedTranslation } from './storage.ts';
import { previewInstance,validatePreviewRun } from './policy.ts';
import { previewModel } from './provider.ts';
export const previewExtension=extend<Agent>({base:Base=>class extends Base {
  #context:DurableObjectState;#bindings:Record<string,unknown>;
  constructor(...args:ConstructorParameters<typeof Base>){super(...args);this.#context=args[0];this.#bindings=args[1];}
  private identity(runId:string){
    const namespace=this.#bindings.FLUE_REPLY_PREVIEW_AGENT as DurableObjectNamespace|undefined;
    if(!namespace||namespace.idFromName(previewInstance(runId)).toString()!==this.#context.id.toString())throw new Error('PREVIEW_SCOPE_MISMATCH');
  }
  async preparePreview(scope:TranslationScope,runId:string):Promise<void>{
    this.identity(runId);
    if(this.#bindings.TRANSLATION_ENABLED!=='true'||!this.#bindings.DB)throw new Error('PREVIEW_DISABLED');
    const run=await readTranslationExecutionContext(this.#bindings.DB as D1Database,scope,runId);if(!run)throw new Error('PREVIEW_UNAVAILABLE');
    validatePreviewRun(run,previewModel!.contextWindow);new PreviewLedger(this.#context.storage.sql).prepare(run);
  }
  async inspectPreview(){return new PreviewLedger(this.#context.storage.sql).inspect();}
  async closeUnstartedPreview(scope:TranslationScope,runId:string):Promise<void>{
    this.identity(runId);const ledger=new PreviewLedger(this.#context.storage.sql),state=ledger.inspect();
    if(!state||state.run.id!==runId||state.run.organizationId!==scope.organizationId||state.run.storeId!==scope.storeId||state.run.conversationId!==scope.conversationId||!this.#bindings.DB)throw new Error('PREVIEW_SCOPE_MISMATCH');
    await releaseUnstartedTranslation(this.#bindings.DB as D1Database,scope,runId,ledger.close());
  }
}});
