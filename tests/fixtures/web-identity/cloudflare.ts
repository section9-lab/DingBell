import productionHandlers from '../../../src/cloudflare.ts';
import { StoreCoordinator as ProductionStoreCoordinator } from '../../../src/modules/sync/coordinator.ts';
import { runSyncPage } from '../../../src/modules/sync/runner.ts';
import type { SyncScope } from '../../../src/modules/sync/types.ts';
import { syntheticStoreFetch } from './store-fetch.ts';
import { ConversationController as ProductionConversationController } from '../../../src/modules/conversations/controller.ts';
import { sendOzonMessage } from '../../../src/modules/ozon/send.ts';
export { TestKnowledgeIndexWorkflow as KnowledgeIndexWorkflow, TestKnowledgeReviewWorkflow as KnowledgeReviewWorkflow } from '../knowledge-index-worker.ts';

export class ConversationController extends ProductionConversationController {
  protected override sendReply(credentials: { clientId: string; apiKey: string }, input: { chatId: string; body: string }) {
    return sendOzonMessage(credentials, input, syntheticStoreFetch);
  }
}

export class StoreCoordinator extends ProductionStoreCoordinator {
  protected override async runPage(scope: SyncScope): Promise<void> {
    if (!this.env.DB) throw new Error('Synthetic sync database is unavailable.');
    await runSyncPage({ ...this.env, DB: this.env.DB }, scope, { fetcher: syntheticStoreFetch, reserve: (bucket, now) => this.reserve(bucket, now) });
  }
}
export default productionHandlers;
