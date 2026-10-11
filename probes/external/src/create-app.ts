import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { HTTPException } from 'hono/http-exception';
import type { DispatchReceipt } from '@flue/runtime';
import type { ProbeInspection } from './ledger.ts';

export interface ExternalBindings { PROBE_TOKEN?: string; [name: string]: unknown }
interface Dependencies {
  inspect(env: ExternalBindings): Promise<ProbeInspection>;
  claim(env: ExternalBindings): Promise<boolean>;
  bind(env: ExternalBindings, receipt: DispatchReceipt): Promise<void>;
  dispatch(): Promise<DispatchReceipt>;
  read(receipt: DispatchReceipt): Promise<{ text?: string }>;
  ozon?: {
    run(env: ExternalBindings): Promise<unknown>;
    result(env: ExternalBindings): Promise<unknown>;
  };
}

export function createExternalApp(dependencies: Dependencies) {
  const app = new Hono<{ Bindings: ExternalBindings }>();
  app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.use('/__probe/*', async (c, next) => c.env.PROBE_TOKEN
    ? bearerAuth<{ Bindings: ExternalBindings }>({ token: c.env.PROBE_TOKEN })(c, next)
    : c.json({ error: 'probe_unconfigured' }, 503));
  app.get('/api/health', c => c.json({ service: 'dingbell-external-probe', status: 'ok', synthetic: true }));
  app.post('/__probe/model/dispatch', async c => {
    const body = (await c.req.text()).trim();
    if ((body !== '' && body !== '{}') || new URL(c.req.url).search) return c.json({ error: 'fixed_probe_only' }, 400);
    const existing = await dependencies.inspect(c.env);
    if (existing.receipt) return c.json(existing.receipt, 202);
    await dependencies.claim(c.env);
    // Concurrent/lost-response retries converge on one fixed Flue idempotency key.
    const receipt = await dependencies.dispatch();
    await dependencies.bind(c.env, receipt);
    return c.json(receipt, 202);
  });
  app.get('/__probe/model/result', async c => {
    const state = await dependencies.inspect(c.env);
    if (!state.receipt) return c.json({ status: state.claimed ? 'pending' : 'not_started', state }, state.claimed ? 202 : 404);
    try {
      const reply = await dependencies.read(state.receipt);
      return c.json({ status: 'completed', synthetic: true, externalCustomerMessagesSent: 0, reply: reply.text, state: await dependencies.inspect(c.env) });
    } catch (error) {
      if (error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name)) return c.json({ status: 'pending', state }, 202);
      return c.json({ status: 'failed', state }, 409);
    }
  });
  if (dependencies.ozon) {
    app.post('/__probe/ozon/run', async c => {
      if ((await c.req.text()).trim() || new URL(c.req.url).search) return c.json({ error: 'fixed_probe_only' }, 400);
      return c.json(await dependencies.ozon!.run(c.env));
    });
    app.get('/__probe/ozon/result', async c => c.json(await dependencies.ozon!.result(c.env)));
  }
  app.onError(error => error instanceof HTTPException ? error.getResponse() : Response.json({ error: 'external_probe_failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } }));
  return app;
}
