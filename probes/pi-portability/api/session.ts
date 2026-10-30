import { openWorldStorage } from 'durable-harness/pi-durable';
import { getWorld } from 'durable-harness';
import { context, summarize } from '../fixture.ts';
import { authorized, inspect, open, recoverAfterMs, validSession } from '../vercel-adapter.ts';

export async function POST(request: Request) {
  if (!authorized(request)) return new Response('Unauthorized', { status: 401 });
  const body = await request.json().catch(() => ({})) as { sessionId?: unknown; submissionId?: unknown };
  if (body.sessionId !== undefined) {
    if (!validSession(body.sessionId) || typeof body.submissionId !== 'string') return new Response('Invalid receipt', { status: 400 });
    const harness = await open(await openWorldStorage(body.sessionId));
    try { return Response.json(await summarize(harness, body.submissionId), { headers: { 'cache-control': 'no-store' } }); }
    finally { await harness.close(context); }
  }
  const storage = await openWorldStorage(undefined, { recoverAfterMs, traceAudience: 'private' });
  const sessionId = storage.sessionId;
  await storage.close(context);
  return Response.json({ sessionId }, { status: 201, headers: { 'cache-control': 'no-store' } });
}

export async function DELETE(request: Request) {
  if (!authorized(request)) return new Response('Unauthorized', { status: 401 });
  const sessionId = new URL(request.url).searchParams.get('sessionId');
  if (!validSession(sessionId)) return new Response('Invalid session', { status: 400 });
  const world = await getWorld();
  await world.events.create(sessionId, { eventType: 'run_cancelled' });
  return new Response(null, { status: 204 });
}

export async function GET(request: Request) {
  if (!authorized(request)) return new Response('Unauthorized', { status: 401 });
  const sessionId = new URL(request.url).searchParams.get('sessionId');
  if (!validSession(sessionId)) return new Response('Invalid session', { status: 400 });
  return Response.json(await inspect(sessionId), { headers: { 'cache-control': 'no-store' } });
}
