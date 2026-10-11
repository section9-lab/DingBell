import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import type { FixtureJob, PlatformEnv } from './cloudflare.ts';

const app = new Hono<{ Bindings: PlatformEnv }>();
const runIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

app.get('/api/health', context => context.json({ service: 'dingbell-platform-probe' }));
app.use('/__probe/*', async (context, next) => {
  await next();
  context.header('Cache-Control', 'no-store');
});
app.use('/__probe/*', async (context, next) => {
  if (!context.env.PROBE_TOKEN) return context.json({ error: 'Probe secret is not configured.' }, 503);
  return bearerAuth<{ Bindings: PlatformEnv }>({ token: context.env.PROBE_TOKEN })(context, next);
});

app.on(['PUT', 'GET', 'HEAD', 'DELETE'], '/__probe/r2/:runId', async context => {
  const runId = context.req.param('runId');
  if (!runIdPattern.test(runId)) return context.json({ error: 'A fixture UUID v4 is required.' }, 400);
  const bucket = context.env.PROBE_BUCKET;
  if (!bucket) return context.json({ error: 'R2 is not enabled for this probe deployment.' }, 503);
  const key = `synthetic/${runId}/fixture.txt`;
  const method = context.req.method;
  if (method === 'PUT') {
    const payload = new TextEncoder().encode(`DingBell synthetic platform fixture ${runId}\n`);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', payload)), byte => byte.toString(16).padStart(2, '0')).join('');
    await bucket.put(key, payload, { customMetadata: { sha256 }, httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
    return context.json({ key, sha256, size: payload.byteLength }, 201);
  }
  if (method === 'DELETE') {
    await bucket.delete(key);
    return context.body(null, 204);
  }
  const object = method === 'HEAD' ? await bucket.head(key) : await bucket.get(key);
  if (!object) return context.body(null, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('content-length', String(object.size));
  headers.set('x-probe-sha256', object.customMetadata?.sha256 ?? '');
  return new Response(method === 'HEAD' ? null : (object as R2ObjectBody).body, { headers });
});

app.post('/__probe/jobs', async context => {
  let value: { runId?: unknown; key?: unknown; behavior?: unknown; copies?: unknown };
  try { value = await context.req.json(); } catch { return context.json({ error: 'A JSON fixture is required.' }, 400); }
  if (!value || typeof value.runId !== 'string' || !runIdPattern.test(value.runId)
    || typeof value.key !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(value.key)
    || typeof value.behavior !== 'string' || !['once', 'retry-once', 'poison'].includes(value.behavior)
    || typeof value.copies !== 'number' || !Number.isInteger(value.copies) || value.copies < 1 || value.copies > 5) {
    return context.json({ error: 'Invalid synthetic job fixture.' }, 400);
  }
  const job: FixtureJob = { version: 1, runId: value.runId, key: value.key, behavior: value.behavior as FixtureJob['behavior'] };
  await context.env.PROBE_QUEUE.sendBatch(Array.from({ length: value.copies }, () => ({ body: job })));
  return context.json({ runId: job.runId, key: job.key, enqueued: value.copies }, 202);
});

app.get('/__probe/runs/:runId', async context => {
  const runId = context.req.param('runId');
  if (!runIdPattern.test(runId)) return context.json({ error: 'A fixture UUID v4 is required.' }, 400);
  const state = context.env.PROBE_STATE.get(context.env.PROBE_STATE.idFromName(`run:${runId}`));
  return context.json(await state.jobs());
});

app.get('/__probe/cron', async context => {
  const state = context.env.PROBE_STATE.get(context.env.PROBE_STATE.idFromName('cron'));
  return context.json(await state.cron());
});

export default app;
