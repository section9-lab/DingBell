import { wakeStoreSync, type SyncBindings } from './modules/sync/bindings.ts';
import { listDueSyncStores } from './modules/sync/storage.ts';
import { getConversationController, type ControlBindings } from './modules/conversations/control-bindings.ts';
import { deferControlRepair, listDueControlDirectories } from './modules/conversations/control-storage.ts';
import type { ControlScope } from './modules/conversations/control-types.ts';
import type { KnowledgeBindings } from './modules/knowledge/bindings.ts';
import { repairKnowledgeIndexes } from './modules/knowledge/index-dispatch.ts';
import { repairKnowledgeReviews } from './modules/knowledge/review-dispatch.ts';
import type { SupportBindings } from './modules/ai-runs/execution.ts';
import { repairAiExecutions } from './modules/ai-runs/repair.ts';
import { deliverInboundEvents } from './modules/conversations/inbound-delivery.ts';
import { dispatchAiReceptions } from './modules/ai-runs/dispatch.ts';
import type {TranslationBindings} from './modules/translations/bindings.ts';
import type {ReplyTestBindings} from './modules/reply-tests/execution.ts';
import {repairFinancialUsage} from './modules/usage-repair.ts';
import {repairKnowledgeVectorCleanups} from './modules/knowledge/vector-cleanup.ts';
import {reconcileBudgetLedgers} from './modules/budget-audit/reconciliation.ts';

export { StoreCoordinator } from './modules/sync/coordinator.ts';
export { ConversationController } from './modules/conversations/controller.ts';
export { KnowledgeIndexWorkflow } from './modules/knowledge/index-workflow.ts';
export { KnowledgeReviewWorkflow } from './modules/knowledge/review-workflow.ts';

type Bindings=SyncBindings&ControlBindings&KnowledgeBindings&SupportBindings&TranslationBindings&ReplyTestBindings;
async function wakeStores(env:Bindings) {
  if(!env.DB||!env.STORE_COORDINATOR)return;
  const stores=await listDueSyncStores(env.DB,50);
  for(let index=0;index<stores.length;index+=5)
    await Promise.allSettled(stores.slice(index,index+5).map(scope=>wakeStoreSync(env,scope)));
}
async function repairOne(env:Bindings,scope:ControlScope) {
  // Move each selected directory behind other due work before potentially failing RPC.
  await deferControlRepair(env.DB!,scope,Date.now()+60_000);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    await Promise.race([getConversationController(env,scope.controllerId).repair(scope),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('CONTROL_REPAIR_TIMEOUT')),3_000);})]);
  } finally {clearTimeout(timer);}
}
async function repairControls(env:Bindings) {
  if(!env.DB||!env.CONVERSATION_CONTROLLER)return;
  const scopes=await listDueControlDirectories(env.DB,Date.now(),50);
  for(let index=0;index<scopes.length;index+=5)
    await Promise.allSettled(scopes.slice(index,index+5).map(scope=>repairOne(env,scope)));
}

export default {
  async scheduled(_controller:ScheduledController,env:Bindings) {
    const reception=async()=>{try{await deliverInboundEvents(env);}finally{await dispatchAiReceptions(env);}};
    await Promise.allSettled([wakeStores(env),reception(),repairControls(env),repairKnowledgeIndexes(env),repairKnowledgeReviews(env),repairKnowledgeVectorCleanups(env),repairAiExecutions(env),repairFinancialUsage(env),reconcileBudgetLedgers(env)]);
  },
} satisfies ExportedHandler<Bindings>;
