import type { SyncBindings } from './modules/sync/bindings.ts';
import { getConversationController, type ControlBindings } from './modules/conversations/control-bindings.ts';
import { deferControlRepair, listDueControlDirectories } from './modules/conversations/control-storage.ts';
import type { ControlScope } from './modules/conversations/control-types.ts';
import type { SupportBindings } from './modules/ai-runs/execution.ts';
import { repairAiExecutions } from './modules/ai-runs/repair.ts';
import { deliverInboundEvents } from './modules/conversations/inbound-delivery.ts';
import { dispatchAiReceptions } from './modules/ai-runs/dispatch.ts';
import {reconcileBudgetLedgers} from './modules/budget-audit/reconciliation.ts';
import {runStartupBootstrap} from './modules/sync/bootstrap.ts';
import {listStoresAwaitingDiscovery} from './modules/sync/storage.ts';
import {wakeStoreSync} from './modules/sync/bindings.ts';


type Bindings=SyncBindings&ControlBindings&SupportBindings;
async function repairOne(env:Bindings,scope:ControlScope) {
  // Move each selected directory behind other due work before potentially failing RPC.
  await deferControlRepair(env.DB!,scope,Date.now()+60_000);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    await Promise.race([getConversationController(env,scope.controllerId).repair(scope),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('CONTROL_REPAIR_TIMEOUT')),3_000);})]);
  } finally {clearTimeout(timer);}
}
/**
 * Keep discovery running for stores without a Push cutover. Configured Push stores are skipped
 * here and the coordinator also refuses to poll once an endpoint cuts over.
 */
async function wakePollingStores(env:Bindings) {
  if(!env.DB||!env.STORE_COORDINATOR)return;
  const stores=(await listStoresAwaitingDiscovery(env.DB,50)).results;
  for(let index=0;index<stores.length;index+=5)
    await Promise.allSettled(stores.slice(index,index+5).map(scope=>wakeStoreSync(env,scope)));
}
async function repairControls(env:Bindings) {
  if(!env.DB||!env.CONVERSATION_CONTROLLER)return;
  const scopes=await listDueControlDirectories(env.DB,Date.now(),50);
  for(let index=0;index<scopes.length;index+=5)
    await Promise.allSettled(scopes.slice(index,index+5).map(scope=>repairOne(env,scope)));
}

export async function runScheduled(env:Bindings) {
    const reception=async()=>{try{await deliverInboundEvents(env);}finally{await dispatchAiReceptions(env);}};
    // One-time startup bootstrap starts the initial full read; after that, Ozon data is webhook-only.
    const bootstrap=async()=>{try{await runStartupBootstrap(env);}catch{/* The durable marker retries on the next tick. */}};
    await Promise.allSettled([bootstrap(),reception(),wakePollingStores(env),repairControls(env),repairAiExecutions(env),reconcileBudgetLedgers(env)]);
}
