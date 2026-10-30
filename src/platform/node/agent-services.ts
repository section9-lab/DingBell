import type { AgentDriver } from '../../../packages/agent-runtime/contracts.ts';
import type { PortableAgents } from '../agents/bindings.ts';
import type { BusinessAgentAuthority } from '../agents/authority.ts';
import { matchingSupport } from '../../modules/ai-runs/execution.ts';

export function agentServices(authority: BusinessAgentAuthority, driver: AgentDriver): PortableAgents {
  const uid = (kind: 'translation' | 'reply-test' | 'support', id: string) => {
    const binding = authority.lookup(kind,id); if (!binding) throw new Error('AGENT_AUTHORITY_UNAVAILABLE'); return binding.uid;
  };
  const translation: PortableAgents['translation'] = {
    lookup: async id => authority.admitted('translation',id), inspect: async id => authority.preview(id).inspect(),
    prepare: (scope,id) => authority.prepare('translation',scope,id), close: (scope,id) => authority.closeUnstarted('translation',scope,id),
    dispatch: run => driver.dispatch(authority.begin('translation',run.id)),
    async read(id,receipt) {
      if (receipt.uid !== uid('translation',id)) throw new Error('AGENT_RECEIPT_CONFLICT');
      const result = await driver.read(receipt.uid,receipt.submissionId); return result.outcome === 'aborted' ? { outcome: 'failed' } : result;
    },
  };
  const replyTest: PortableAgents['replyTest'] = {
    lookup: async id => authority.admitted('reply-test',id), inspect: async id => authority.replyTest(id).inspect(),
    prepare: (scope,id) => authority.prepare('reply-test',scope,id), close: (scope,id) => authority.closeUnstarted('reply-test',scope,id),
    dispatch: run => driver.dispatch(authority.begin('reply-test',run.id)),
    async read(id,receipt) {
      if (receipt.uid !== uid('reply-test',id)) throw new Error('AGENT_RECEIPT_CONFLICT');
      const result = await driver.read(receipt.uid,receipt.submissionId); return result.outcome === 'aborted' ? { outcome: 'failed' } : result;
    },
  };
  const support: PortableAgents['support'] = {
    lookup: async run => authority.admitted('support',run.id), inspect: async run => authority.support(run.id).inspect(),
    prepare: run => authority.prepare('support',run.payload.run.scope,run.id),
    async dispatch(run){const state=await support.inspect(run);if(!state||!matchingSupport(state,run))throw new Error('AGENT_BINDING_CONFLICT');return driver.dispatch(authority.begin('support',run.id));},
    async recover(run){const state=await support.inspect(run);if(!state||!matchingSupport(state,run))throw new Error('AGENT_BINDING_CONFLICT');return driver.dispatch(authority.begin('support',run.id,true));}, cancel: run => authority.cancelSupport(run.payload.run.scope,run.id),
    async read(run) {
      if (!run.receipt || run.receipt.uid !== uid('support',run.id)) throw new Error('AGENT_RECEIPT_CONFLICT');
      return (await driver.read(run.receipt.uid,run.receipt.submissionId)).outcome;
    },
    async abort(run) {
      const state = await support.inspect(run);
      if (!state || !matchingSupport(state,run) || !state.cancellation || !run.receipt || state.receipt?.uid !== run.receipt.uid || (await support.lookup(run))?.uid !== run.receipt.uid) throw new Error('AGENT_ABORT_UNCONFIRMED');
      await driver.abort(run.receipt.uid);
    },
    async close(run) {
      const binding = await support.lookup(run);
      if (!run.receipt) { if (binding || run.generations.length) throw new Error('AGENT_CLOSURE_UNCONFIRMED'); await authority.closeSupport(run.payload.run.scope,run.id,null); return; }
      if (binding?.uid !== run.receipt.uid) throw new Error('AGENT_CLOSURE_UNCONFIRMED');
      const outcome = await support.read(run); if (outcome === 'pending') throw new Error('AGENT_CLOSURE_UNCONFIRMED');
      await authority.closeSupport(run.payload.run.scope,run.id,outcome);
    },
  };
  return { translation, replyTest, support };
}
