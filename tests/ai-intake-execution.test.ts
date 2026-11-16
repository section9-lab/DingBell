import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationControlFixture } from './fixtures/conversation-control.ts';
import { createPolicy, changePolicy } from '../src/modules/reply-policies/storage.ts';
import { claimAiDispatches } from '../src/modules/ai-runs/dispatch.ts';
import { claimInboundEvents, finishInboundEvent } from '../src/modules/conversations/inbound-delivery.ts';
import { executeAiRun, type SupportRuntime } from '../src/modules/ai-runs/execution.ts';

const deploymentConfig = {
  maxGenerations: 6,
  model: {
    provider: 'nvidia', model: 'nvidia/nemotron-3.5-super-vl-120b-a12b', modelConfigVersion: 'support-v1',
    promptVersion: 'support-reply-v2', maxInputTokens: 262144, maxOutputTokens: 2048,
    pricing: { version: 'synthetic', currency: 'USD', inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000,
      cacheReadMicrosPerMillion: 1_000_000, cacheWriteMicrosPerMillion: 1_000_000 },
  },
};

/** The intake path is the one a real Ozon callback uses: queue, admission, then a reserved execution. */
test('a queued intake run reserves an execution and reaches the runtime', { timeout: 30_000 }, async t => {
  const f = await conversationControlFixture();
  t.after(f.close);
  const actor = { ...f.actor(), expectedMemberId: 'owner-member' };
  await f.db.prepare("UPDATE store SET status='verified'").run();
  const policyId = crypto.randomUUID();
  const config = { kind: 'automatic' as const, name: 'Reception', storeIds: [], priority: 50, stage: 'presale' as const,
    mode: 'automatic' as const, language: 'customer' as const, tone: 'concise' as const, instructions: '' };
  assert.ok(await createPolicy(f.db, actor, policyId, config));
  assert.ok(await changePolicy(f.db, actor, policyId, 1, { action: 'test' }, crypto.randomUUID()));
  assert.ok(await changePolicy(f.db, actor, policyId, 2, { action: 'publish' }, crypto.randomUUID()));

  const controller = { readAiWork: async (scope: any, runId: string) => (await f.call('ai-work-read', { runId }, scope)).body } as any;
  const env = {
    DB: f.db,
    NVAPI_KEY: 'synthetic-only',
    AGENT_RUNTIME: {} as any,
    AI_RECEPTION_CONFIG_JSON: JSON.stringify(deploymentConfig),
    AI_OUTBOUND_ENABLED: 'true',
    OUTBOUND_ENABLED: 'true',
    CONVERSATION_CONTROLLER: { idFromName: (id: string) => id, get: () => controller } as any,
  } as any;

  let clock = Date.now();
  const id = crypto.randomUUID(), now = ++clock;
  await f.db.batch([
    f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES(?,'org','store','conv',?,'Customer','inbound','[\"Есть ли зелёные шапки?\"]',0,0,?,?,'incremental')").bind(id, id, now, now),
    f.db.prepare("INSERT INTO ingest_event(id,organization_id,store_id,conversation_id,message_id,state,live_observed_at,trace_id,created_at) VALUES(?,'org','store','conv',?,'pending',?,'synthetic',?)").bind(id, id, now, now),
  ]);
  const [inboundClaim] = await claimInboundEvents(f.db, Date.now());
  assert.equal((await f.call('inbound', { eventId: inboundClaim.eventId })).body.outcome, 'accepted');
  await finishInboundEvent(f.db, inboundClaim, 'accepted', Date.now(), true);
  const input = { eventId: inboundClaim.eventId };
  const [claim] = await claimAiDispatches(f.db, Date.now());
  assert.ok(claim, 'the inbound acknowledgement must queue one dispatch');
  assert.equal(input.eventId, claim.eventId);
  const admitted = await f.call('ai-dispatch-admit', { request: { eventId: claim.eventId, runId: claim.runId } });
  assert.equal(admitted.body.outcome, 'accepted');

  const prepared: string[] = [];
  const runtime = {
    lookup: async () => null,
    inspect: async () => null,
    prepare: async (run: any) => { prepared.push(run.id); throw new Error('stop before any provider call'); },
  } as unknown as SupportRuntime;
  const result = await executeAiRun(env, f.scope, claim.runId, { runtime });
  assert.equal(result.status, 'unconfirmed', 'the run must reach the runtime instead of being refused');
  assert.equal(prepared.length, 1);
  assert.equal(await f.db.prepare('SELECT count(*) n FROM ai_execution').first('n'), 1);
});
