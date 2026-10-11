import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const distribution = fileURLToPath(new URL('../../dist/', import.meta.url));
const output = join(distribution, 'dingbell');
const clientOutput = join(distribution, 'client');
const probeMarkers = ['SUPPORT_TRANSPORT_BOUND', 'DINGBELL_SUPPORT_TOKEN', 'support-runtime-fixture', 'synthetic support policy failed', 'ReplyQualityEvaluation', 'REPLY_QUALITY_EXPLICIT_SELECTION_REQUIRED', 'dingbell-reply-quality-200-v1', 'DINGBELL_TEST_ANSWER_TOKEN', '/__test/answer', 'synthetic answer seed missing', 'reply-test-runtime-fixture', 'REPLY_TEST_TRANSPORT_BOUND', 'DINGBELL_REPLY_TEST_GATE', 'DINGBELL_REPLY_TEST_TOKEN', 'DINGBELL_TEST_KNOWLEDGE_TOKEN', '/__test/knowledge', 'TestKnowledgeReviewWorkflow', 'TestKnowledgeIndexWorkflow', '/__fixture/', 'test_index_gate', 'DINGBELL_TEST_PREVIEW_TOKEN', '/__test/translation', 'synthetic preview not prepared', 'preview-fixture', 'synthetic-never-real', 'DINGBELL_PREVIEW_GATE', 'DINGBELL_PREVIEW_TOKEN', 'PREVIEW_NOT_IMPLEMENTED', 'TestConversationController', 'test:faults', 'synthetic projection failure', 'DINGBELL_TEST_STORE_CHECKER', 'Unexpected synthetic connector destination', 'dingbell-test-mailbox', 'DINGBELL_TEST_MAILBOX', 'dingbell-fixture', 'dingbell-flue-probe', 'dingbell-identity-probe', 'dingbell-application-identity-test', 'dingbell-platform-probe', 'dingbell-flue-schema8-probe', 'dingbell-external-probe', 'fixture-ok', '/__probe', 'probeInterrupt', 'probeDestroy', 'probeObserverFailure', 'ProbeGate', 'BoundedProbe', 'HistoricalProbe', 'PlatformProbeState', 'NvidiaSyntheticProbe', 'FlueExternalProbeAgent', 'NvidiaEvaluation', 'lookup_test_order', 'nvidia-probe-fixture', 'DINGBELL_KNOWLEDGE_EVAL', 'synthetic-semantic-company', 'dingbell-semantic-ru-zh-v1'];

probeMarkers.push('DINGBELL_TEST_AI_DRAFT_TOKEN', '/__test/ai-draft', 'synthetic AI draft setup failed');

test('the production build excludes local credential files', async () => {
  const entries = await readdir(distribution, { recursive: true });
  const credentialFiles = entries.filter(entry => /^\.(?:env|dev\.vars)(?:\.|$)/.test(entry.split(/[\\/]/).at(-1)!));
  assert.deepEqual(credentialFiles, []);
});

test('the production build excludes the isolated test agent and its HTTP endpoints', async () => {
  const config = JSON.parse(await readFile(join(output, 'wrangler.json'), 'utf8'));
  assert.equal(config.name, 'dingbell');
  for (const marker of ['HandoffToolFixture', 'TestKnowledgeReviewWorkflow', 'TestKnowledgeIndexWorkflow', 'TestConversationController', 'FlueProbeAgent', 'FlueBoundedProbeAgent', 'FlueHistoricalProbeAgent', 'ProbeGate', 'PlatformProbeState', 'NvidiaSyntheticProbe', 'FlueExternalProbeAgent']) {
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

test('the production Worker binds the durable knowledge indexer without enabling paid model calls', async () => {
  const config = JSON.parse(await readFile(join(output, 'wrangler.json'), 'utf8'));
  assert.ok(config.workflows?.some((binding: { binding: string; class_name: string }) => binding.binding === 'KNOWLEDGE_WORKFLOW' && binding.class_name === 'KnowledgeIndexWorkflow'));
  assert.ok(config.workflows?.some((binding: { binding: string; class_name: string }) => binding.binding === 'KNOWLEDGE_REVIEW_WORKFLOW' && binding.class_name === 'KnowledgeReviewWorkflow'));
  assert.notEqual(config.vars?.KNOWLEDGE_INDEXING_ENABLED, 'true');
  assert.match(await readFile(resolve(output, config.main), 'utf8'), /KnowledgeIndexWorkflow/);
  assert.match(await readFile(resolve(output, config.main), 'utf8'), /KnowledgeReviewWorkflow/);
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
  assert.notEqual(config.vars?.AI_RECEPTION_ENABLED, 'true');
  assert.ok(config.durable_objects?.bindings?.some((binding: {name:string;class_name:string}) => binding.name === 'CONVERSATION_CONTROLLER' && binding.class_name === 'ConversationController'));
  assert.ok(config.migrations?.some((migration: {tag:string;new_sqlite_classes?:string[]}) => migration.tag === 'v2' && migration.new_sqlite_classes?.includes('ConversationController')));
  assert.ok(config.migrations?.some((migration: {tag:string;new_sqlite_classes?:string[]}) => migration.tag === 'v1' && migration.new_sqlite_classes?.includes('StoreCoordinator')));
  assert.match(await readFile(resolve(output, config.main), 'utf8'), /ConversationController/);
});

test('the production Worker adds a separate translation Agent without replacing existing durable classes', async () => {
  const config = JSON.parse(await readFile(join(output, 'wrangler.json'), 'utf8'));
  assert.ok(config.durable_objects?.bindings?.some((binding: {name:string;class_name:string}) => binding.name === 'FLUE_REPLY_PREVIEW_AGENT' && binding.class_name === 'FlueReplyPreviewAgent'));
  assert.deepEqual(config.migrations, [
    {tag:'v1',new_sqlite_classes:['StoreCoordinator']},
    {tag:'v2',new_sqlite_classes:['ConversationController']},
    {tag:'v3',new_sqlite_classes:['FlueReplyPreviewAgent']},
    {tag:'v4',new_sqlite_classes:['FlueReplyTestAgent']},
    {tag:'v5',new_sqlite_classes:['FlueSupportAgent']},
  ]);
  assert.ok(config.assets.run_worker_first.includes('/agents') && config.assets.run_worker_first.includes('/agents/*'));
  assert.match(await readFile(resolve(output, config.main), 'utf8'), /FlueReplyPreviewAgent/);
});

test('the answer test Agent is separately bound and disabled unless explicitly configured',async()=>{
  const config=JSON.parse(await readFile(join(output,'wrangler.json'),'utf8'));
  assert.ok(config.durable_objects?.bindings?.some((binding:{name:string;class_name:string})=>binding.name==='FLUE_REPLY_TEST_AGENT'&&binding.class_name==='FlueReplyTestAgent'));
  assert.notEqual(config.vars?.REPLY_TEST_ENABLED,'true');
  assert.match(await readFile(resolve(output,config.main),'utf8'),/FlueReplyTestAgent/);
});

test('production Support has a separate native binding and remains disabled by default',async()=>{
  const config=JSON.parse(await readFile(join(output,'wrangler.json'),'utf8'));
  assert.ok(config.durable_objects?.bindings?.some((b:{name:string;class_name:string})=>b.name==='FLUE_SUPPORT_AGENT'&&b.class_name==='FlueSupportAgent'));
  assert.notEqual(config.vars?.AI_RECEPTION_ENABLED,'true');
  assert.match(await readFile(resolve(output,config.main),'utf8'),/FlueSupportAgent/);
});

test('browser assets exclude server implementations, database schema and isolated probes', async () => {
  const entries: string[] = await readdir(clientOutput, { recursive: true }).catch(() => []);
  const scripts = entries.filter(entry => /\.(?:[cm]?js|map)$/.test(entry));
  assert.ok(scripts.length > 0, 'the client build must have browser assets to inspect');
  assert.equal(entries.some(entry => /(?:^|[\\/])wrangler\.json$|\.sql$/.test(entry)), false,
    'Worker configuration and SQL migrations must not be served as public client assets');
  const serverPaths = [
    /src\/modules\/(?:identity\/(?:services|schema|config|http)|audit\/(?:operation|schema)|membership\/(?:http|storage)|(?:company-settings|reply-policies)\/(?:http|storage|schema)|stores\/(?:credentials|schema|http|storage|ozon)|sync\/(?:bindings|coordinator|http|runner|storage|schema)|conversations\/(?:schema|ozon|read|context|http|controller|control-storage|control-state|control-http|control-bindings)|(?:translations|knowledge|reply-tests)\/[^/]+|(?:products|orders)\/(?:ozon|schema|storage|sync-seed|runner)|ozon\/read)\.[cm]?[jt]s\b/,
    /node_modules\/(?:@better-auth\/drizzle-adapter|@flue\/runtime|drizzle-orm\/d1)\//,
    /node_modules\/better-auth\/(?:dist\/(?:api|db|plugins|adapters|context|cookies|minimal)\b|minimal\b)/,
  ];
  for (const entry of scripts) {
    const source = await readFile(join(clientOutput, entry), 'utf8');
    for (const path of serverPaths) assert.doesNotMatch(source, path, `server implementation leaked into ${entry}`);
    for (const marker of [...probeMarkers, 'dingbell_support_generation', 'FlueSupportAgent', 'FLUE_SUPPORT_AGENT', 'SUPPORT_SECRET_UNAVAILABLE', 'bootstrap_installation', 'invitation_flow', 'identity_audit_event', 'company_settings_audit_event', 'company_settings_version_valid', 'identity_audit_request_idx', 'identity_audit_organization_time_idx', 'store_audit_event', 'credential_ciphertext', 'STORE_CREDENTIAL_KEYS', 'store_sync', 'store_coordinator', 'sync_cursor', 'conversation_control', 'ConversationController', 'CONVERSATION_CONTROLLER', 'product_source_snapshot', 'fbs_sync_window', 'fbs_posting_observation', 'detail_epoch', 'ingest_event', 'api-seller.ozon.ru', 'reply_test_query', 'REPLY_TEST_QUERY_CONFIG_JSON', 'REPLY_TEST_CONFIG_JSON', 'reply_test_run', 'reply_test_budget', 'FlueReplyTestAgent', 'REPLY_TEST_ENABLED', 'reply_preview_run', 'translation_budget_bucket', 'FlueReplyPreviewAgent', 'NVAPI_KEY', 'integrate.api.nvidia.com']) {
      assert.equal(source.includes(marker), false, `${marker} leaked into browser asset ${entry}`);
    }
  }
});
