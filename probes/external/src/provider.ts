import { nvidiaProvider } from '@earendil-works/pi-ai/providers/nvidia';
import type { Provider } from '@earendil-works/pi-ai';
import { getCloudflareContext } from '@flue/runtime/cloudflare';
import { ProbeLedger } from './ledger.ts';
import { modelId } from './constants.ts';
import { probeFetch } from './transport.ts';

export function currentLedger() {
  return new ProbeLedger(getCloudflareContext().storage.sql, 'model');
}

export function externalProvider(): Provider<'openai-completions'> {
  const base = nvidiaProvider();
  const model = base.getModels().find(model => model.id === modelId);
  if (!model || model.baseUrl !== 'https://integrate.api.nvidia.com/v1') throw new Error('The pinned NVIDIA model is unavailable.');
  const transport = probeFetch(currentLedger);
  return {
    ...base,
    getModels: () => [model],
    auth: { apiKey: {
      name: 'NVIDIA external probe secret',
      async resolve({ signal }) {
        signal.throwIfAborted();
        const key = getCloudflareContext().env.NVAPI_KEY;
        if (typeof key !== 'string' || !key) throw new Error('The external model secret is unavailable.');
        return { auth: { apiKey: key }, source: 'Cloudflare probe secret' };
      },
    } },
    stream() { throw new Error('This probe only supports the bounded simple stream.'); },
    streamSimple(model, context, options) {
      currentLedger().spend('generation');
      return base.streamSimple(model, context, {
        ...options, maxTokens: 512, maxRetries: 0, timeoutMs: 45_000, fetch: transport,
        temperature: 1, samplingParams: { top_p: 0.95, chat_template_kwargs: { enable_thinking: false } },
        signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
      });
    },
  };
}
