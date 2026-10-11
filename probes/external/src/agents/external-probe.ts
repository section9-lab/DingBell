'use agent';

import { observe, setProvider, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { externalExtension } from '../extension.ts';
import { currentLedger, externalProvider } from '../provider.ts';
import { instanceId, modelId } from '../constants.ts';

export const cloudflare = externalExtension;
setProvider(externalProvider());
observe(event => {
  if (event.instanceId !== instanceId || event.agentName !== 'ExternalProbe') return;
  if (event.type === 'turn') {
    const u = event.response.usage;
    currentLedger().record('turn', {
      isError: event.isError, finishReason: event.response.finishReason,
      ...(u ? { usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, totalTokens: u.totalTokens } } : {}),
    });
  }
  if (event.type === 'submission_settled') {
    currentLedger().record('settled', { outcome: event.outcome });
    currentLedger().close();
  }
});

export function ExternalProbe() {
  useModel(`nvidia/${modelId}`, { thinkingLevel: 'off', compaction: false });
  useTool({
    name: 'lookup_test_order',
    description: 'Read only the synthetic order TEST-1001. This tool never accesses Ozon or a real consumer.',
    input: v.object({ orderId: v.literal('TEST-1001') }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    timeoutMs: 1_000,
    run({ data, toolCallId }) {
      const output = { orderId: data.orderId, status: 'shipped', estimatedDelivery: '2026-10-12', synthetic: true };
      currentLedger().record('tool', { toolCallId, input: data, output });
      return { output };
    },
  });
  return 'You are an ecommerce support test agent. All data is synthetic. Answer in Russian. '
    + 'Call lookup_test_order exactly once before answering the order question. Use the returned status and estimated date. '
    + 'Explain the date is an estimate. Do not invent tracking locations or guarantees. Answer in fewer than 70 words.';
}
ExternalProbe.agentName = 'ExternalProbe';
ExternalProbe.durability = { maxAttempts: 1, timeoutMs: 120_000 };
