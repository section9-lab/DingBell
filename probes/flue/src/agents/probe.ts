'use agent';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai';
import { setProvider, useDelivery, useModel, useTool, type AgentProps } from '@flue/runtime';
import { getCloudflareContext } from '@flue/runtime/cloudflare';
import type { ProbeGate } from '../cloudflare.ts';
import { probeExtension } from '../probe-extension.ts';

export const cloudflare = probeExtension;

const faux = fauxProvider({
  api: 'dingbell-fixture',
  provider: 'dingbell-fixture',
  models: [{ id: 'reply' }, { id: 'gate' }],
});

const reply: FauxResponseFactory = (context, _options, _state, model) => {
  faux.appendResponses([reply]);
  const turn = context.messages.slice(context.messages.findLastIndex(message => message.role === 'user'));
  const result = turn.findLast(message => message.role === 'toolResult' && message.toolName === 'fixture_wait');
  if (result?.role === 'toolResult') {
    return fauxAssistantMessage(fauxText(result.isError ? 'fixture-tool-error' : 'fixture-ok'));
  }
  if (model.id === 'gate') {
    return fauxAssistantMessage(fauxToolCall('fixture_wait', {}), { stopReason: 'toolUse' });
  }
  return fauxAssistantMessage(fauxText('fixture-ok'));
};

faux.setResponses([reply]);
setProvider(faux.provider);

export function Probe({ id }: AgentProps) {
  const delivery = useDelivery();
  if (delivery.body === 'fixture:failure') throw new Error('Deterministic probe failure.');
  const cloudGate = delivery.body === 'fixture:cloud-gate';
  const toolTimeout = delivery.body === 'fixture:tool-timeout';
  useModel(delivery.body === 'fixture:gate' || cloudGate || toolTimeout ? 'dingbell-fixture/gate' : 'dingbell-fixture/reply');
  useTool({
    name: 'fixture_wait',
    description: 'Wait for the integration-test controller.',
    durable: true,
    timeoutMs: toolTimeout ? 50 : 120_000,
    async run({ step, signal, toolCallId }) {
      if (toolTimeout) {
        // Deliberately ignores the signal; no customer or external side effect.
        await scheduler.wait(3_000);
        return { output: 'late-tool-result' };
      }
      const { env } = getCloudflareContext();
      if (cloudGate) {
        const namespace = env.PROBE_GATE as DurableObjectNamespace<ProbeGate>;
        const gate = namespace.getByName(id);
        const executionId = crypto.randomUUID();
        await step.do('prepare', () => gate.prepare(toolCallId, executionId));
        const output = await step.do('wait', async () => {
          await gate.enterWait(toolCallId, executionId);
          for (;;) {
            signal?.throwIfAborted();
            const state = await gate.status();
            signal?.throwIfAborted();
            if (state.released) return 'released';
            await scheduler.wait(500, { signal });
          }
        });
        return { output };
      }
      if (typeof env.PROBE_GATE_URL !== 'string' || typeof env.PROBE_TOKEN !== 'string') {
        throw new Error('The local test gate is not configured.');
      }
      const base = new URL(env.PROBE_GATE_URL);
      if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') {
        throw new Error('The test gate must be on loopback.');
      }
      const call = async (action: string) => {
        const response = await fetch(new URL(`/${action}/${encodeURIComponent(id)}/${encodeURIComponent(toolCallId)}`, base), {
          headers: { authorization: `Bearer ${env.PROBE_TOKEN}` }, signal, redirect: 'manual',
        });
        if (!response.ok) throw new Error('The test gate rejected the request.');
        return response.text();
      };
      await step.do('prepare', () => call('prepare'));
      const output = await step.do('wait', () => call('wait'));
      return { output };
    },
  });
  return 'Return the deterministic integration-test response.';
}

Probe.agentName = 'Probe';
