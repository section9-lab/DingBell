import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { Harness } from '@earendil-works/pi-durable';
import type { AgentAuthority, AgentDriver } from './contracts.ts';
import { context, openAgent, providerId, readResult } from './harness.ts';

export function createNodeAgentDriver(directory: string, authority: AgentAuthority, list: () => Promise<string[]>): AgentDriver {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const opened = new Map<string, Promise<Harness>>();
  async function open(uid: string) {
    if (!/^pi_[0-9a-f-]{36}$/.test(uid)) throw new Error('AGENT_UID_INVALID');
    let pending = opened.get(uid);
    if (!pending) { pending = authority.describe(uid).then(async definition => openAgent(await openNodeSqliteStorage(join(directory, uid+'.sqlite')), definition, authority)); opened.set(uid, pending); pending.catch(() => opened.delete(uid)); }
    return pending;
  }
  return {
    async create() { return 'pi_'+crypto.randomUUID(); },
    async dispatch(uid) {
      const existing = await authority.receipt(uid); if (existing) return existing;
      const definition = await authority.describe(uid), harness = await open(uid);
      const root = await harness.root(context, { agent: { model: { provider: providerId, modelId: definition.modelId }, instructions: definition.instructions } });
      const submission = await root.submit({ type: 'input', content: definition.input, requestId: definition.requestId }, context);
      const receipt = { uid, submissionId: String(submission.id), acceptedAt: definition.acceptedAt };
      await authority.bind(uid, receipt); return receipt;
    },
    async read(uid, id) { return readResult(await open(uid), uid, id, authority); },
    async abort(uid) { await (await (await open(uid)).root(context)).abort(context); },
    async resumeAll() { for (const uid of await list()) (await open(uid)).resume(); },
    async close() { await Promise.allSettled([...opened.values()].map(async harness => (await harness).close(context))); },
  };
}
