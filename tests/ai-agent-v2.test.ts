import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import { aiAnswerFixture } from './fixtures/ai-answer.ts';
import { aiSendMessageInputSchema } from '../src/modules/conversations/send-message-tool.ts';
import { createBashTool } from '../src/modules/conversations/knowledge-agent-tool.ts';
import { discoverAiKnowledge, readAiKnowledgeFile, readRunKnowledgeEvidence } from '../src/modules/ai-runs/text-knowledge.ts';
import { recordAiProductFact } from '../src/modules/ai-runs/fact-evidence.ts';
import { prepareAiMessage } from '../src/modules/ai-runs/message-intent.ts';
import { encryptCredentials } from '../src/modules/stores/credentials.ts';
import { bindAiExecutionReceipt, claimAiGeneration, settleAiGeneration, closeAiExecution } from '../src/modules/ai-runs/storage.ts';
import { waitAiSend } from './fixtures/ai-send.ts';

async function fixture() {
  const x = await aiAnswerFixture('support-reply-v2', { outboundEnabled: 'true', aiOutboundEnabled: 'true' });
  const key = await encryptCredentials(x.f.credentialEnv, { orgId: 'org', storeId: 'store', platformStoreId: '1', credentialVersion: 1 }, { apiKey: 'synthetic-ozon-key' });
  await x.f.db.prepare("UPDATE store SET outbound_enabled=1,credential_key_version=?,credential_nonce=?,credential_ciphertext=?,capabilities=?,expires_at=? WHERE id='store'")
    .bind(key.keyVersion, key.nonce, key.ciphertext, JSON.stringify([{ code: 'auth', status: 'available' }, { code: 'reply', status: 'available' }]), Date.now() + 3_600_000).run();
  const env = { ...x.env, AI_OUTBOUND_ENABLED: 'true', OUTBOUND_ENABLED: 'true' };
  return { ...x, env };
}

test('send_message requires at least one evidence reference and keeps citations and facts separate', () => {
  assert.equal(v.is(aiSendMessageInputSchema, { body: 'Ответ' }), false);
  assert.equal(v.is(aiSendMessageInputSchema, { body: 'Ответ', citations: [], facts: [] }), false);
  assert.equal(v.is(aiSendMessageInputSchema, { body: 'Ответ', citations: [crypto.randomUUID()] }), true);
  assert.equal(v.is(aiSendMessageInputSchema, { body: 'Ответ', facts: [crypto.randomUUID()] }), true);
  assert.equal(v.is(aiSendMessageInputSchema, { body: 'Ответ', facts: [crypto.randomUUID(), crypto.randomUUID()] }), true);
  assert.equal(v.is(aiSendMessageInputSchema, { body: 'Ответ', citations: [crypto.randomUUID(), crypto.randomUUID()], facts: [] }), true);
  const duplicate = crypto.randomUUID();
  assert.equal(v.is(aiSendMessageInputSchema, { body: 'Ответ', citations: [duplicate, duplicate] }), false);
  assert.equal(v.is(aiSendMessageInputSchema, { body: 'Ответ', citations: Array.from({ length: 11 }, () => crypto.randomUUID()) }), false);
});

test('bash discovery never records evidence, while read freezes the exact document before send_message', { timeout: 30_000 }, async t => {
  const x = await fixture(); t.after(x.f.close);
  const id = x.run.request.runId, path = `/knowledge/${x.documentId}.md`;
  await x.f.db.prepare('DELETE FROM ai_document_evidence WHERE run_id=?').bind(id).run();
  const discovery = await discoverAiKnowledge(x.env, x.read, x.scope, id, { command: `grep -n -F '26' ${path}` });
  assert.equal(discovery.status, 'ok');
  assert.match(discovery.stdout, /26/);
  assert.equal(discovery.canSend, false);
  assert.equal(await readRunKnowledgeEvidence(x.f.db, id), null, 'bash stdout must never become evidence');

  const read = await readAiKnowledgeFile(x.env, x.read, x.scope, id, { path });
  assert.equal(read.status, 'found');
  assert.equal(read.document?.documentId, x.documentId);
  assert.equal(read.canSend, false);
  const evidence = await readRunKnowledgeEvidence(x.f.db, id);
  assert.ok(evidence);
  assert.equal(JSON.parse(evidence.raw).length, 1);

  const prepared = await prepareAiMessage(x.env, x.read, x.scope, id, { body: 'Ширина этой модели — 26 см.', citations: [x.documentId] });
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.canSend, false);
  assert.equal(prepared.sent, false);
});

test('a fact-only send_message is backed by a current product snapshot and is rejected after it changes', { timeout: 30_000 }, async t => {
  const x = await fixture(); t.after(x.f.close);
  const id = x.run.request.runId;
  await x.f.db.prepare("UPDATE message SET sku='5787036301' WHERE id='question'").run();
  await x.f.db.prepare("INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,detail_epoch,detail_generation,detail_due_at,detail_state,facts,facts_observed_at) VALUES('p1','org','store',?,1,1,1,0,'complete',?,2)")
    .bind(JSON.stringify({ offerId: 'offer-p1', sku: '5787036301' }), JSON.stringify({ offerId: 'offer-p1', sku: '5787036301', name: 'Повязка', price: '26.80', currency: 'CNY', archived: false, primaryImage: null })).run();

  const fact = await recordAiProductFact(x.env, x.scope, id);
  assert.equal(fact.context.status, 'matched');
  assert.ok(fact.evidenceId);
  const prepared = await prepareAiMessage(x.env, x.read, x.scope, id, { body: 'Эта повязка стоит 26.80 CNY.', citations: [], facts: [fact.evidenceId] });
  assert.equal(prepared.status, 'prepared');

  const changed = await fixture(); t.after(changed.f.close);
  const changedId = changed.run.request.runId;
  await changed.f.db.prepare("UPDATE message SET sku='5787036301' WHERE id='question'").run();
  await changed.f.db.prepare("INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,detail_epoch,detail_generation,detail_due_at,detail_state,facts,facts_observed_at) VALUES('p1','org','store',?,1,1,1,0,'complete',?,2)")
    .bind(JSON.stringify({ offerId: 'offer-p1', sku: '5787036301' }), JSON.stringify({ offerId: 'offer-p1', sku: '5787036301', name: 'Повязка', price: '26.80', currency: 'CNY', archived: false, primaryImage: null })).run();
  const stale = await recordAiProductFact(changed.env, changed.scope, changedId);
  assert.ok(stale.evidenceId);
  await changed.f.db.prepare("UPDATE product SET facts=?, facts_observed_at=3 WHERE id='p1'")
    .bind(JSON.stringify({ offerId: 'offer-p1', sku: '5787036301', name: 'Повязка', price: '99.00', currency: 'CNY', archived: false, primaryImage: null })).run();
  const refused = await prepareAiMessage(changed.env, changed.read, changed.scope, changedId, { body: 'Эта повязка стоит 26.80 CNY.', citations: [], facts: [stale.evidenceId] });
  assert.equal(refused.status, 'unavailable');
});

test('send_message rejects a document that this run never read and both evidence lists together stay bounded', { timeout: 30_000 }, async t => {
  const x = await fixture(); t.after(x.f.close);
  const id = x.run.request.runId;
  await x.f.db.prepare('DELETE FROM ai_document_evidence WHERE run_id=?').bind(id).run();
  const unread = await prepareAiMessage(x.env, x.read, x.scope, id, { body: 'Ответ', citations: [crypto.randomUUID()] });
  assert.equal(unread.status, 'unavailable');
  const noEvidence = await prepareAiMessage(x.env, x.read, x.scope, id, { body: 'Ответ', citations: [], facts: [] } as never);
  assert.equal(noEvidence.status, 'unavailable');
});

test('the v2 tools stay scoped to the frozen run and cannot name a document path or SKU', () => {
  const work = {
    schemaVersion: 1 as const,
    scope: { organizationId: 'org', storeId: 'store', conversationId: 'conv', controllerId: 'controller' },
    request: { runId: crypto.randomUUID(), expectedVersion: 0, messageId: 'message', policyId: 'policy', stage: 'presale' as const, language: 'ru' as const },
    admission: { messageId: 'message', inputRevision: 1, question: 'Вопрос', policyId: 'policy', policyRevision: 1,
      policyConfig: { kind: 'automatic' as const, name: 'Support', storeIds: ['store'], priority: 50, stages: ['presale' as const], mode: 'automatic' as const, language: 'customer' as const, tone: 'concise' as const, instructions: '' },
      stage: 'presale' as const, language: 'ru' as const },
    controlEpoch: 1, startedAt: 1, deadlineAt: 60_001,
  };
  const tool = createBashTool(work, { async run() { return { status: 'ok', canSend: false, stdout: '', stderr: '', exitCode: 0 }; } });
  assert.equal(tool.input && v.is(tool.input, { command: 'ls /knowledge' }), true);
  assert.equal(v.is(tool.input, { command: 'ls /knowledge', storeId: 'foreign' }), false);
  assert.equal(v.is(tool.input, { command: 'ls /knowledge', runId: work.request.runId }), false);
});


test('a completed v2 send_message is revalidated at enqueue and delivered once by the shared sender', { timeout: 30_000 }, async t => {
  const x = await fixture(); t.after(x.f.close);
  const id = x.run.request.runId, intentId = 'ai-reply:' + id, path = `/knowledge/${x.documentId}.md`;
  const read = await readAiKnowledgeFile(x.env, x.read, x.scope, id, { path });
  assert.equal(read.status, 'found');
  const prepared = await prepareAiMessage(x.env, x.read, x.scope, id, { body: 'Ширина этой модели — 26 см.', citations: [x.documentId] });
  assert.equal(prepared.status, 'prepared');
  const receipt = { submissionId: id, uid: crypto.randomUUID(), acceptedAt: new Date().toISOString() };
  await bindAiExecutionReceipt(x.f.db, x.scope, id, receipt);
  assert.equal(await claimAiGeneration(x.f.db, x.read, x.scope, id, 1), true);
  await settleAiGeneration(x.f.db, x.scope, id, 1, receipt, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
  await closeAiExecution(x.f.db, x.scope, id, { kind: 'runtime_closed', evidenceId: crypto.randomUUID(), instanceId: 'ai-support:' + id,
    receipt, outcome: 'completed', executionClosed: true, providerPermits: 1, verifiedAt: Date.now() });
  const queued = await x.f.call('ai-reply-enqueue', { runId: id }, x.scope);
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  assert.equal(queued.body.outcome, 'accepted', JSON.stringify(queued.body));
  await waitAiSend(async () => (await x.f.call('reply', { intentId }, x.scope)).body.reply?.status === 'sent');
  assert.deepEqual(x.f.providerRequests, [{ path: '/v1/chat/send/message', body: { chat_id: 'thread', text: 'Ширина этой модели — 26 см.' } }]);
  const sent = await x.f.call('reply', { intentId }, x.scope);
  assert.equal(sent.body.reply.attempt.status, 'sent');
});
