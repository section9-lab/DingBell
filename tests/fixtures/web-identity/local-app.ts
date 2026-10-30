import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import type { MailMessage } from '../../../src/modules/mail/types.ts';
import { conversationHistoryFixture } from './conversation-history.ts';
import { conversationContextSQL } from '../conversation-context.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = 'tests/fixtures/web-identity';

async function stop(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const kill = (signal: NodeJS.Signals) => {
    try { process.kill(-child.pid!, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const exited = child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve();
  kill('SIGTERM');
  const timer = setTimeout(() => kill('SIGKILL'), 5_000);
  try { await exited; } finally { clearTimeout(timer); }
}

export async function startLocalApplication(configured = true, options: { mail?: boolean; empty?: boolean; team?: 'roles' | 'two-owners'; stores?: 'configured' | 'unconfigured'; sync?: boolean; control?: boolean; replies?: boolean; preview?: boolean; knowledge?: boolean; answerTest?:boolean; aiConfiguration?:string; aiReception?:boolean; aiDraft?:boolean } = {}) {
  const statePath = await mkdtemp(join(tmpdir(), 'dingbell-web-identity-'));
  const children = new Set<ChildProcess>();
  const mailbox: MailMessage[] = [];
  const mailboxPath = `/${crypto.randomUUID()}`;
  const storePath = `/${crypto.randomUUID()}`;
  const previewToken=options.preview?crypto.randomUUID():'';
  const knowledgeToken = options.knowledge ? crypto.randomUUID() : '';
  const aiDraftToken = options.aiDraft ? crypto.randomUUID() : '';
  const answerToken=options.answerTest?crypto.randomUUID():'';
  const storeRequests: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  const replyRequests: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  let replyBehavior: 'success' | 'unavailable' | 'forbidden' | 'hold' = 'success';
  const heldReplies = new Set<() => void>();
  const releaseReplies = () => { for (const release of heldReplies) release(); heldReplies.clear(); };
  let storeBehavior: 'partial' | 'unavailable' | 'rate-limited' | 'sync' | 'fbs-only' = options.sync ? 'sync' : 'partial';
  const mailboxServer = createHttpServer(async (request, response) => {
    if (request.method !== 'POST' || ![mailboxPath, storePath].includes(request.url ?? '')) { response.writeHead(404).end(); return; }
    try {
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 32_768) throw new Error('oversize'); }
      if (request.url === mailboxPath) {
        mailbox.push(JSON.parse(body));
        response.writeHead(200).end();
      } else {
        const wire: { path: string; method: string; bodySource: string } = JSON.parse(body);
        const remote = { path: wire.path, method: wire.method, body: JSON.parse(wire.bodySource, (key: string, value: unknown, context?: { source?: string }) => key === 'from_message_id' && typeof value === 'number' ? context?.source : value) as Record<string, unknown> };
        storeRequests.push(remote);
        if (remote.path === '/v1/chat/send/message') {
          if (!options.replies || remote.method !== 'POST') { response.writeHead(501).end(); return; }
          replyRequests.push(remote);
          const behavior = replyBehavior;
          if (behavior === 'hold') await new Promise<void>(resolve => heldReplies.add(resolve));
          const status = behavior === 'unavailable' ? 503 : behavior === 'forbidden' ? 403 : 200;
          response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(status === 200 ? { result: 'success' } : { message: 'synthetic send failure' }));
          return;
        }
        const payloads: Record<string, unknown> = {
          '/v1/roles': { roles: [] },
          '/v3/product/list': { result: { items: [] } },
          '/v3/product/info/list': { items: [] },
          '/v3/chat/list': { chats: [], has_next: false },
          '/v3/chat/history': { messages: [], has_next: false },
          '/v4/posting/fbs/list': { postings: [], has_next: false },
          '/v3/posting/fbs/get': { result: {} },
        };
        if (remote.method !== 'POST' || !(remote.path in payloads)) { response.writeHead(501).end(); return; }
        const productIds = ['9000000000817031941', '9000000000817031942', '9000000000817031943'];
        const product = (id: string) => ({ product_id: id, offer_id: `SYN-${id}`, archived: false });
        if (options.sync) {
          const posting = (postingNumber: string) => ({ posting_number: postingNumber, order_id: '9000000000817031945', order_number: 'SYN-ORDER-1', status: 'synthetic_unknown_status',
            products: [{ sku: '9000000000817031941', offer_id: 'SYN-OFFER-1', name: '合成测试商品', quantity: 1, price: '15.5000', currency_code: 'RUB' }] });
          payloads['/v4/posting/fbs/list'] = remote.body?.limit === 1 ? { postings: [posting('SYN-POST-1')], has_next: false }
            : remote.body?.cursor === 'fbs-page-2' ? { postings: [posting('SYN-POST-1'), posting('SYN-POST-2')], has_next: false }
              : { postings: [posting('SYN-POST-1')], has_next: true, cursor: 'fbs-page-2' };
          payloads['/v3/posting/fbs/get'] = { result: posting(String(remote.body?.posting_number)) };
          const position = remote.body?.last_id;
          payloads['/v3/product/list'] = { result: remote.body?.limit === 1
            ? { items: [product(productIds[0]!)], last_id: 'catalog-page-2', total: 3 }
            : position === 'catalog-page-3' ? { items: [], last_id: 'catalog-page-3', total: 3 }
              : position === 'catalog-page-2' ? { items: productIds.slice(1).map(product), last_id: 'catalog-page-3', total: 3 }
                : { items: productIds.slice(0, 2).map(product), last_id: 'catalog-page-2', total: 3 } };
          const requested = remote.body?.product_id;
          payloads['/v3/product/info/list'] = { items: Array.isArray(requested) ? requested.filter(id => productIds.includes(String(id))).map(id => ({
            id, offer_id: `SYN-${id}`, name: '合成测试商品', sku: id, sources: [{ sku: id, source: 'fbs' }], price: '15.5000', currency_code: 'RUB', is_archived: false,
          })) : [] };
        }
        if (storeBehavior === 'sync') {
          const chat = (id: string, type = 'BUYER_SELLER') => ({ chat: { chat_id: id, chat_type: type, chat_status: 'OPENED', created_at: '2026-10-09T09:00:00Z' }, last_message_id: '3000000000817031942', first_unread_message_id: '3000000000817031941', unread_count: 0 });
          payloads['/v3/chat/list'] = remote.body?.limit === 1 ? { chats: [chat('buyer-a')], has_next: false }
            : remote.body?.cursor ? { chats: [chat('buyer-b')], has_next: false }
              : { chats: [chat('buyer-a'), chat('support-only', 'SELLER_SUPPORT')], has_next: true, cursor: 'synthetic-page-2' };
          const message = (id: string) => ({ message_id: id, created_at: '2026-10-09T09:01:00Z', user: { id: '9000000000817031900', type: 'Customer' }, data: ['Синтетический вопрос о товаре'], is_image: false, is_read: false, context: {} });
          if (remote.path === '/v3/chat/history') {
            if (!['buyer-a', 'buyer-b'].includes(String(remote.body?.chat_id))) { response.writeHead(501).end(); return; }
            payloads['/v3/chat/history'] = remote.body?.direction === 'Forward' ? { messages: [], has_next: false }
              : remote.body?.from_message_id === undefined ? { messages: [message('3000000000817031942'), message('3000000000817031941')], has_next: true }
                : { messages: [message('3000000000817031941'), message('3000000000817031940')], has_next: false };
          }
        }
        const status = storeBehavior === 'unavailable' ? 503 : storeBehavior === 'rate-limited' ? 429
          : storeBehavior === 'partial' && remote.path === '/v3/chat/list' || storeBehavior === 'fbs-only' && ['/v3/chat/list', '/v3/product/list'].includes(remote.path) ? 403 : 200;
        response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(status === 200 ? payloads[remote.path] : { message: 'synthetic provider response' }));
      }
    } catch { response.writeHead(400).end(); }
  });
  const environment = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    CI: 'true', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    DOTENV_CONFIG_PATH: '/dev/null',
  };
  async function finish(child: ChildProcess) { await stop(child); children.delete(child); }
  async function close() {
    releaseReplies();
    await Promise.all([...children].map(stop));
    if (mailboxServer.listening) await new Promise<void>(resolve => mailboxServer.close(() => resolve()));
    await rm(statePath, { recursive: true, force: true });
  }
  async function command(args: string[]) {
    const child = spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args,
      '--config', `${fixture}/wrangler.jsonc`, '--local', '--persist-to', statePath], {
      cwd: root, detached: true, stdio: 'ignore', env: environment,
    });
    children.add(child);
    const [code] = await once(child, 'exit');
    await finish(child);
    assert.equal(code, 0, 'official local D1 fixture operation succeeds');
  }
  async function sql(query: string) {
    const path = join(statePath, 'fixture.sql');
    await writeFile(path, query, { mode: 0o600 });
    try { await command(['d1', 'execute', 'DB', '--file', path]); }
    finally { await rm(path, { force: true }); }
  }
  try {
    let mailboxURL = '';
    let storeCheckerURL = '';
    if (options.mail || options.stores) {
      mailboxServer.listen(0, '127.0.0.1');
      await once(mailboxServer, 'listening');
      const address = mailboxServer.address();
      assert.ok(address && typeof address === 'object');
      if (options.mail) mailboxURL = `http://127.0.0.1:${address.port}${mailboxPath}`;
      if (options.stores) storeCheckerURL = `http://127.0.0.1:${address.port}${storePath}`;
    }
    await command(['d1', 'migrations', 'apply', 'DB']);
    const password = crypto.randomUUID() + '!Aa1';
    const hash = await hashPassword(password);
    const now = Date.now();
    if (!options.empty) await sql(`
      INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES
        ('web-owner','Fixture Owner','owner@example.invalid',1,${now},${now}),
        ('web-empty','Fixture No Membership','empty@example.invalid',1,${now},${now});
      INSERT INTO account (id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES
        ('account-owner','web-owner','credential','web-owner','${hash}',${now},${now}),
        ('account-empty','web-empty','credential','web-empty','${hash}',${now},${now});
      INSERT INTO organization (id,name,slug,created_at) VALUES
        ('company-a','测试公司 A','web-company-a',${now}),
        ('company-b','测试公司 B','web-company-b',${now});
      INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES
        ('owner-a','company-a','web-owner','owner',${now}),
        ('owner-b','company-b','web-owner','member',${now});
    `);
    if (!options.empty && options.team) await sql(`
      INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES
        ('web-admin','Fixture Admin','admin@example.invalid',1,${now},${now}),
        ('web-member','Fixture Member','member@example.invalid',1,${now},${now});
      INSERT INTO account (id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES
        ('account-admin','web-admin','credential','web-admin','${hash}',${now},${now}),
        ('account-member','web-member','credential','web-member','${hash}',${now},${now});
      INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES
        ('admin-a','company-a','web-admin','${options.team === 'two-owners' ? 'owner' : 'admin'}',${now}),
        ('admin-b','company-b','web-admin','owner',${now}),
        ('member-a','company-a','web-member','member',${now}),
        ('member-b','company-b','web-member','member',${now});
    `);
    if(options.preview)await sql(`INSERT INTO translation_budget_bucket(id,organization_id,starts_at,ends_at,enabled,limit_micros)
      VALUES ('web-preview-budget','company-a',${now-1000},${now+3600000},1,1000000);`);
    if (options.knowledge) await sql(`CREATE TABLE test_index_call(id INTEGER PRIMARY KEY,kind TEXT NOT NULL);
      CREATE TABLE test_index_gate(visible INTEGER NOT NULL,mode TEXT NOT NULL); INSERT INTO test_index_gate VALUES(1,'normal');
      CREATE TABLE test_index_vector(id TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    const portServer = createServer();
    portServer.listen(0, '127.0.0.1');
    await once(portServer, 'listening');
    const address = portServer.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;
    await new Promise<void>(resolve => portServer.close(() => resolve()));
    const baseURL = `http://127.0.0.1:${port}`;
    const installationSecret = crypto.randomUUID() + crypto.randomUUID();
    const authSecret = configured ? crypto.randomUUID() + crypto.randomUUID() : '';
    const storeKey = options.stores === 'configured' ? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64') : '';
    const storeKeys = storeKey ? JSON.stringify({ v1: storeKey }) : '';
    // Preserve the real application config while isolating its adjacent .dev.vars lookup.
    const workerConfigPath = join(statePath, 'wrangler.jsonc');
    await writeFile(workerConfigPath, await readFile(join(root, 'wrangler.jsonc')), { mode: 0o600 });
    const child = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--config', `${fixture}/vite.config.ts`,
      '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...environment, DINGBELL_WEB_IDENTITY_STATE_PATH: statePath,
        DINGBELL_WEB_IDENTITY_SECRET: authSecret,
        DINGBELL_WEB_IDENTITY_BASE_URL: baseURL,
        DINGBELL_TEST_MAILBOX: mailboxURL,
        DINGBELL_TEST_STORE_CHECKER: storeCheckerURL,
        DINGBELL_TEST_SYNC: options.sync ? 'true' : '',
        DINGBELL_TEST_CONTROL: options.control ? 'true' : '',
        DINGBELL_TEST_REPLIES: options.replies ? 'true' : '',
        DINGBELL_TEST_PREVIEW_TOKEN: previewToken,
        DINGBELL_TEST_KNOWLEDGE_TOKEN: knowledgeToken,
        DINGBELL_TEST_ANSWER_TOKEN: answerToken,
        DINGBELL_TEST_AI_DRAFT_TOKEN: aiDraftToken,
        DINGBELL_TEST_AI_CONFIG: options.aiConfiguration ?? '',
        DINGBELL_TEST_AI_RECEPTION: options.aiReception ? 'true' : '',
        DINGBELL_WEB_STORE_KEYS: storeKeys,
        DINGBELL_WEB_CONFIG_PATH: workerConfigPath,
        DINGBELL_WEB_BOOTSTRAP_SECRET: options.mail ? installationSecret : '' },
    });
    children.add(child);
    let startupOutput = '';
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', chunk => {
      startupOutput = (startupOutput + String(chunk)).slice(-6000);
    });
    let ready = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        if ((await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(1_000) })).status === 200) { ready = true; break; }
      } catch { /* Wait for workerd. */ }
      await delay(150);
    }
    const diagnostics = () => [authSecret, installationSecret, mailboxURL, storeCheckerURL, storeKeys, storeKey,previewToken,knowledgeToken,answerToken].filter(Boolean)
      .reduce((output, secret) => output.replaceAll(secret, '[synthetic credential]'), startupOutput);
    assert.ok(ready, `local application starts before browser interaction${ready ? '' : `: ${diagnostics()}`}`);
    if(options.preview){
      const response=await fetch(`${baseURL}/api/__test/translation`,{headers:{authorization:`Bearer ${previewToken}`},signal:AbortSignal.timeout(3_000)});
      assert.equal(response.status,200,'synthetic translation DI is active before browser interaction');
      assert.deepEqual(await response.json(),{dispatches:0,reads:0,requests:[]});
    }
    return {
      baseURL, password, close, mailbox, installationSecret, storeRequests, replyRequests, releaseReplies, diagnostics,
      async answerTest(action?:{seedStoreId?:string;mode?:'ready'|'pending'|'unknown';append?:boolean}){
        assert.ok(options.answerTest);const response=await fetch(`${baseURL}/api/__test/answer`,{method:action?'POST':'GET',
          headers:{authorization:`Bearer ${answerToken}`,'content-type':'application/json'},...(action?{body:JSON.stringify(action)}:{})});
        assert.equal(response.status,200,await response.clone().text());return await response.json() as {conversationId?:string;policyId?:string;embeds?:number;generations?:number};
      },
      async seedKnowledgeProduct(storeId: string, options: { productId?: string; name?: string; pending?: boolean } = {}) {
        assert.match(storeId, /^[a-f0-9-]{36}$/);
        const id = options.productId ?? '1001'; assert.match(id, /^[1-9][0-9]{0,19}$/);
        const facts = JSON.stringify({ id, offerId: 'TEST-OFFER', name: options.name ?? 'Органайзер', sku: id, sources: [], price: '123.45', currency: 'RUB', archived: false }).replaceAll("'", "''");
        const at = Date.now(), snapshotId = crypto.randomUUID(), state = options.pending ? 'pending' : 'complete';
        await sql(`INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,facts,facts_observed_at,detail_epoch,detail_generation,detail_revision,detail_state,detail_due_at)
          VALUES('${id}','company-a','${storeId}','{"id":"${id}","offerId":"TEST-OFFER","sku":"${id}","archived":false}',${at},'${facts}',${at},1,1,1,'${state}',0)
          ON CONFLICT(store_id,id) DO UPDATE SET facts=excluded.facts,facts_observed_at=excluded.facts_observed_at,detail_revision=product.detail_revision+1,detail_state=excluded.detail_state;
          INSERT INTO product_source_snapshot(id,organization_id,store_id,product_id,facts,observed_at) VALUES('${snapshotId}','company-a','${storeId}','${id}','${facts}',${at});`);
      },
      async knowledge(action?: { mode?: 'normal' | 'model-error' | 'query-empty'; dispatch?: boolean }) {
        assert.ok(options.knowledge);
        const response = await fetch(`${baseURL}/api/__test/knowledge`, { method: action ? 'POST' : 'GET',
          headers: { authorization: `Bearer ${knowledgeToken}`, 'content-type': 'application/json' }, ...(action ? { body: JSON.stringify(action) } : {}) });
        assert.equal(response.status, 200); return await response.json() as { calls: { kind: string; n: number }[] };
      },
      setStoreBehavior(behavior: typeof storeBehavior) { storeBehavior = behavior; },
      setReplyBehavior(behavior: typeof replyBehavior) { replyBehavior = behavior; },
      async holdReplyQueue(storeId:string){
        assert.ok(options.replies);assert.match(storeId,/^[0-9a-f-]{36}$/i);
        await sql(`INSERT INTO store_coordinator(store_id,organization_id,blocked_until) VALUES ('${storeId}','company-a',${Date.now()+120_000}) ON CONFLICT(store_id) DO UPDATE SET blocked_until=excluded.blocked_until;`);
      },
      async previewState(){
        assert.ok(options.preview);const response=await fetch(`${baseURL}/api/__test/translation`,{headers:{authorization:`Bearer ${previewToken}`}});assert.equal(response.status,200);
        return await response.json() as {dispatches:number;reads:number;requests:{requestId:string;source:string;sourceRevision:number;memberId:string;conversationId:string}[]};
      },
      async setPreviewBehavior(mode:'ready'|'pending'|'no-usage'|'failed',text?:string){
        assert.ok(options.preview);const response=await fetch(`${baseURL}/api/__test/translation`,{method:'POST',headers:{authorization:`Bearer ${previewToken}`,'content-type':'application/json'},body:JSON.stringify({mode,text})});assert.equal(response.status,200);
      },
      async releasePreviews(){
        assert.ok(options.preview);const response=await fetch(`${baseURL}/api/__test/translation`,{method:'POST',headers:{authorization:`Bearer ${previewToken}`,'content-type':'application/json'},body:'{"release":true}'});assert.equal(response.status,200);
      },
      async setPreviewBudget(enabled:boolean){assert.ok(options.preview);await sql(`UPDATE translation_budget_bucket SET enabled=${enabled?1:0},revision=revision+1 WHERE id='web-preview-budget'`);},
      async aiDraft(body:{conversationId?:string;withdraw?:string}) {
        assert.ok(options.aiDraft);const response=await fetch(`${baseURL}/api/__test/ai-draft`,{method:'POST',headers:{authorization:`Bearer ${aiDraftToken}`,'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200,await response.clone().text());return response.json() as Promise<{runId:string;documentId:string;body:string;question:string}>;
      },
      async prepareReplyStore(storeId: string, replyAvailable = true) {
        assert.ok(options.replies, 'only the outbound fixture may enable synthetic replies');
        assert.match(storeId, /^[0-9a-f-]{36}$/i);
        const observed = Date.now();
        await sql(`UPDATE store SET status='verified',outbound_enabled=1,checked_at=${observed},expires_at=${observed + 3600000},
          capabilities='${JSON.stringify([{ code: 'auth', status: 'available' }, { code: 'reply', status: replyAvailable ? 'available' : 'unavailable' }])}'
          WHERE id='${storeId}' AND organization_id='company-a';`);
      },
      async seedConversationHistory(storeId: string, options: { neighbors?: number; unsafe?: boolean; fragments?: boolean } = {}) {
        const fixture = conversationHistoryFixture(storeId, options);
        await sql(fixture.seedSQL);
        return { id: fixture.id, threadId: fixture.threadId, emptyId: fixture.emptyId, emptyThreadId: fixture.emptyThreadId,
          async appendMessage() { await sql(fixture.appendSQL); },
          async appendMessages(first: number, count: number, eventAt?: number) { await sql(fixture.appendBatchSQL(first, count, eventAt)); },
        };
      },
      async prepareAiReceptionConversation(id:string) {
        assert.ok(options.aiReception);assert.match(id,/^[0-9a-f-]{36}$/i);
        await sql(`UPDATE conversation SET platform_status='Opened' WHERE id='${id}' AND organization_id='company-a';`);
      },
      async seedMessageContext(storeId:string,conversationId:string) {
        assert.match(storeId,/^[0-9a-f-]{36}$/i);assert.match(conversationId,/^[0-9a-f-]{36}$/i);
        await sql(conversationContextSQL('company-a',storeId,'SYNTHETIC-ORDER-001').join(';'));
        const first=crypto.randomUUID(),second=crypto.randomUUID(),presale=crypto.randomUUID(),at=Date.parse('2026-10-09T10:01:00Z');
        await sql(`UPDATE product SET list_observed_at=list_observed_at+${at},facts_observed_at=facts_observed_at+${at} WHERE store_id='${storeId}';
          UPDATE fbs_posting SET list_observed_at=list_observed_at+${at},detail_observed_at=detail_observed_at+${at} WHERE store_id='${storeId}'`);
        for(const [id,order,offset]of [[first,"'SYNTHETIC-ORDER-001'",3],[second,"'SYNTHETIC-ORDER-002'",2],[presale,'NULL',1]] as const)await sql(`INSERT INTO message (id,organization_id,store_id,conversation_id,platform_message_id,sender_id,sender_type,direction,content,is_image,is_read,order_number,sku,event_at,received_at,ingest_mode)
          VALUES ('${id}','company-a','${storeId}','${conversationId}','${id}','9100000000000000199','Customer','inbound','["合成消息：请查询订单"]',0,0,${order},'9007199254740993',${at+offset},${at+offset+1000},'incremental')`);
        let appendCount=0;
        return {first,second,presale,async appendSecond(withNewerFirst=false){
          const id=crypto.randomUUID(),offset=++appendCount*1000;
          await sql(`INSERT INTO message (id,organization_id,store_id,conversation_id,platform_message_id,sender_id,sender_type,direction,content,is_image,is_read,order_number,sku,event_at,received_at,ingest_mode)
            SELECT '${id}',organization_id,store_id,conversation_id,'${id}',sender_id,sender_type,direction,content,is_image,is_read,order_number,sku,event_at+${offset},received_at+${offset},ingest_mode FROM message WHERE id='${second}'`);
          if(withNewerFirst){const newer=crypto.randomUUID();await sql(`INSERT INTO message (id,organization_id,store_id,conversation_id,platform_message_id,sender_id,sender_type,direction,content,is_image,is_read,order_number,sku,event_at,received_at,ingest_mode)
            SELECT '${newer}',organization_id,store_id,conversation_id,'${newer}',sender_id,sender_type,direction,content,is_image,is_read,order_number,sku,event_at+${offset+1000},received_at+${offset+1000},ingest_mode FROM message WHERE id='${first}'`);}
          return id;
        }};
      },
      async seedTransferMembers(storeId: string) {
        assert.match(storeId, /^[0-9a-f-]{36}$/i);
        const rows = Array.from({ length: 101 }, (_, index) => `transfer-member-${String(index).padStart(3, '0')}`);
        await sql(`
          INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES
            ${rows.map(id => `('${id}','Transfer ${id}','${id}@example.invalid',1,${now},${now})`).join(',')};
          INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES
            ${rows.map(id => `('${id}','company-a','${id}','member',${now})`).join(',')};
          INSERT INTO store_grant (organization_id,store_id,member_id,created_at) VALUES
            ${rows.map(id => `('company-a','${storeId}','${id}',${now})`).join(',')};
        `);
      },
      async renameFixtureMember(name: string, actor: 'member' | 'owner' = 'member') {
        assert.ok(typeof name === 'string' && name.length <= 500);
        await sql(`UPDATE user SET name='${name.replaceAll("'", "''")}',updated_at=${Date.now()} WHERE id='${actor === 'owner' ? 'web-owner' : 'web-member'}'`);
      },
      async rejoinFixtureMember(storeId: string) {
        assert.match(storeId, /^[0-9a-f-]{36}$/i);
        await sql(`
          DELETE FROM member WHERE id='member-a' AND organization_id='company-a';
          INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES
            ('member-a-rejoined','company-a','web-member','member',${Date.now()});
          INSERT INTO store_grant (organization_id,store_id,member_id,created_at) VALUES
            ('company-a','${storeId}','member-a-rejoined',${Date.now()});
        `);
      },
      async removeMembership(companyId: 'company-a' | 'company-b') {
        // This older fixture verifies revocation, not removal of the final owner.
        await sql(`
          INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES
            ('web-fallback-owner','Fixture Backup','backup@example.invalid',1,${now},${now}) ON CONFLICT(id) DO NOTHING;
          INSERT INTO member (id,organization_id,user_id,role,created_at)
            SELECT 'fallback-${companyId}','${companyId}','web-fallback-owner','owner',${now}
            WHERE EXISTS (SELECT 1 FROM member WHERE user_id='web-owner' AND organization_id='${companyId}' AND role='owner')
              AND NOT EXISTS (SELECT 1 FROM member WHERE user_id<>'web-owner' AND organization_id='${companyId}' AND role='owner');
          DELETE FROM member WHERE user_id = 'web-owner' AND organization_id = '${companyId}';
        `);
      },
    };
  } catch (error) { await close(); throw error; }
}
