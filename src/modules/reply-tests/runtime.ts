import type {ReplyTestBindings} from './execution.ts';
import type {ReplyTestRuntime} from './execution.ts';
export function createReplyTestRuntime(env:ReplyTestBindings):ReplyTestRuntime {
  if (env.AGENT_RUNTIME) return env.AGENT_RUNTIME.replyTest;
  let pending:Promise<ReplyTestRuntime>|undefined;
  const legacy = () => pending ??= import('./runtime-flue.ts').then(module => module.createReplyTestRuntime(env));
  return {
    lookup: async (...args:Parameters<ReplyTestRuntime['lookup']>) => (await legacy()).lookup(...args),
    inspect: async (...args:Parameters<ReplyTestRuntime['inspect']>) => (await legacy()).inspect(...args),
    prepare: async (...args:Parameters<ReplyTestRuntime['prepare']>) => (await legacy()).prepare(...args),
    dispatch: async (...args:Parameters<ReplyTestRuntime['dispatch']>) => (await legacy()).dispatch(...args),
    read: async (...args:Parameters<ReplyTestRuntime['read']>) => (await legacy()).read(...args),
    close: async (...args:Parameters<ReplyTestRuntime['close']>) => (await legacy()).close(...args),
  };
}
