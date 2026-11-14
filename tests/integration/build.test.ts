import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const distribution = resolve(process.env.DINGBELL_TEST_DIST ?? fileURLToPath(new URL('../../dist/', import.meta.url)));
const output = join(distribution, 'dingbell');
const clientOutput = join(distribution, 'client');
const probeMarkers = ['SUPPORT_TRANSPORT_BOUND', 'DINGBELL_SUPPORT_TOKEN', 'support-runtime-fixture', 'synthetic support policy failed', 'ReplyQualityEvaluation', 'REPLY_QUALITY_EXPLICIT_SELECTION_REQUIRED', 'dingbell-reply-quality-200-v1', 'DINGBELL_TEST_ANSWER_TOKEN', '/__test/answer', 'synthetic answer seed missing', 'reply-test-runtime-fixture', 'REPLY_TEST_TRANSPORT_BOUND', 'DINGBELL_REPLY_TEST_GATE', 'DINGBELL_REPLY_TEST_TOKEN', 'DINGBELL_TEST_KNOWLEDGE_TOKEN', '/__test/knowledge', 'TestKnowledgeReviewWorkflow', 'TestKnowledgeIndexWorkflow', '/__fixture/', 'test_index_gate', 'synthetic-never-real', 'TestConversationController', 'test:faults', 'synthetic projection failure', 'DINGBELL_TEST_STORE_CHECKER', 'Unexpected synthetic connector destination', 'dingbell-test-mailbox', 'DINGBELL_TEST_MAILBOX', 'dingbell-fixture', 'dingbell-identity-probe', 'dingbell-application-identity-test', 'dingbell-platform-probe', 'fixture-ok', 'probeInterrupt', 'probeDestroy', 'probeObserverFailure', 'PlatformProbeState', 'NvidiaSyntheticProbe', 'NvidiaEvaluation', 'lookup_test_order', 'nvidia-probe-fixture', 'DINGBELL_KNOWLEDGE_EVAL', 'synthetic-semantic-company', 'dingbell-semantic-ru-zh-v1'];

probeMarkers.push('DINGBELL_TEST_AI_DRAFT_TOKEN', '/__test/ai-draft', 'synthetic AI draft setup failed');

test('the production build excludes local credential files', async () => {
  const entries = await readdir(distribution, { recursive: true });
  const credentialFiles = entries.filter(entry => /^\.(?:env|dev\.vars)(?:\.|$)/.test(entry.split(/[\\/]/).at(-1)!));
  assert.deepEqual(credentialFiles, []);
});

test('the production build excludes the isolated test agent and its HTTP endpoints', async () => {
  const config = JSON.parse(await readFile(join(output, 'wrangler.json'), 'utf8'));
  assert.equal(config.name, 'dingbell');
  for (const marker of ['HandoffToolFixture', 'TestKnowledgeReviewWorkflow', 'TestKnowledgeIndexWorkflow', 'TestConversationController', 'PlatformProbeState', 'NvidiaSyntheticProbe']) {
    assert.equal(JSON.stringify(config).includes(marker), false);
  }

  for (const entry of await readdir(output, { recursive: true })) {
    if (!entry.endsWith('.js')) continue;
    const source = await readFile(join(output, entry), 'utf8');
    for (const marker of [...probeMarkers, 'HandoffToolFixture', 'dingbell-handoff-tool-fixture']) {
      assert.equal(source.includes(marker), false, `${marker} leaked into ${entry}`);
    }
  }
});

test('the production Worker serves indexed text knowledge without retired vector workflows or paid defaults', async () => {
  const config = JSON.parse(await readFile(join(output, 'wrangler.json'), 'utf8'));
  assert.deepEqual(config.workflows ?? [], []);
  for (const flag of ['OUTBOUND_ENABLED', 'AI_OUTBOUND_ENABLED']) assert.equal(config.vars?.[flag], 'false');
  const worker = await readFile(resolve(output, config.main), 'utf8');
  // The production reply chain reads published text documents directly; the old
  // FTS helper is evaluation-only and is not part of the Worker graph.
  assert.match(worker, /knowledge_document/);
  assert.match(worker, /knowledge_revision/);
  assert.doesNotMatch(worker, /KnowledgeIndexWorkflow|KnowledgeReviewWorkflow/);
});

test('the generated Worker serves only the client directory and handles API routes before SPA fallback', async () => {
  const config = JSON.parse(await readFile(join(output, 'wrangler.json'), 'utf8'));
  assert.equal(config.name, 'dingbell');
  assert.equal(typeof config.main, 'string');
  assert.ok((await readFile(resolve(output, config.main))).length > 0, 'the Worker entry remains built');
  assert.equal(typeof config.assets?.directory, 'string', 'the Worker must declare a separate client assets directory');
  assert.equal(resolve(output, config.assets.directory), clientOutput);
  assert.equal(config.assets.not_found_handling, 'single-page-application');
  const workerFirst: unknown = config.assets.run_worker_first;
  assert.ok(workerFirst === true || (Array.isArray(workerFirst) && workerFirst.includes('/api') && workerFirst.includes('/api/*')),
    'both /api and its descendants must reach the Worker instead of the SPA fallback');
});

test('the client build includes an HTML entry and locally built browser modules', async () => {
  const clientEntries: string[] = await readdir(clientOutput).catch(() => []);
  assert.ok(clientEntries.includes('index.html'), 'the production client must contain index.html');
  const html = await readFile(join(clientOutput, 'index.html'), 'utf8');
  const moduleURLs = [...html.matchAll(/<script\b(?=[^>]*\btype=["']module["'])[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)].map(match => match[1]!);
  assert.ok(moduleURLs.length > 0, 'the HTML entry must load its browser application module');
  for (const moduleURL of moduleURLs) {
    assert.match(moduleURL, /^\/assets\/[^?#]+\.js$/, 'application modules must be built into local client assets');
    const path = resolve(clientOutput, `.${moduleURL}`);
    assert.ok(!relative(clientOutput, path).startsWith(`..${sep}`), 'the client entry must not load Worker assets');
    assert.ok((await readFile(path)).length > 0, 'the referenced browser application module must exist');
  }
});

test('the production Worker contains the persistent sync coordinator binding, migration and repair schedule', async () => {
  const config = JSON.parse(await readFile(join(output, 'wrangler.json'), 'utf8'));
  assert.ok(config.durable_objects?.bindings?.some((binding: {name:string;class_name:string}) => binding.name === 'STORE_COORDINATOR' && binding.class_name === 'StoreCoordinator'));
  assert.ok(config.migrations?.some((migration: {new_sqlite_classes?:string[]}) => migration.new_sqlite_classes?.includes('StoreCoordinator')));
  assert.deepEqual(config.triggers?.crons, ['* * * * *']);
  assert.match(await readFile(resolve(output, config.main), 'utf8'), /StoreCoordinator/);
});

test('the production Worker deploys conversation control alongside the existing coordinator', async () => {
  const config = JSON.parse(await readFile(join(output, 'wrangler.json'), 'utf8'));
  assert.ok(config.durable_objects?.bindings?.some((binding: {name:string;class_name:string}) => binding.name === 'CONVERSATION_CONTROLLER' && binding.class_name === 'ConversationController'));
  assert.ok(config.migrations?.some((migration: {tag:string;new_sqlite_classes?:string[]}) => migration.tag === 'v2' && migration.new_sqlite_classes?.includes('ConversationController')));
  assert.ok(config.migrations?.some((migration: {tag:string;new_sqlite_classes?:string[]}) => migration.tag === 'v1' && migration.new_sqlite_classes?.includes('StoreCoordinator')));
  assert.match(await readFile(resolve(output, config.main), 'utf8'), /ConversationController/);
});

test('the production Worker adds a separate Pi Agent without replacing existing durable classes', async () => {
  const config = JSON.parse(await readFile(join(output, 'wrangler.json'), 'utf8'));
  assert.ok(config.durable_objects?.bindings?.some((binding: {name:string;class_name:string}) => binding.name === 'PI_AGENT' && binding.class_name === 'PiAgentObject'));
  assert.deepEqual(config.migrations, [
    {tag:'v1',new_sqlite_classes:['StoreCoordinator']},
    {tag:'v2',new_sqlite_classes:['ConversationController']},
    {tag:'v3',new_sqlite_classes:['FlueReplyPreviewAgent']},
    {tag:'v4',new_sqlite_classes:['FlueReplyTestAgent']},
    {tag:'v5',new_sqlite_classes:['FlueSupportAgent']},
    {tag:'v6',new_sqlite_classes:['PiAgentObject']},
    {tag:'v7',renamed_classes:[
      {from:'FlueReplyPreviewAgent',to:'LegacyReplyPreviewArchive'},
      {from:'FlueReplyTestAgent',to:'LegacyReplyTestArchive'},
      {from:'FlueSupportAgent',to:'LegacySupportArchive'},
    ]},
  ]);
  assert.ok(config.assets.run_worker_first.includes('/agents') && config.assets.run_worker_first.includes('/agents/*'));
  assert.match(await readFile(resolve(output, config.main), 'utf8'), /LegacyReplyPreviewArchive/);
});

test('retired agents retain migration history without active legacy runtime bindings', async () => {
  const config = JSON.parse(await readFile(join(output, 'wrangler.json'), 'utf8'));
  assert.deepEqual(config.durable_objects.bindings.map((binding: { name: string }) => binding.name).sort(), ['CONVERSATION_CONTROLLER', 'PI_AGENT', 'STORE_COORDINATOR']);
  const worker = await readFile(resolve(output, config.main), 'utf8');
  for (const historical of ['LegacyReplyPreviewArchive', 'LegacyReplyTestArchive', 'LegacySupportArchive']) assert.ok(worker.includes(historical));
  for (const removed of ['FlueReplyPreviewAgent', 'FlueReplyTestAgent', 'FlueSupportAgent']) assert.equal(worker.includes(removed), false);
  assert.doesNotMatch(worker, /REPLY_TEST_ENABLED|REPLY_TEST_CONFIG_JSON|KNOWLEDGE_INDEXING_ENABLED/);
});

test('production Support has a separate native binding and remains disabled by default',async()=>{
  const config=JSON.parse(await readFile(join(output,'wrangler.json'),'utf8'));
  assert.ok(config.durable_objects?.bindings?.some((b:{name:string;class_name:string})=>b.name==='PI_AGENT'&&b.class_name==='PiAgentObject'));
  assert.deepEqual(config.r2_buckets??[],[]);
  const worker=await readFile(resolve(output,config.main),'utf8');assert.match(worker,/LegacySupportArchive/);assert.match(worker,/handoff-brief/);assert.match(worker,/handoff-reviews/);assert.match(worker,/handoff-items/);assert.match(worker,/conversation\/activity|\/activity/);assert.match(worker,/conversation-activities/);assert.match(worker,/conversation-timeline|\/timeline/);assert.match(worker,/exports\/csv/);assert.match(worker,/analytics\/overview/);assert.match(worker,/data-governance/);assert.match(worker,/companies\/:companyId\/degradation|\/degradation/);
});

test('browser assets exclude server implementations, database schema and isolated probes', async () => {
  const entries: string[] = await readdir(clientOutput, { recursive: true }).catch(() => []);
  const scripts = entries.filter(entry => /\.(?:[cm]?js|map)$/.test(entry));
  assert.ok(scripts.length > 0, 'the client build must have browser assets to inspect');
  assert.equal(entries.some(entry => /(?:^|[\\/])wrangler\.json$|\.sql$/.test(entry)), false,
    'Worker configuration and SQL migrations must not be served as public client assets');
  const serverPaths = [
    /src\/modules\/(?:identity\/(?:services|schema|config|http)|audit\/(?:operation|schema)|membership\/(?:http|storage)|(?:company-settings|reply-policies)\/(?:http|storage|schema)|stores\/(?:credentials|schema|http|storage|ozon)|sync\/(?:bindings|coordinator|http|runner|storage|schema)|conversations\/(?:schema|ozon|read|context|images|http|controller|control-storage|control-state|control-http|control-bindings)|(?:knowledge|reply-tests)\/[^/]+|(?:products|orders)\/(?:ozon|schema|storage|sync-seed|runner)|ozon\/read)\.[cm]?[jt]s\b/,
    /node_modules\/(?:@better-auth\/drizzle-adapter|drizzle-orm\/d1)\//,
    /node_modules\/better-auth\/(?:dist\/(?:api|db|plugins|adapters|context|cookies|minimal)\b|minimal\b)/,
  ];
  // The bare Seller hostname is public shared image-URL validation, not an API client.
  // Keep full provider URLs/server implementations forbidden; the message-image
  // browser regression independently verifies all image requests stay same-origin.
  for (const entry of scripts) {
    const source = await readFile(join(clientOutput, entry), 'utf8');
    for (const path of serverPaths) assert.doesNotMatch(source, path, `server implementation leaked into ${entry}`);
    for (const marker of [...probeMarkers, 'dingbell_support_generation', 'SUPPORT_SECRET_UNAVAILABLE', 'bootstrap_installation', 'invitation_flow', 'identity_audit_event', 'company_settings_audit_event', 'company_settings_version_valid', 'identity_audit_request_idx', 'identity_audit_organization_time_idx', 'store_audit_event', 'credential_ciphertext', 'STORE_CREDENTIAL_KEYS', 'store_sync', 'store_coordinator', 'sync_cursor', 'conversation_control', 'ConversationController', 'CONVERSATION_CONTROLLER', 'product_source_snapshot', 'fbs_sync_window', 'fbs_posting_observation', 'detail_epoch', 'ingest_event', 'https://api-seller.ozon.ru', 'reply_test_query', 'REPLY_TEST_QUERY_CONFIG_JSON', 'REPLY_TEST_CONFIG_JSON', 'reply_test_run', 'reply_test_budget', 'REPLY_TEST_ENABLED', 'budget_reconciliation_state', 'NVAPI_KEY', 'integrate.api.nvidia.com']) {
      assert.equal(source.includes(marker), false, `${marker} leaked into browser asset ${entry}`);
    }
  }
});
