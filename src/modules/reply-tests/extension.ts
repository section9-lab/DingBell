import { extend } from '@flue/runtime/cloudflare';
import type { Agent } from 'agents';
import type { ControlScope } from '../conversations/control-types.ts';
import { replyTestControl,type ReplyTestBindings } from './execution.ts';
import { readReplyTestExecutionContext,releaseUnstartedReplyTest } from './storage.ts';
import { ReplyTestLedger } from './ledger.ts';
import { replyTestInstance,validateReplyTestConfig } from './policy.ts';
import { replyTestModel } from './provider.ts';
export const replyTestExtension=extend<Agent>({base:Base=>class extends Base {
  #context:DurableObjectState;#env:ReplyTestBindings;
  constructor(...args:ConstructorParameters<typeof Base>){super(...args);this.#context=args[0];this.#env=args[1];}
  private identity(id:string){if(!this.#env.FLUE_REPLY_TEST_AGENT||this.#env.FLUE_REPLY_TEST_AGENT.idFromName(replyTestInstance(id)).toString()!==this.#context.id.toString())throw new Error('REPLY_TEST_SCOPE_MISMATCH');}
  async prepareReplyTest(scope:ControlScope,id:string){
    this.identity(id);const env=this.#env;if(env.REPLY_TEST_ENABLED!=='true'||!env.DB)throw new Error('REPLY_TEST_DISABLED');
    const run=await readReplyTestExecutionContext(env.DB,replyTestControl(env),scope,id);if(!run)throw new Error('REPLY_TEST_UNAVAILABLE');
    validateReplyTestConfig(run.config,replyTestModel.contextWindow);new ReplyTestLedger(this.#context.storage.sql).prepare(run);
  }
  async inspectReplyTest(){return new ReplyTestLedger(this.#context.storage.sql).inspect();}
  async closeUnstartedReplyTest(scope:ControlScope,id:string){
    this.identity(id);const ledger=new ReplyTestLedger(this.#context.storage.sql),state=ledger.inspect();
    if(!state||state.run.id!==id||JSON.stringify(state.run.payload.context.scope)!==JSON.stringify(scope)||!this.#env.DB)throw new Error('REPLY_TEST_SCOPE_MISMATCH');
    await releaseUnstartedReplyTest(this.#env.DB,scope,id,ledger.close());
  }
}});
