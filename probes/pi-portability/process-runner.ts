import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createFixture, context, model, summarize } from './fixture.ts';
import type { Harness } from '@earendil-works/pi-durable';
import { setTimeout as delay } from 'node:timers/promises';

const [backend, mode, directory, gateOrigin, originalId] = process.argv.slice(2);
if (!['sqlite', 'world'].includes(backend) || !directory || !gateOrigin) throw new Error('Invalid probe arguments.');
const gate = new URL(gateOrigin);
if (gate.protocol !== 'http:' || gate.hostname !== '127.0.0.1') throw new Error('Probe gate must be loopback.');
const fixture = createFixture(async ({ action, callId, signal }) => {
  const response = await fetch(new URL(`/${action}/${encodeURIComponent(callId)}`, gate), { signal, redirect: 'error' });
  if (!response.ok) throw new Error(`Gate rejected ${action}.`);
  await response.text();
});
let world: { close?(): Promise<void> } | undefined;
let harness: Harness;
let sessionId: string | undefined;
if (backend === 'sqlite') {
  harness = await fixture.open(await openNodeSqliteStorage(`${directory}/agent.sqlite`));
} else {
  const { createWorld } = await import('@workflow/world-local');
  const { openWorldStorage, openWorldReader, resumeWith } = await import('durable-harness/pi-durable');
  const local = createWorld({ dataDir: directory, recoverActiveRuns: mode === 'queue-resume' });
  world = local;
  const open = resumeWith(storage => fixture.open(storage), { world: local });
  if (mode === 'queue-resume') {
    const originalSession = process.env.DINGBELL_WORLD_SESSION;
    if (!originalSession) throw new Error('Queue recovery requires the original World session.');
    const { registerQueue } = await import('durable-harness');
    registerQueue(local);
    if (!local.start) throw new Error('The selected World has no startup recovery hook.');
    await local.start();
    // This reader never opens a Harness or calls resume: only the registered queue can finish the run.
    const reader = openWorldReader(originalSession, { world: local });
    const end = Date.now() + 20_000;
    let unfinished = true;
    while (Date.now() < end) {
      await reader.refresh();
      unfinished = (await reader.snapshot()).unfinished;
      if (!unfinished) break;
      await delay(50);
    }
    if (unfinished) throw new Error('World startup queue did not recover the original run.');
    const recovered = await reader.snapshot();
    if (recovered.eventCount === 0 || recovered.commits === 0
      || recovered.entries.filter(entry => entry.kind === 'pi.user').length !== 1
      || !JSON.stringify(recovered.entries).includes('fixture-ok')) {
      throw new Error('Passive reader must observe a populated, completed original transcript before reopening a Harness.');
    }
  }
  const storage = await openWorldStorage(process.env.DINGBELL_WORLD_SESSION, { world: local });
  sessionId = storage.sessionId;
  harness = await open(storage);
}
try {
  const root = await harness.root(context, { agent: { model } });
  if (mode === 'resume' || mode === 'queue-resume') {
    if (!originalId) throw new Error('Resume needs the original receipt.');
    if (mode === 'resume') harness.resume();
    process.send?.({ type: 'result', ...await summarize(harness, originalId), sessionId, recoveredByQueue: mode === 'queue-resume' });
  } else {
    const draft = { type: 'input' as const, content: 'synthetic-fixture-input', requestId: 'stable-fixture-input' };
    const [first, duplicate] = await Promise.all([root.submit(draft, context), root.submit(draft, context)]);
    let conflictingPayload: 'accepted_as_original' | 'rejected';
    try {
      const conflict = await root.submit({ ...draft, content: 'different-synthetic-content' }, context);
      if (conflict.id !== first.id) throw new Error('Conflicting key appended another submission.');
      conflictingPayload = 'accepted_as_original';
    } catch { conflictingPayload = 'rejected'; }
    process.send?.({ type: 'accepted', submissionId: String(first.id), duplicateId: String(duplicate.id), conflictingPayload, sessionId });
    process.on('message', async message => {
      if (message === 'abort') await root.abort(context);
    });
    process.send?.({ type: 'result', ...await summarize(harness, String(first.id)), sessionId });
  }
} finally {
  await harness.close(context);
  await world?.close?.();
  process.disconnect?.();
}
