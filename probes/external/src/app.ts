import { dispatch, init } from '@flue/runtime';
import { getAgentByName, type Agent } from 'agents';
import { ExternalProbe } from './agents/external-probe.ts';
import { createExternalApp, type ExternalBindings } from './create-app.ts';
import { instanceId, question } from './constants.ts';
import type { ExternalControls } from './extension.ts';
import { runOzonOnce } from './ozon.ts';

export function externalStub(env: ExternalBindings) {
  return getAgentByName(env.FLUE_EXTERNAL_PROBE_AGENT as DurableObjectNamespace<Agent & ExternalControls>, instanceId);
}
const app = createExternalApp({
  inspect: async env => (await externalStub(env)).externalInspect('model'),
  claim: async env => (await externalStub(env)).externalClaim('model'),
  bind: async (env, receipt) => (await externalStub(env)).externalBind(receipt),
  dispatch: () => dispatch(ExternalProbe, { id: instanceId, message: question, idempotencyKey: 'synthetic-order-once-v1' }),
  read: receipt => init(ExternalProbe, { id: instanceId }).read(receipt.submissionId, { signal: AbortSignal.timeout(1_000) }),
  ozon: {
    run: async env => runOzonOnce(await externalStub(env), env),
    result: async env => (await externalStub(env)).externalInspect('ozon'),
  },
});
export default app;
