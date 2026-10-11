import type {Agent} from 'agents';
import type {ControlScope} from '../conversations/control-types.ts';
import {getConversationController,type ControlBindings} from '../conversations/control-bindings.ts';
import type {TranslationReceipt} from '../translations/types.ts';
import {readAiExecution,reserveAiExecution,bindAiExecutionReceipt,settleAiGeneration,freezeAiConfig,type AiExecution,type AiRunReader} from './storage.ts';
import {selectAiBudget} from './budget.ts';
import type {SupportInspection} from './ledger.ts';
import type {AiKnowledgeBindings} from './knowledge.ts';
export interface SupportBindings extends ControlBindings,AiKnowledgeBindings {NVAPI_KEY?:string;AI_RECEPTION_CONFIG_JSON?:string;FLUE_SUPPORT_AGENT?:DurableObjectNamespace<Agent>}
export interface SupportRuntime {
 lookup(run:AiExecution):Promise<{uid?:string}|null>;prepare(run:AiExecution):Promise<void>;inspect(run:AiExecution):Promise<SupportInspection|null>;
 dispatch(run:AiExecution):Promise<TranslationReceipt>;read(run:AiExecution):Promise<'completed'|'failed'|'aborted'|'pending'>;close(run:AiExecution):Promise<void>;
 recover(run:AiExecution):Promise<TranslationReceipt>;cancel(run:AiExecution):Promise<void>;abort(run:AiExecution):Promise<void>;
}
export const aiRunReader=(env:ControlBindings):AiRunReader=>(scope,id)=>getConversationController(env,scope.controllerId).readAiWork(scope,id);
export function matchingSupport(state:SupportInspection,run:AiExecution){
 return state.run.id===run.id&&state.run.budgetId===run.budgetId&&state.run.instanceId===run.instanceId&&state.run.dispatchKey===run.dispatchKey
  &&JSON.stringify(state.run.payload)===JSON.stringify(run.payload)&&JSON.stringify(state.run.config)===JSON.stringify(run.config)
  &&state.run.reservedMicros===run.reservedMicros&&state.run.perGenerationMicros===run.perGenerationMicros&&state.run.createdAt===run.createdAt;
}
type Dependencies={runtime?:SupportRuntime};
type Status='unavailable'|'unconfirmed'|'pending'|'completed'|'failed'|'aborted'|'closed';
const view=(status:Status)=>({status,canSend:false as const});
async function native(env:SupportBindings,deps:Dependencies){return deps.runtime??(await import('./runtime.ts')).createSupportRuntime(env);}
async function observe(env:SupportBindings,run:AiExecution,runtime:SupportRuntime){
 if(!run.receipt)return view(run.closure?'closed':'unconfirmed');
 try{
  if((await runtime.lookup(run))?.uid!==run.receipt.uid)return view('unconfirmed');
  const status=await runtime.read(run),state=await runtime.inspect(run);
  if(!state||!matchingSupport(state,run)||JSON.stringify(state.receipt)!==JSON.stringify(run.receipt)||(await runtime.lookup(run))?.uid!==run.receipt.uid)return view('unconfirmed');
  for(const g of state.generations)if(g.evidence?.complete&&g.evidence.usageReported&&g.evidence.usage)
   await settleAiGeneration(env.DB!,run.payload.run.scope,run.id,g.sequence,run.receipt,g.evidence.usage);
  if(status!=='pending'&&!run.closure)await runtime.close(run);
  return view(status);
 }catch{return view('unconfirmed');}
}
/** Internal orchestration only; no user/session impersonation or public native Agent endpoint. */
export async function executeAiRun(env:SupportBindings,scope:ControlScope,id:string,deps:Dependencies={}){
 if(!env.DB)return view('unavailable');let run=await readAiExecution(env.DB,scope,id);
 if(!run){
  if(env.AI_RECEPTION_ENABLED!=='true'||!env.NVAPI_KEY?.trim()||!env.FLUE_SUPPORT_AGENT||!env.CONVERSATION_CONTROLLER)return view('unavailable');
  let cost;
  try{
   const raw=env.AI_RECEPTION_CONFIG_JSON;if(!raw||raw.length>32768)return view('unavailable');
   cost=(await import('./configuration.ts')).parseSupportConfiguration(JSON.parse(raw));
  }catch{return view('unavailable');}
  if(cost.config.model.promptVersion==='support-reply-v1'&&(env.AI_OUTBOUND_ENABLED!=='true'||env.OUTBOUND_ENABLED!=='true'))return view('unavailable');
  const work=await aiRunReader(env)(scope,id);if(!work)return view('unavailable');
  if(work.schemaVersion===2)cost=freezeAiConfig({maxGenerations:1,model:{...cost.config.model,promptVersion:'intake-v1'}});
  const budget=await selectAiBudget(env.DB,scope,cost.total);if(!budget)return view('unavailable');
  const reserved=await reserveAiExecution(env.DB,aiRunReader(env),scope,id,budget,cost.config);
  if(!reserved.run)return view('unavailable');run=reserved.run;
 }
 if(run.config.model.promptVersion==='support-reply-v1'&&(env.AI_RECEPTION_ENABLED!=='true'||env.AI_OUTBOUND_ENABLED!=='true'||env.OUTBOUND_ENABLED!=='true'))return view('unavailable');
 const runtime=await native(env,deps);if(run.receipt||run.closure)return observe(env,run,runtime);
 try{
  const instance=await runtime.lookup(run),state=await runtime.inspect(run);
  if(state){
   if(!matchingSupport(state,run))return view('unconfirmed');
   if(state.cancellation&&!state.closed)return view('unconfirmed');
   if(state.closed){await runtime.close(run);return view('closed');}
   if(!instance&&(state.receipt||state.generations.length))return view('unconfirmed');
  }else{
   if(instance||run.generations.length)return view('unconfirmed');
   if(env.AI_RECEPTION_ENABLED!=='true')return view('unavailable');await runtime.prepare(run);
  }
  if(!instance&&env.AI_RECEPTION_ENABLED!=='true')return view('unavailable');
  const receipt=await runtime.dispatch(run);await bindAiExecutionReceipt(env.DB,scope,id,receipt);
 }catch{return view('unconfirmed');}
 return observe(env,(await readAiExecution(env.DB,scope,id))!,runtime);
}
export async function readExecutedAiRun(env:SupportBindings,scope:ControlScope,id:string,deps:Dependencies={}){
 if(!env.DB)return view('unavailable');const run=await readAiExecution(env.DB,scope,id);if(!run)return view('unavailable');return observe(env,run,await native(env,deps));
}
/** Reconciles the original execution even after the conversation moves to another run. */
export async function reconcileAiExecution(env:SupportBindings,scope:ControlScope,id:string,deps:Dependencies={}){
 if(!env.DB||!env.CONVERSATION_CONTROLLER||(!deps.runtime&&!env.FLUE_SUPPORT_AGENT))return view('unavailable');
 try{
  let run=await readAiExecution(env.DB,scope,id);if(!run)return view('unavailable');
  if(run.closure&&run.status==='settled')return view(run.closure.kind==='runtime_closed'?run.closure.outcome:'closed');
  const runtime=await native(env,deps);
  if(run.closure)return observe(env,run,runtime);
  const prior=await runtime.inspect(run);if(prior&&!matchingSupport(prior,run))return view('unconfirmed');
  if(!prior?.cancellation){
   const authorized=await aiRunReader(env)(scope,id);
   if(authorized&&JSON.stringify(authorized)===JSON.stringify(run.payload.run))return observe(env,run,runtime);
  }
  await runtime.cancel(run);
  const state=await runtime.inspect(run),instance=await runtime.lookup(run);
  if(!state||!matchingSupport(state,run)||!state.cancellation)return view('unconfirmed');
  if(!run.receipt){
   if(!instance){if(state.receipt||state.generations.length||run.generations.length)return view('unconfirmed');await runtime.close(run);return view('closed');}
   const receipt=state.receipt??await runtime.recover(run);
   if(receipt.uid!==instance.uid)return view('unconfirmed');await bindAiExecutionReceipt(env.DB,scope,id,receipt);
   run=(await readAiExecution(env.DB,scope,id))!;
  }
  if(instance?.uid!==run.receipt?.uid)return view('unconfirmed');
  if(await runtime.read(run)==='pending')await runtime.abort(run);
  return observe(env,run,runtime);
 }catch{return view('unconfirmed');}
}
/** Prompt wake after a human command. Historical executions have their own repair cursor. */
export async function reconcileConversationAi(env:SupportBindings,scope:ControlScope,deps:Dependencies={}){
 if(!env.DB||!env.CONVERSATION_CONTROLLER||(!deps.runtime&&!env.FLUE_SUPPORT_AGENT))return view('unavailable');
 try{const id=await getConversationController(env,scope.controllerId).readAiRunTarget(scope);return id?reconcileAiExecution(env,scope,id,deps):view('unavailable');}catch{return view('unconfirmed');}
}
