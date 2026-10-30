import { timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { getWorld } from 'durable-harness';
import { openWorldReader, resumeWith, type WorldStorage } from 'durable-harness/pi-durable';
import { createFixture } from './fixture.ts';

const observationStream = 'dingbell-fixture-observations';
export const receiptStream = 'dingbell-fixture-receipt';
export const recoverAfterMs = 20_000;
const gateDurationMs = 30_000;

export function authorized(request: Request): boolean {
  const expected = process.env.PI_PROBE_TOKEN;
  const actual = request.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!expected || expected.length < 32 || !actual) return false;
  const supplied = Buffer.from(actual), configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

export function validSession(value: unknown): value is string {
  return typeof value === 'string' && /^wrun_[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

async function openFixture(storage: WorldStorage) {
  const run = await storage.world.runs.get(storage.sessionId);
  const releaseAt = run.createdAt.getTime() + gateDurationMs;
  const openerId = crypto.randomUUID();
  const fixture = createFixture(async ({ action, callId, signal }) => {
    // An independent observation stream counts actual calls, not journaled tool results.
    await storage.world.streams.write(storage.sessionId, observationStream, JSON.stringify({
      observationId: crypto.randomUUID(), action, callId, openerId,
      deployment: process.env.VERCEL_DEPLOYMENT_ID, at: Date.now(),
    }));
    if (action === 'wait') await delay(Math.max(0, releaseAt - Date.now()), undefined, { signal });
  });
  return fixture.open(storage);
}

// Both the request and the platform queue import this exact opener.
export const open = resumeWith(openFixture, { maxDriveMs: 45_000, traceAudience: 'private' });

export interface Observation {
  observationId: string; action: 'model' | 'prepare' | 'wait'; callId: string;
  openerId: string; deployment: string; at: number;
}

export async function inspect(sessionId: string) {
  // This reader cannot take ownership or resume work; only the queue can finish a crashed turn.
  const reader = openWorldReader(sessionId);
  await reader.refresh();
  const state = await reader.snapshot();
  const world = await getWorld();
  const observations: Observation[] = [];
  const streams = await world.streams.list(sessionId);
  if (streams.includes(observationStream)) {
    const chunks = await world.streams.getChunks(sessionId, observationStream, { limit: 100 });
    if (chunks.hasMore) throw new Error('Fixture exceeded its observation bound.');
    const seen = new Set<string>();
    for (const chunk of chunks.data) {
      const value = JSON.parse(new TextDecoder().decode(chunk.data)) as Observation;
      if (!seen.has(value.observationId)) { seen.add(value.observationId); observations.push(value); }
    }
  }
  let receipt: unknown;
  if (streams.includes(receiptStream)) {
    const chunks = await world.streams.getChunks(sessionId, receiptStream, { limit: 2 });
    if (chunks.data.length !== 1 || chunks.hasMore) throw new Error('Unexpected fixture receipt count.');
    receipt = JSON.parse(new TextDecoder().decode(chunks.data[0]!.data)) as unknown;
  }
  return { ...state, observations, receipt, deployment: process.env.VERCEL_DEPLOYMENT_ID, node: process.version };
}
