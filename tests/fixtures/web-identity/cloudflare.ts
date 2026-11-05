import { createWorker, StoreCoordinator as ProductionStoreCoordinator, ConversationController as ProductionConversationController, PiAgentObject as ProductionPiAgentObject } from '../../../src/platform/cloudflare/worker.ts';
import app from './mail-app.ts';
export { FlueReplyPreviewAgent, FlueReplyTestAgent, FlueSupportAgent } from '../../../src/platform/cloudflare/worker.ts';
import { runSyncPage } from '../../../src/modules/sync/runner.ts';
import type { SyncScope } from '../../../src/modules/sync/types.ts';
import { syntheticStoreFetch } from './store-fetch.ts';
import { sendOzonMessage } from '../../../src/modules/ozon/send.ts';

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
// This UI fixture injects synthetic service runtimes. Unexpected model dispatches
// must fail locally instead of sending even synthetic credentials to a real service.
export class PiAgentObject extends ProductionPiAgentObject {
  protected override providerFetch = (async () => { throw new Error('UNEXPECTED_BROWSER_PROVIDER_CALL'); }) as typeof fetch;
}
export default createWorker(app);
