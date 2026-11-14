import type { ApplicationEnv } from '../../http.ts';
import type { PortableAgents } from '../agents/bindings.ts';
import type { PiAgentObject } from './agent.ts';
import type { AgentKind } from '../../../packages/agent-runtime/contracts.ts';

export type CloudflareEnv = ApplicationEnv['Bindings'] & { PI_AGENT: DurableObjectNamespace<PiAgentObject>; ASSETS?: Fetcher };
export function withRuntime(env: CloudflareEnv): CloudflareEnv {
  if (env.AGENT_RUNTIME) return env;
  const object = (kind: AgentKind, id: string) => env.PI_AGENT.getByName(`${kind}:${id}`);
  const support: PortableAgents['support'] = {
    lookup: run => object('support',run.id).supportLookup(run), inspect: run => object('support',run.id).supportInspect(run),
    prepare: run => object('support',run.id).supportPrepare(run), dispatch: run => object('support',run.id).supportDispatch(run),
    recover: run => object('support',run.id).supportRecover(run), cancel: run => object('support',run.id).supportCancel(run),
    read: run => object('support',run.id).supportRead(run), abort: run => object('support',run.id).supportAbort(run), close: run => object('support',run.id).supportClose(run),
    activity: run => object('support',run.id).supportActivity(run),
  };
  return { ...env, AGENT_RUNTIME: { support } };
}
