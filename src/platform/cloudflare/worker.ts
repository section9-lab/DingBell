import { DurableObject } from 'cloudflare:workers';
import { createApp } from '../../application.ts';
import { createConversationController } from '../../modules/conversations/controller-core.ts';
import { createStoreCoordinator } from '../../modules/sync/coordinator-core.ts';
import { runScheduled } from '../../scheduled.ts';
import { withRuntime, type CloudflareEnv } from './runtime.ts';
export { PiAgentObject } from './agent.ts';
export { KnowledgeIndexWorkflow } from '../../modules/knowledge/index-workflow.ts';
export { KnowledgeReviewWorkflow } from '../../modules/knowledge/review-workflow.ts';
class RuntimeObject extends DurableObject<CloudflareEnv> {
  constructor(ctx:DurableObjectState,env:CloudflareEnv){super(ctx,withRuntime(env));}
}
export const ConversationController=createConversationController(RuntimeObject as typeof DurableObject);
export const StoreCoordinator=createStoreCoordinator(RuntimeObject as typeof DurableObject);
// Retain historical namespaces and SQLite data. Legacy executions must be drained before upgrading.
class LegacyArchive extends DurableObject {
  fetch(){return new Response(null,{status:410});}
  async alarm(){await this.ctx.storage.deleteAlarm();}
}
export class FlueReplyPreviewAgent extends LegacyArchive {}
export class FlueReplyTestAgent extends LegacyArchive {}
export class FlueSupportAgent extends LegacyArchive {}
const app=createApp();
export default {
  async fetch(request:Request,env:CloudflareEnv,ctx:ExecutionContext){
    const path=new URL(request.url).pathname;
    if(path==='/api'||path.startsWith('/api/'))return app.fetch(request,withRuntime(env),ctx);
    if(['/agents','/__probe','/__internal'].some(prefix=>path===prefix||path.startsWith(prefix+'/')))return new Response(null,{status:404});
    return env.ASSETS?.fetch(request)??new Response(null,{status:404});
  },
  async scheduled(_event:ScheduledController,env:CloudflareEnv){await runScheduled(withRuntime(env));},
} satisfies ExportedHandler<CloudflareEnv>;
