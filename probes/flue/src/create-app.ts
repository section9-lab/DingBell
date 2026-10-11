import { Hono, type MiddlewareHandler } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { HTTPException } from 'hono/http-exception';
import { AgentRunError, FlueError } from '@flue/runtime';
import type { AgentDispatchRequest, AgentReply, DispatchReceipt } from '@flue/runtime';

type ProbeEnvironment = { Bindings: { PROBE_TOKEN?: string } };

export interface ProbeDependencies {
  agentRouter: Hono;
  dispatch: (request: AgentDispatchRequest) => Promise<DispatchReceipt>;
  read: (id: string, submissionId: string) => Promise<AgentReply>;
}

export function createProbeApp(dependencies: ProbeDependencies) {
  const app = new Hono<ProbeEnvironment>();
  const authenticate: MiddlewareHandler<ProbeEnvironment> = async (context, next) => {
    const token = context.env?.PROBE_TOKEN;
    if (!token) {
      return context.json({ error: {
        type: 'probe_unavailable',
        message: 'Probe authentication is not configured.',
      } }, 503);
    }
    return bearerAuth<ProbeEnvironment>({ token })(context, next);
  };

  app.use('/__probe/*', authenticate);
  app.use('/agents/probe/*', authenticate);

  app.get('/api/health', (context) => context.json({
    service: 'dingbell-flue-probe',
    status: 'ok',
  }));
  app.route('/agents/probe', dependencies.agentRouter);
  app.post('/__probe/:id/dispatch', async (context) => {
    const body = await context.req.json<AgentDispatchRequest>();
    const receipt = await dependencies.dispatch({ ...body, id: context.req.param('id') });
    return context.json(receipt, 202);
  });
  app.get('/__probe/:id/reply/:submissionId', async (context) => {
    const reply = await dependencies.read(context.req.param('id'), context.req.param('submissionId'));
    return context.json(reply);
  });
  app.onError((error) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof AgentRunError) {
      return Response.json({ error: {
        type: `agent_run_${error.outcome}`,
        submissionId: error.submissionId,
      } }, { status: 409 });
    }
    if (error instanceof FlueError) {
      const status = 'status' in error && typeof error.status === 'number' ? error.status : 500;
      return Response.json({ error: {
        type: error.type,
        message: error.message,
        details: error.details,
        ...(error.meta === undefined ? {} : { meta: error.meta }),
      } }, { status });
    }
    return Response.json({ error: {
      type: 'internal_error',
      message: 'The probe request failed.',
      details: '',
    } }, { status: 500 });
  });

  return app;
}
