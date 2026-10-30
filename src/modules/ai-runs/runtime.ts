import type {SupportBindings} from './execution.ts';
import type {SupportRuntime} from './execution.ts';
export function createSupportRuntime(env:SupportBindings):SupportRuntime {
  if (env.AGENT_RUNTIME) return env.AGENT_RUNTIME.support;
  let pending:Promise<SupportRuntime>|undefined;
  const legacy = () => pending ??= import('./runtime-flue.ts').then(module => module.createSupportRuntime(env));
  return {
    lookup: async (...args:Parameters<SupportRuntime['lookup']>) => (await legacy()).lookup(...args),
    inspect: async (...args:Parameters<SupportRuntime['inspect']>) => (await legacy()).inspect(...args),
    prepare: async (...args:Parameters<SupportRuntime['prepare']>) => (await legacy()).prepare(...args),
    dispatch: async (...args:Parameters<SupportRuntime['dispatch']>) => (await legacy()).dispatch(...args),
    read: async (...args:Parameters<SupportRuntime['read']>) => (await legacy()).read(...args),
    close: async (...args:Parameters<SupportRuntime['close']>) => (await legacy()).close(...args),
    recover: async (...args:Parameters<SupportRuntime['recover']>) => (await legacy()).recover(...args),
    cancel: async (...args:Parameters<SupportRuntime['cancel']>) => (await legacy()).cancel(...args),
    abort: async (...args:Parameters<SupportRuntime['abort']>) => (await legacy()).abort(...args),
  };
}
export const supportRuntime = createSupportRuntime;
export async function dispatchSupport(env:SupportBindings,run:import('./storage.ts').AiExecution,existingOnly=false) {
  if (env.AGENT_RUNTIME) return existingOnly ? env.AGENT_RUNTIME.support.recover(run) : env.AGENT_RUNTIME.support.dispatch(run);
  return (await import('./runtime-flue.ts')).dispatchSupport(env,run,existingOnly);
}
