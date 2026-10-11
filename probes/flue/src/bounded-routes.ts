import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { AgentRunError, dispatch, getAgentInstance, init } from '@flue/runtime';
import { getAgentByName, type Agent } from 'agents';
import { BoundedProbe } from './agents/bounded-probe.ts';
import type { ProbeGate } from './cloudflare.ts';
import type { ProbeControls } from './probe-extension.ts';

interface Bindings {
  PROBE_GATE: DurableObjectNamespace<ProbeGate>;
  FLUE_BOUNDED_PROBE_AGENT: DurableObjectNamespace<Agent & ProbeControls>;
}

export const boundedRouter = new Hono<{ Bindings: Bindings }>();
const path = '/:id/bounded';
boundedRouter.use(`${path}/*`, async (context, next) => {
  if (!/^lifecycle-[0-9a-f-]{36}$/.test(context.req.param('id') ?? '')) throw new HTTPException(400);
  await next();
});
boundedRouter.post(`${path}/dispatch`, async context => {
  const receipt = await dispatch(BoundedProbe, {
    id: context.req.param('id'), message: 'fixture:cloud-gate', idempotencyKey: 'bounded-input',
  });
  return context.json(receipt, 202);
});
boundedRouter.get(`${path}/reply/:submissionId`, async context => {
  return context.json(await init(BoundedProbe, { id: context.req.param('id') }).read(context.req.param('submissionId')));
});
boundedRouter.get(`${path}/inspection`, async context => {
  const id = context.req.param('id');
  const stub = await getAgentByName(context.env.FLUE_BOUNDED_PROBE_AGENT, id);
  return context.json({
    exists: (await getAgentInstance(BoundedProbe, id)) !== null,
    ...await stub.probeInspection(),
    gate: await context.env.PROBE_GATE.getByName(id).status(),
    events: await stub.probeObservations(),
  });
});
boundedRouter.post(`${path}/interrupt`, async context => {
  const { nonce } = await context.req.json<{ nonce?: unknown }>();
  if (typeof nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(nonce)) throw new HTTPException(400);
  const id = context.req.param('id');
  const gate = await context.env.PROBE_GATE.getByName(id).status();
  if (gate.entered.length !== 1 || gate.released) throw new HTTPException(409);
  const stub = await getAgentByName(context.env.FLUE_BOUNDED_PROBE_AGENT, id);
  await stub.probeInterrupt(nonce);
  return context.json({ error: 'Interruption unexpectedly returned.' }, 500);
});
boundedRouter.post(`${path}/destroy`, async context => {
  const { submissionId } = await context.req.json<{ submissionId?: unknown }>();
  if (typeof submissionId !== 'string' || !submissionId) throw new HTTPException(400);
  const id = context.req.param('id');
  try {
    await init(BoundedProbe, { id }).read(submissionId, { signal: AbortSignal.timeout(1_000) });
  } catch (error) {
    if (!(error instanceof AgentRunError)) throw error;
  }
  const stub = await getAgentByName(context.env.FLUE_BOUNDED_PROBE_AGENT, id);
  await stub.probeDestroy();
  return context.json({ destroyed: true });
});
