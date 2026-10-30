import type {TranslationBindings} from './bindings.ts';
import type {TranslationRuntime} from './api-types.ts';
export function createTranslationRuntime(env:TranslationBindings):TranslationRuntime {
  if (env.AGENT_RUNTIME) return env.AGENT_RUNTIME.translation;
  let pending:Promise<TranslationRuntime>|undefined;
  const legacy = () => pending ??= import('./runtime-flue.ts').then(module => module.createTranslationRuntime(env));
  return {
    lookup: async (...args:Parameters<TranslationRuntime['lookup']>) => (await legacy()).lookup(...args),
    inspect: async (...args:Parameters<TranslationRuntime['inspect']>) => (await legacy()).inspect(...args),
    prepare: async (...args:Parameters<TranslationRuntime['prepare']>) => (await legacy()).prepare(...args),
    dispatch: async (...args:Parameters<TranslationRuntime['dispatch']>) => (await legacy()).dispatch(...args),
    read: async (...args:Parameters<TranslationRuntime['read']>) => (await legacy()).read(...args),
    close: async (...args:Parameters<TranslationRuntime['close']>) => (await legacy()).close(...args),
  };
}
