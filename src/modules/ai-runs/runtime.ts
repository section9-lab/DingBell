import type {SupportBindings,SupportRuntime} from './execution.ts';
export function createSupportRuntime(env:SupportBindings):SupportRuntime {
  if (!env.AGENT_RUNTIME) throw new Error('SUPPORT_RUNTIME_UNAVAILABLE');
  return env.AGENT_RUNTIME.support;
}
