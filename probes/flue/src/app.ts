import { dispatch, init } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { Probe } from './agents/probe.ts';
import { createProbeApp } from './create-app.ts';
import { lifecycleRouter } from './lifecycle-routes.ts';
import { boundedRouter } from './bounded-routes.ts';

const app = createProbeApp({
  agentRouter: createAgentRouter(Probe),
  dispatch: (request) => dispatch(Probe, request),
  read: (id, submissionId) => init(Probe, { id }).read(submissionId),
});
app.route('/__probe', lifecycleRouter);
app.route('/__probe', boundedRouter);
export default app;
