'use agent';

import type { AgentProps } from '@flue/runtime';
import { Probe } from './probe.ts';
import { probeExtension } from '../probe-extension.ts';

export const cloudflare = probeExtension;

export function BoundedProbe(props: AgentProps) {
  return Probe(props);
}

BoundedProbe.agentName = 'BoundedProbe';
BoundedProbe.durability = { maxAttempts: 1, timeoutMs: 3_000 };
