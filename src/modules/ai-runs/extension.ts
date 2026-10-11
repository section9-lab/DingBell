import {extend} from '@flue/runtime/cloudflare';
import type {Agent} from 'agents';
import type {ControlScope} from '../conversations/control-types.ts';
import type {TranslationReceipt} from '../translations/types.ts';
import {aiRunReader,matchingSupport,type SupportBindings} from './execution.ts';
import {readAiExecution,closeAiExecution} from './storage.ts';
import {SupportLedger} from './ledger.ts';
import {validateSupportConfig} from './policy.ts';
import {supportModel} from './provider.ts';
export const supportExtension=extend<Agent>({base:Base=>class extends Base {
 #context:DurableObjectState;#env:SupportBindings;
 constructor(...args:ConstructorParameters<typeof Base>){super(...args);this.#context=args[0];this.#env=args[1];}
 private identity(id:string){if(!this.#env.FLUE_SUPPORT_AGENT||this.#env.FLUE_SUPPORT_AGENT.idFromName(`ai-support:${id}`).toString()!==this.#context.id.toString())throw new Error('SUPPORT_SCOPE_MISMATCH');}
 async prepareSupport(scope:ControlScope,id:string){
  this.identity(id);const env=this.#env;if(env.AI_RECEPTION_ENABLED!=='true'||!env.DB)throw new Error('SUPPORT_DISABLED');
  const run=await readAiExecution(env.DB,scope,id);if(!run||run.closure||JSON.stringify(await aiRunReader(env)(scope,id))!==JSON.stringify(run.payload.run))throw new Error('SUPPORT_UNAVAILABLE');
  validateSupportConfig(run,supportModel.contextWindow);new SupportLedger(this.#context.storage.sql).prepare(run);
 }
 async inspectSupport(){return new SupportLedger(this.#context.storage.sql).inspect();}
 async cancelSupport(scope:ControlScope,id:string){
  this.identity(id);const env=this.#env;if(!env.DB)throw new Error('SUPPORT_UNAVAILABLE');
  const run=await readAiExecution(env.DB,scope,id);if(!run)throw new Error('SUPPORT_CANCEL_UNAVAILABLE');
  const ledger=new SupportLedger(this.#context.storage.sql),state=ledger.inspect();
  if(state&&!matchingSupport(state,run))throw new Error('SUPPORT_BINDING_CONFLICT');
  if(!state?.cancellation&&await aiRunReader(env)(scope,id))throw new Error('SUPPORT_CANCEL_UNAVAILABLE');
  // A never-dispatched reservation may be fenced without starting a native submission.
  ledger.prepare(run);if(!matchingSupport(ledger.inspect()!,run))throw new Error('SUPPORT_BINDING_CONFLICT');ledger.cancel();
 }
 async bindSupportReceipt(id:string,receipt:TranslationReceipt){this.identity(id);new SupportLedger(this.#context.storage.sql).bindReceipt(receipt);}
 /** The internal runtime adapter verifies native terminality before this RPC. */
 async closeSupport(scope:ControlScope,id:string,outcome:'completed'|'failed'|'aborted'|null){
  this.identity(id);if(!this.#env.DB)throw new Error('SUPPORT_UNAVAILABLE');
  const ledger=new SupportLedger(this.#context.storage.sql),state=ledger.inspect(),run=await readAiExecution(this.#env.DB,scope,id);
  if(!state||!run||!matchingSupport(state,run)||JSON.stringify(state.receipt)!==JSON.stringify(run.receipt)||(outcome===null)!==(run.receipt===null))throw new Error('SUPPORT_CLOSURE_UNCONFIRMED');
  const marker=ledger.close();const current=await readAiExecution(this.#env.DB,scope,id);if(!current)throw new Error('SUPPORT_UNAVAILABLE');
  if(current.closure)return;
  await closeAiExecution(this.#env.DB,scope,id,outcome===null?{...marker,instanceId:run.instanceId,executionClosed:true,kind:'unstarted_closed',providerPermits:0}:
   {...marker,instanceId:run.instanceId,executionClosed:true,kind:'runtime_closed',providerPermits:current.generations.length,receipt:run.receipt,outcome});
 }
}});
