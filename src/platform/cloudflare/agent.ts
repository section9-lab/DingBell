import { DurableObject } from 'cloudflare:workers';
import { PiHarness } from '../../../deploy/cloudflare/node_modules/agents/dist/harness/pi/index.js';
import { Lifecycle } from '../../../deploy/cloudflare/node_modules/agents/dist/lifecycle/index.js';
import { ROOT_CONVERSATION_ID, context, openAgent, providerId, readResult } from '../../../packages/agent-runtime/harness.ts';
import type { AgentDriver, AgentKind } from '../../../packages/agent-runtime/contracts.ts';
import { BusinessAgentAuthority } from '../agents/authority.ts';
import { initializeExecutionState, type ExecutionStateSql } from '../agents/state.ts';
import { agentServices } from '../node/agent-services.ts';
import type { PortableAgents } from '../agents/bindings.ts';
import { withRuntime, type CloudflareEnv } from './runtime.ts';

type Method<K extends keyof PortableAgents, M extends keyof PortableAgents[K]> = PortableAgents[K][M];
export class PiAgentObject extends DurableObject<CloudflareEnv> {
  readonly authority: BusinessAgentAuthority;
  readonly services: PortableAgents;
  readonly harness: PiHarness;
  readonly lifecycle: Lifecycle;
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx,env);
    const state: ExecutionStateSql = {
      prepare: query => ({ all: (...values) => ctx.storage.sql.exec(query,...values).toArray(), get: (...values) => ctx.storage.sql.exec(query,...values).toArray()[0], run: (...values) => ctx.storage.sql.exec(query,...values).toArray() }),
      exec: query => { ctx.storage.sql.exec(query); }, transaction: action => ctx.storage.transactionSync(action),
    };
    initializeExecutionState(state);
    if (!env.DB) throw new Error('DATABASE_UNAVAILABLE');
    this.authority = new BusinessAgentAuthority(env.DB,withRuntime(env),state);
    const uid = () => {
      const row=state.prepare('SELECT uid FROM runtime_agent_binding').get();
      if(!row)throw new Error('AGENT_BINDING_UNAVAILABLE'); return String(row.uid);
    };
    this.harness = new PiHarness({ harness: async ({storage,onWake}) => {
      const definition=await this.authority.describe(uid()),pi=await openAgent(storage,definition,this.authority,onWake);
      // PiHarness opens the root too. Initialize its immutable agent before that first open.
      await pi.root(context,{agent:{model:{provider:providerId,modelId:definition.modelId},instructions:definition.instructions}});
      return pi;
    } });
    this.lifecycle = Lifecycle.install(this).use(this.harness);
    const driver: AgentDriver = {
      create: async () => 'pi_'+crypto.randomUUID(),
      dispatch: async id => {
        if(id!==uid())throw new Error('AGENT_BINDING_CONFLICT');
        const prior=await this.authority.receipt(id); if(prior)return prior;
        const definition=await this.authority.describe(id), pi=await this.harness.pi();
        await pi.root(context,{agent:{model:{provider:providerId,modelId:definition.modelId},instructions:definition.instructions}});
        await this.harness.submit(definition.input,{operationId:definition.requestId});
        const submission=await (await this.harness.storage()).submissionByRequest(ROOT_CONVERSATION_ID,definition.requestId,context);
        if(!submission)throw new Error('AGENT_RECEIPT_UNCONFIRMED');
        const receipt={uid:id,submissionId:String(submission.id),acceptedAt:definition.acceptedAt};
        await this.authority.bind(id,receipt); return receipt;
      },
      read: async (id,submissionId) => { if(id!==uid())throw new Error('AGENT_BINDING_CONFLICT');return readResult(await this.harness.pi(),id,submissionId,this.authority); },
      abort: async id => { if(id!==uid())throw new Error('AGENT_BINDING_CONFLICT');await this.harness.abort({operationId:(await this.authority.describe(id)).requestId}); },
      resumeAll: async () => {}, close: async () => {},
    };
    this.authority.driver=driver; this.services=agentServices(this.authority,driver);
  }
  private scope(kind: AgentKind,id: string) { if(!this.ctx.id.equals(this.env.PI_AGENT.idFromName(`${kind}:${id}`)))throw new Error('AGENT_SCOPE_MISMATCH'); }
  async translationLookup(...args: Parameters<Method<'translation','lookup'>>) { this.scope('translation',args[0]); return this.services.translation.lookup(...args); }
  async translationInspect(...args: Parameters<Method<'translation','inspect'>>) { this.scope('translation',args[0]); return this.services.translation.inspect(...args); }
  async translationPrepare(...args: Parameters<Method<'translation','prepare'>>) { this.scope('translation',args[1]); return this.services.translation.prepare(...args); }
  async translationClose(...args: Parameters<Method<'translation','close'>>) { this.scope('translation',args[1]); return this.services.translation.close(...args); }
  async translationDispatch(...args: Parameters<Method<'translation','dispatch'>>) { this.scope('translation',args[0].id); return this.services.translation.dispatch(...args); }
  async translationRead(...args: Parameters<Method<'translation','read'>>) { this.scope('translation',args[0]); return this.services.translation.read(...args); }
  async replyTestLookup(...args: Parameters<Method<'replyTest','lookup'>>) { this.scope('reply-test',args[0]); return this.services.replyTest.lookup(...args); }
  async replyTestInspect(...args: Parameters<Method<'replyTest','inspect'>>) { this.scope('reply-test',args[0]); return this.services.replyTest.inspect(...args); }
  async replyTestPrepare(...args: Parameters<Method<'replyTest','prepare'>>) { this.scope('reply-test',args[1]); return this.services.replyTest.prepare(...args); }
  async replyTestClose(...args: Parameters<Method<'replyTest','close'>>) { this.scope('reply-test',args[1]); return this.services.replyTest.close(...args); }
  async replyTestDispatch(...args: Parameters<Method<'replyTest','dispatch'>>) { this.scope('reply-test',args[0].id); return this.services.replyTest.dispatch(...args); }
  async replyTestRead(...args: Parameters<Method<'replyTest','read'>>) { this.scope('reply-test',args[0]); return this.services.replyTest.read(...args); }
  async supportLookup(...args: Parameters<Method<'support','lookup'>>) { this.scope('support',args[0].id); return this.services.support.lookup(...args); }
  async supportInspect(...args: Parameters<Method<'support','inspect'>>) { this.scope('support',args[0].id); return this.services.support.inspect(...args); }
  async supportPrepare(...args: Parameters<Method<'support','prepare'>>) { this.scope('support',args[0].id); return this.services.support.prepare(...args); }
  async supportDispatch(...args: Parameters<Method<'support','dispatch'>>) { this.scope('support',args[0].id); return this.services.support.dispatch(...args); }
  async supportRecover(...args: Parameters<Method<'support','recover'>>) { this.scope('support',args[0].id); return this.services.support.recover(...args); }
  async supportCancel(...args: Parameters<Method<'support','cancel'>>) { this.scope('support',args[0].id); return this.services.support.cancel(...args); }
  async supportRead(...args: Parameters<Method<'support','read'>>) { this.scope('support',args[0].id); return this.services.support.read(...args); }
  async supportAbort(...args: Parameters<Method<'support','abort'>>) { this.scope('support',args[0].id); return this.services.support.abort(...args); }
  async supportClose(...args: Parameters<Method<'support','close'>>) { this.scope('support',args[0].id); return this.services.support.close(...args); }
}
