import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { dispatch, getAgentInstance, init } from '@flue/runtime';
import { getAgentByName, type Agent } from 'agents';
import { Probe } from './agents/probe.ts';
import type { ProbeGate } from './cloudflare.ts';
import type { ProbeControls } from './probe-extension.ts';

interface Bindings {
  PROBE_GATE: DurableObjectNamespace<ProbeGate>;
  FLUE_PROBE_AGENT: DurableObjectNamespace<Agent & ProbeControls>;
}

export const lifecycleRouter = new Hono<{ Bindings: Bindings }>();
const fixtureId = /^lifecycle-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const path = '/:id/lifecycle';
lifecycleRouter.use('/:id/*', async (context, next) => {
  if (!fixtureId.test(context.req.param('id') ?? '')) throw new HTTPException(400);
  await next();
});
lifecycleRouter.get(path, async context => {
  const id = context.req.param('id');
  const stub = await getAgentByName(context.env.FLUE_PROBE_AGENT, id);
  const inspection = await stub.probeInspection();
  return context.json({
    exists: (await getAgentInstance(Probe, id)) !== null,
    ...inspection,
    gate: await context.env.PROBE_GATE.getByName(id).status(),
  });
});
lifecycleRouter.get('/:id/observations', async context => {
  const stub = await getAgentByName(context.env.FLUE_PROBE_AGENT, context.req.param('id'));
  return context.json({ events: await stub.probeObservations() });
});
lifecycleRouter.post('/:id/observations/failure', async context => {
  const { enabled } = await context.req.json<{ enabled?: unknown }>();
  if (typeof enabled !== 'boolean') throw new HTTPException(400);
  const stub = await getAgentByName(context.env.FLUE_PROBE_AGENT, context.req.param('id'));
  await stub.probeObserverFailure(enabled);
  return context.json({ enabled });
});
lifecycleRouter.post('/:id/control/run', async context => {
  const { message } = await context.req.json<{ message?: unknown }>();
  if (message !== 'hello' && message !== 'fixture:cloud-gate') throw new HTTPException(400);
  const id = context.req.param('id');
  const gate = context.env.PROBE_GATE.getByName(id);
  const run = await gate.startRun();
  if (!run) throw new HTTPException(409);
  const receipt = await dispatch(Probe, { id, message, idempotencyKey: run.runId });
  await gate.bindSubmission(run.runId, receipt.submissionId);
  return context.json({ context: run, receipt }, 202);
});
lifecycleRouter.post('/:id/control/mode', async context => {
  const { mode } = await context.req.json<{ mode?: unknown }>();
  if (mode !== 'ai' && mode !== 'human') throw new HTTPException(400);
  return context.json(await context.env.PROBE_GATE.getByName(context.req.param('id')).setMode(mode));
});
lifecycleRouter.post('/:id/control/candidate', async context => {
  const { runId } = await context.req.json<{ runId?: unknown }>();
  if (typeof runId !== 'string' || !/^[0-9a-f-]{36}$/.test(runId)) throw new HTTPException(400);
  const id = context.req.param('id');
  const gate = context.env.PROBE_GATE.getByName(id);
  const run = await gate.getRun(runId);
  if (!run?.submissionId) throw new HTTPException(404);
  // A candidate uses its stored submission and original context, never caller-supplied versions.
  await init(Probe, { id }).read(run.submissionId, { signal: AbortSignal.timeout(5_000) });
  const decision = await gate.checkCandidate(runId);
  if (!decision) throw new HTTPException(404);
  if (!decision.accepted) return context.json({ error: { type: 'stale_candidate' }, ...decision }, 409);
  return context.json(decision);
});
lifecycleRouter.post(`${path}/interrupt`, async context => {
  const { nonce } = await context.req.json<{ nonce?: unknown }>();
  if (typeof nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(nonce)) throw new HTTPException(400);
  const id = context.req.param('id');
  const gate = await context.env.PROBE_GATE.getByName(id).status();
  if (gate.entered.length !== 1 || gate.released) throw new HTTPException(409);
  const stub = await getAgentByName(context.env.FLUE_PROBE_AGENT, id);
  await stub.probeInterrupt(nonce);
  return context.json({ error: 'Interruption unexpectedly returned.' }, 500);
});
lifecycleRouter.post(`${path}/release`, async context => {
  return context.json(await context.env.PROBE_GATE.getByName(context.req.param('id')).release());
});
lifecycleRouter.post(`${path}/destroy`, async context => {
  const id = context.req.param('id');
  const gate = await context.env.PROBE_GATE.getByName(id).status();
  if (!gate.released) throw new HTTPException(409);
  const { submissionId } = await context.req.json<{ submissionId?: unknown }>();
  if (typeof submissionId !== 'string' || !submissionId) throw new HTTPException(400);
  // Only this settled test submission may be removed; this is not a business deletion API.
  await init(Probe, { id }).read(submissionId, { signal: AbortSignal.timeout(5_000) });
  const stub = await getAgentByName(context.env.FLUE_PROBE_AGENT, id);
  await stub.probeDestroy();
  return context.json({ destroyed: true });
});
