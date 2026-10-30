import { openWorldStorage } from 'durable-harness/pi-durable';
import { context, model, summarize } from '../fixture.ts';
import { authorized, open, receiptStream, recoverAfterMs, validSession } from '../vercel-adapter.ts';

export async function POST(request: Request) {
  if (!authorized(request)) return new Response('Unauthorized', { status: 401 });
  const input = await request.json() as { sessionId?: unknown };
  if (!validSession(input.sessionId)) return new Response('Invalid session', { status: 400 });
  const storage = await openWorldStorage(input.sessionId, { recoverAfterMs });
  const harness = await open(storage);
  const root = await harness.root(context, { agent: { model } });
  const draft = { type: 'input' as const, content: 'synthetic-fixture-input', requestId: 'stable-fixture-input' };
  const [first, duplicate] = await Promise.all([root.submit(draft, context), root.submit(draft, context)]);
  const conflict = await root.submit({ ...draft, content: 'different-synthetic-content' }, context);
  await storage.world.streams.write(storage.sessionId, receiptStream, JSON.stringify({ submissionId: String(first.id),
    duplicateId: String(duplicate.id), conflictId: String(conflict.id), deployment: process.env.VERCEL_DEPLOYMENT_ID }));
  // The platform's ten-second limit must interrupt the thirty-second tool gate.
  // Return no response and do not explicitly close, abort or resubmit to manufacture recovery.
  const result = await summarize(harness, String(first.id));
  await harness.close(context);
  return Response.json({ unexpectedCompletion: true, result });
}
