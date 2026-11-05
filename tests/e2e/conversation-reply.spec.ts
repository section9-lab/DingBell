import { test as base, expect, type Page, type Route } from '@playwright/test';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';
import { signOut } from './support/session.ts';

type Application = Awaited<ReturnType<typeof startLocalApplication>>;
const test = base.extend<{ application: Application }>({
  application: async ({}, use) => {
    const application = await startLocalApplication(true, { mail: true, team: 'roles', stores: 'configured', sync: true, control: true, replies: true });
    try { await use(application); } finally { await application.close(); }
  },
});

async function login(page: Page, application: Application, actor = 'owner') {
  await page.goto(`${application.baseURL}/login`);
  await page.getByLabel('邮箱', { exact: true }).fill(`${actor}@example.invalid`);
  await page.getByLabel('密码', { exact: true }).fill(application.password).catch(() => { throw new Error('Synthetic password input failed'); });
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '测试公司 A', exact: true }).click();
}

async function seed(page: Page, application: Application) {
  const storeId = crypto.randomUUID();
  const response = await page.request.post(`${application.baseURL}/api/companies/company-a/stores`, {
    headers: { origin: application.baseURL }, data: { id: storeId, name: '人工回复测试店', clientId: '910001', apiKey: crypto.randomUUID() },
  });
  expect(response.status()).toBe(200);
  await application.prepareReplyStore(storeId);
  return { storeId, ...await application.seedConversationHistory(storeId) };
}

const controlURL = (application: Application, id: string) => `${application.baseURL}/api/companies/company-a/conversations/${id}/control`;
const commandURL = (application: Application, id: string) => `${application.baseURL}/api/companies/company-a/conversations/${id}/commands`;
const messageURL = (application: Application, storeId: string, id: string) => `${application.baseURL}/workspace/messages?${new URLSearchParams({ store: storeId, conversation: id })}`;
const repliesURL = (application: Application, id: string) => `${application.baseURL}/api/companies/company-a/conversations/${id}/replies`;
type Submission = { commandId: string; expectedVersion: number; action: 'send_reply'; body: string };

function submissions(page: Page) {
  const values: Submission[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/commands')) {
      const data = request.postDataJSON();
      if (data.action === 'send_reply') values.push(data);
    }
  });
  return values;
}

async function claim(page: Page, application: Application, id: string) {
  const response = await page.request.post(commandURL(application, id), {
    headers: { origin: application.baseURL }, data: { commandId: crypto.randomUUID(), expectedVersion: 0, action: 'claim' },
  });
  expect(response.status()).toBe(200);
}

async function send(page: Page, body: string) {
  await page.getByRole('textbox', { name: '回复原文', exact: true }).fill(body);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}

async function result(page: Page, application: Application, id: string, intentId: string) {
  const response = await page.request.get(`${repliesURL(application, id)}/${intentId}`);
  expect(response.status()).toBe(200);
  return (await response.json()).reply;
}

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
}

test('manual reply sends the exact edited body once and records one real controller attempt on desktop and mobile', async ({ page, application }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await login(page, application);
  const history = await seed(page, application);
  await claim(page, application, history.id);
  const control = await page.request.get(controlURL(application, history.id));
  expect(control.status()).toBe(200);
  expect((await control.json()).control.state).toMatchObject({ version: 1, lifecycle: 'open', reception: 'human', assignedMemberId: 'owner-a' });
  await page.goto(messageURL(application, history.storeId, history.id));
  await expect(page.getByText('AI 托管已关闭', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '回复原文', exact: true })).toBeVisible();
  const sent = submissions(page), body = '  Здравствуйте!\n请确认规格。\n<img src="https://example.invalid/no-image">  ';
  const draft = page.getByRole('textbox', { name: '回复原文', exact: true });
  await draft.fill(body);
  await expect(draft).toHaveValue(body);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
  await expect(page.getByRole('region', { name: '消息记录', exact: true })).toBeInViewport();
  await screenshot(page, 'reply-composer-ready-desktop');
  expect(sent).toHaveLength(0); expect(application.replyRequests).toHaveLength(0);
  application.setReplyBehavior('hold');
  const accepted = page.waitForResponse(response => response.url() === commandURL(application, history.id) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const receiptResponse = await accepted;
  expect(receiptResponse.status()).toBe(200);
  expect(receiptResponse.request().headers()['x-dingbell-member-id']).toBe('owner-a');
  await expect.poll(() => application.replyRequests.length).toBe(1);
  expect(sent).toHaveLength(1);
  application.releaseReplies();
  await expect.poll(async () => (await result(page, application, history.id, sent[0]!.commandId)).status).toBe('sent');
  expect(application.replyRequests).toEqual([{ path: '/v1/chat/send/message', method: 'POST', body: { chat_id: history.threadId, text: body } }]);
  expect(await result(page, application, history.id, sent[0]!.commandId)).toMatchObject({ body, status: 'sent', attempt: { id: `${sent[0]!.commandId}:1`, providerResult: 'success' } });
  await screenshot(page, 'reply-sent-desktop');
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('textbox', { name: '回复原文', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toHaveCount(0);
  await expect(page.getByText('AI 托管已关闭', { exact: true })).toBeInViewport();
  await screenshot(page, 'reply-composer-ready-mobile');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await screenshot(page, 'reply-sent-mobile');
  expect(sent).toHaveLength(1); expect(application.replyRequests).toHaveLength(1);
});

test('unknown provider results stay readable and explicit rejection returns the text without a second attempt', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  await claim(page, application, history.id);
  await page.goto(messageURL(application, history.storeId, history.id));
  const sent = submissions(page), draft = page.getByRole('textbox', { name: '回复原文', exact: true });
  application.setReplyBehavior('unavailable');
  await send(page, 'Пожалуйста, проверьте товар.');
  // 平台结果未知时，本机提交已确认收下，编辑器回到可编辑状态且不会自动重发。
  await expect(page.getByText('已提交发送，等待平台送达结果。', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('');
  await expect(page.getByRole('button', { name: '重试原提交', exact: true })).toHaveCount(0);
  expect(sent).toHaveLength(1);
  await expect.poll(() => application.replyRequests.length).toBe(1);
  await expect.poll(async () => (await result(page, application, history.id, sent[0]!.commandId)).status).toBe('unknown');
  expect(await result(page, application, history.id, sent[0]!.commandId)).toMatchObject({ reason: 'PROVIDER_UNAVAILABLE' });
  await page.reload();
  await expect(draft).toHaveValue('');
  await expect(page.getByRole('button', { name: '核对提交', exact: true })).toHaveCount(0);
  expect(application.replyRequests).toHaveLength(1);
  application.setReplyBehavior('forbidden');
  await send(page, 'Отдельный новый ответ.');
  // 平台侧拒绝同样发生在投递阶段：本机提交已被收下，结果按失败落库且不会自动重发。
  await expect(draft).toHaveValue('');
  expect(sent).toHaveLength(2);
  await expect.poll(async () => (await result(page, application, history.id, sent[1]!.commandId)).status).toBe('failed');
  expect(await result(page, application, history.id, sent[1]!.commandId)).toMatchObject({ reason: 'PERMISSION_DENIED' });
});

test('lost POST responses survive refresh and recovery never resends an accepted command', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  await claim(page, application, history.id);
  await claim(page, application, history.emptyId);
  await page.goto(messageURL(application, history.storeId, history.id));
  const sent = submissions(page), body = 'Accepted response lost before the browser received it.';
  const loseAccepted = async (route: Route) => { const accepted = await route.fetch(); expect(accepted.status()).toBe(200); await route.abort('failed'); };
  const blockLookup = async (route: Route) => { await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CONTROL_UNAVAILABLE', message: 'Synthetic read outage' } }) }); };
  await page.route(commandURL(application, history.id), loseAccepted);
  await page.route(`${repliesURL(application, history.id)}/*`, blockLookup);
  await send(page, body);
  await expect(page.getByRole('button', { name: '核对提交', exact: true })).toBeVisible();
  expect(sent).toHaveLength(1);
  const original = sent[0]!;
  await page.reload();
  await expect(page.getByRole('button', { name: '核对提交', exact: true })).toBeVisible();
  await expect(page.getByText(body, { exact: true })).toBeVisible();
  await expect(page.getByText(`提交编号：${original.commandId}`, { exact: true })).toBeVisible();
  await page.unroute(`${repliesURL(application, history.id)}/*`, blockLookup);
  await page.unroute(commandURL(application, history.id), loseAccepted);
  await page.getByRole('button', { name: '核对提交', exact: true }).click();
  await expect(page.getByRole('button', { name: '核对提交', exact: true })).toHaveCount(0);
  await expect(page.getByText('提交结果尚未确认，已重新读取会话状态。请核对后再操作。', { exact: true })).toHaveCount(0);
  await expect.poll(async () => (await result(page, application, history.id, original.commandId)).status).toBe('sent');
  expect(sent).toHaveLength(1); expect(application.replyRequests).toHaveLength(1);

  // A second, never-accepted command may be explicitly retried only with its original identity.
  await page.goto(messageURL(application, history.storeId, history.emptyId));
  const loseBeforeAccept = async (route: Route) => route.abort('failed');
  await page.route(commandURL(application, history.emptyId), loseBeforeAccept);
  await send(page, 'Original pending command after a lost request.');
  await expect(page.getByRole('button', { name: '核对提交', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '核对提交', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试原提交', exact: true })).toBeVisible();
  expect(sent).toHaveLength(2); expect(application.replyRequests).toHaveLength(1);
  await page.unroute(commandURL(application, history.emptyId), loseBeforeAccept);
  await page.getByRole('button', { name: '重试原提交', exact: true }).click();
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2]).toEqual(sent[1]);
  await expect.poll(async () => (await result(page, application, history.emptyId, sent[1]!.commandId)).status).toBe('sent');
  expect(application.replyRequests).toHaveLength(2);

  // Reconcile without remounting: an obsolete parent error must not contradict the confirmed result.
  await page.goto(messageURL(application, history.storeId, history.id));
  await page.route(commandURL(application, history.id), loseAccepted);
  await send(page, 'Same-page reconciliation must clear the obsolete submission warning.');
  await expect(page.getByRole('button', { name: '核对提交', exact: true })).toBeEnabled();
  await page.unroute(commandURL(application, history.id), loseAccepted);
  await page.getByRole('button', { name: '核对提交', exact: true }).click();
  await expect(page.getByRole('button', { name: '核对提交', exact: true })).toHaveCount(0);
  await expect(page.getByText('提交结果尚未确认，已重新读取会话状态。请核对后再操作。', { exact: true })).toHaveCount(0);
  expect(sent).toHaveLength(4);
  await expect.poll(async () => (await result(page, application, history.id, sent[3]!.commandId)).status).toBe('sent');
  expect(application.replyRequests).toHaveLength(3);
});

test('pending replies remain scoped to their conversation and company and are cleared at logout', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  await claim(page, application, history.id); await claim(page, application, history.emptyId);
  await page.goto(messageURL(application, history.storeId, history.id));
  const sent = submissions(page), body = 'PRIVATE-PENDING-OWNER-REPLY';
  await page.route(commandURL(application, history.id), route => route.abort('failed'));
  await send(page, body);
  await expect(page.getByRole('button', { name: '核对提交', exact: true })).toBeVisible();
  await page.goto(messageURL(application, history.storeId, history.emptyId));
  await expect(page.getByRole('textbox', { name: '回复原文', exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: '核对提交', exact: true })).toHaveCount(0);
  await page.goto(messageURL(application, history.storeId, history.id));
  await expect(page.getByText(body, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '切换公司', exact: true }).click();
  await page.getByRole('menuitem', { name: /测试公司 B/ }).click();
  await expect(page.getByText(body, { exact: true })).toHaveCount(0);
  expect((await page.request.get(`${application.baseURL}/api/companies/company-b/conversations/${history.id}/replies`)).status()).toBe(404);
  await signOut(page);
  await expect(page).toHaveURL(`${application.baseURL}/login`);
  expect(await page.evaluate(`Object.values(sessionStorage).some(value => value.includes(${JSON.stringify(body)}))`)).toBe(false);
  await login(page, application, 'admin');
  await page.goto(messageURL(application, history.storeId, history.id));
  await expect(page.getByRole('textbox', { name: '回复原文', exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: '核对提交', exact: true })).toHaveCount(0);
  await signOut(page);
  await login(page, application);
  await page.goto(messageURL(application, history.storeId, history.id));
  await expect(page.getByRole('textbox', { name: '回复原文', exact: true })).toHaveValue('');
  expect(sent).toHaveLength(1); expect(application.replyRequests).toHaveLength(0);
});

test('unverified capability and paused stores cannot send and revoked membership clears a pending reply', async ({ page, browser, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  await claim(page, application, history.id);
  await application.prepareReplyStore(history.storeId, false);
  await page.goto(messageURL(application, history.storeId, history.id));
  const unavailable = await page.request.get(repliesURL(application, history.id));
  expect((await unavailable.json()).readiness).toEqual({ allowed: false, code: 'CAPABILITY_UNVERIFIED' });
  await expect(page.getByRole('textbox', { name: '回复原文', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toHaveCount(0);
  await application.prepareReplyStore(history.storeId);
  const storeURL = `${application.baseURL}/api/companies/company-a/stores/${history.storeId}`;
  const store = (await (await page.request.get(storeURL)).json()).store;
  expect((await page.request.post(`${storeURL}/state`, { headers: { origin: application.baseURL }, data: { expectedRevision: store.revision, state: 'paused' } })).status()).toBe(200);
  await page.reload();
  await expect(page.getByRole('textbox', { name: '回复原文', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toHaveCount(0);
  expect(application.replyRequests).toHaveLength(0);
  await application.prepareReplyStore(history.storeId);
  const grantURL = `${storeURL}/grants/member-a`;
  expect((await page.request.post(grantURL, { headers: { origin: application.baseURL }, data: { expectedGranted: false, granted: true } })).status()).toBe(200);
  const context = await browser.newContext();
  try {
    const member = await context.newPage();
    await login(member, application, 'member');
    await member.goto(messageURL(application, history.storeId, history.id));
    const body = 'PRIVATE-PENDING-MEMBER-REPLY', requests = submissions(member);
    await member.route(commandURL(application, history.id), route => route.abort('failed'));
    await send(member, body);
    await expect(member.getByRole('button', { name: '核对提交', exact: true })).toBeEnabled();
    const revokedRead = member.waitForResponse(response => response.status() === 404
      && response.url().startsWith(`${application.baseURL}/api/companies/company-a/conversations/${history.id}`), { timeout: 15000 });
    expect((await page.request.post(grantURL, { headers: { origin: application.baseURL }, data: { expectedGranted: true, granted: false } })).status()).toBe(200);
    await revokedRead;
    await expect.poll(() => new URL(member.url()).searchParams.has('conversation')).toBe(false);
    await expect(member.getByRole('textbox', { name: '回复原文', exact: true })).toHaveCount(0);
    expect(await member.evaluate(`Object.values(sessionStorage).some(value => value.includes(${JSON.stringify(body)}))`)).toBe(false);
    expect((await member.request.get(repliesURL(application, history.id))).status()).toBe(404);
    expect(requests).toHaveLength(1); expect(application.replyRequests).toHaveLength(0);
  } finally { await context.close(); }
});

test('a browser storage quota failure prevents submission before any command or provider request', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  await claim(page, application, history.id);
  await page.goto(messageURL(application, history.storeId, history.id));
  const sent = submissions(page), body = 'Must remain an unsent local draft.';
  await page.getByRole('textbox', { name: '回复原文', exact: true }).fill(body);
  await page.evaluate(`(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (this === window.sessionStorage) throw new DOMException('Synthetic quota exhausted', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  })()`);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('浏览器无法可靠保存本次提交，消息尚未提交。请检查浏览器存储设置。', { exact: true })).toBeVisible();
  expect(sent).toHaveLength(0); expect(application.replyRequests).toHaveLength(0);
  const state = await page.request.get(controlURL(application, history.id));
  expect((await state.json()).control.state.version).toBe(1);
  const records = await page.request.get(repliesURL(application, history.id));
  expect((await records.json()).replies).toHaveLength(0);
});

test('a real command conflict keeps the original pending identity and body frozen across refresh', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  await claim(page, application, history.id);
  await page.goto(messageURL(application, history.storeId, history.id));
  const sent = submissions(page), localBody = 'ORIGINAL-LOCAL-PENDING-PAYLOAD', serverBody = 'DIFFERENT-ALREADY-ACCEPTED-PAYLOAD';
  const dropRequest = async (route: Route) => route.abort('failed');
  await page.route(commandURL(application, history.id), dropRequest);
  await send(page, localBody);
  await page.getByRole('button', { name: '核对提交', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试原提交', exact: true })).toBeEnabled();
  expect(sent).toHaveLength(1);
  const original = sent[0]!;
  const accepted = await page.request.post(commandURL(application, history.id), {
    headers: { origin: application.baseURL, 'X-DingBell-Member-Id': 'owner-a' }, data: { ...original, body: serverBody },
  });
  expect(accepted.status()).toBe(200);
  await page.unroute(commandURL(application, history.id), dropRequest);
  const conflicted = page.waitForResponse(response => response.url() === commandURL(application, history.id) && response.status() === 409);
  await page.getByRole('button', { name: '重试原提交', exact: true }).click();
  expect((await (await conflicted).json()).error.code).toBe('COMMAND_CONFLICT');
  await expect(page.getByText('提交编号与服务器记录冲突，请先核对提交，暂时不要重复发送。', { exact: true })).toBeVisible();
  expect(sent).toHaveLength(2); expect(sent[1]).toEqual(original);
  await expect(page.getByText(localBody, { exact: true })).toBeVisible();
  await expect(page.getByText(`提交编号：${original.commandId}`, { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '回复原文', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(localBody, { exact: true })).toBeVisible();
  await expect(page.getByText(`提交编号：${original.commandId}`, { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '回复原文', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '核对提交', exact: true }).click();
  await expect(page.getByText('服务器记录与本机确认内容不一致，已停止操作。请联系管理员核对提交编号。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重试原提交', exact: true })).toHaveCount(0);
  await expect.poll(async () => (await result(page, application, history.id, original.commandId)).status).toBe('sent');
  expect(application.replyRequests).toHaveLength(1);
  expect(application.replyRequests[0]!.body).toEqual({ chat_id: history.threadId, text: serverBody });
});

for (const firstIdentity of ['replies', 'messages'] as const) test(`a newly joined member response hides an old pending reply before delayed control identity catches up (${firstIdentity} first)`, async ({ page, browser, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  await claim(page, application, history.id);
  const grantURL = `${application.baseURL}/api/companies/company-a/stores/${history.storeId}/grants/member-a`;
  expect((await page.request.post(grantURL, { headers: { origin: application.baseURL }, data: { expectedGranted: false, granted: true } })).status()).toBe(200);
  const context = await browser.newContext();
  let releaseControl: () => void = () => {};
  const holdControl = new Promise<void>(resolve => { releaseControl = resolve; });
  let releaseSecondary: () => void = () => {};
  const holdSecondary = new Promise<void>(resolve => { releaseSecondary = resolve; });
  try {
    const member = await context.newPage();
    await login(member, application, 'member');
    await member.goto(messageURL(application, history.storeId, history.id));
    const sent = submissions(member), body = 'PRIVATE-OLD-MEMBERSHIP-PENDING';
    await member.route(commandURL(application, history.id), route => route.abort('failed'));
    await send(member, body);
    await member.getByRole('button', { name: '核对提交', exact: true }).click();
    await expect(member.getByRole('button', { name: '重试原提交', exact: true })).toBeEnabled();
    expect(sent).toHaveLength(1);
    const oldMember = (await (await member.request.get(controlURL(application, history.id))).json()).control.viewerMemberId;
    expect(oldMember).toBe('member-a');
    let delayedReads = 0;
    const delayControl = async (route: Route) => { delayedReads++; await holdControl; await route.continue(); };
    await member.route(controlURL(application, history.id), delayControl);
    // Fix the arrival order: each independently authorized read must protect the editor on its own.
    if (firstIdentity === 'replies') await member.route(`**/conversations/${history.id}/message-updates?**`, async route => { await holdSecondary; await route.continue(); });
    else await member.route(repliesURL(application, history.id), async route => { await holdSecondary; await route.continue(); });
    const changedIdentity = member.waitForResponse(async response => (firstIdentity === 'replies' ? response.url() === repliesURL(application, history.id) : new URL(response.url()).pathname.endsWith(`/conversations/${history.id}/messages`))
      && response.status() === 200 && (await response.json()).viewerMemberId === 'member-a-rejoined', { timeout: 15000 });
    await application.rejoinFixtureMember(history.storeId);
    expect((await (await changedIdentity).json()).viewerMemberId).toBe('member-a-rejoined');
    await expect.poll(() => delayedReads).toBeGreaterThan(0);
    await expect(member.getByText(firstIdentity === 'replies' ? '正在确认当前成员身份，暂不展示本机提交内容。' : '正在读取托管状态', { exact: true })).toBeVisible();
    await expect(member.getByText(body, { exact: true })).toHaveCount(0);
    await expect(member.getByText(`提交编号：${sent[0]!.commandId}`, { exact: true })).toHaveCount(0);
    await expect(member.getByRole('button', { name: '重试原提交', exact: true })).toHaveCount(0);
    expect(sent).toHaveLength(1); expect(application.replyRequests).toHaveLength(0);
    const freshControl = member.waitForResponse(async response => response.url() === controlURL(application, history.id)
      && response.status() === 200 && (await response.json()).control.viewerMemberId === 'member-a-rejoined');
    releaseControl();
    await freshControl; releaseSecondary();
    await expect(member.getByRole('textbox', { name: '回复原文', exact: true })).toHaveValue('');
    await expect(member.getByRole('button', { name: '核对提交', exact: true })).toHaveCount(0);
    expect(sent).toHaveLength(1); expect(application.replyRequests).toHaveLength(0);
  } finally { releaseControl(); releaseSecondary(); await context.close(); }
});

test('an unrecognized HTTP error after acceptance preserves the original submission for read-only recovery', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  await claim(page, application, history.id);
  await page.goto(messageURL(application, history.storeId, history.id));
  const sent = submissions(page), body = 'ACCEPTED-BEFORE-UNKNOWN-UPSTREAM-ERROR';
  const unknownResponse = async (route: Route) => {
    const accepted = await route.fetch(); expect(accepted.status()).toBe(200);
    await route.fulfill({ status: 503, json: { error: { code: 'UPSTREAM_UNAVAILABLE' }, requestId: 'synthetic' } });
  };
  await page.route(commandURL(application, history.id), unknownResponse);
  const unknownStatus = page.waitForResponse(response => response.url() === commandURL(application, history.id) && response.status() === 503);
  await send(page, body);
  await unknownStatus;
  await expect(page.getByRole('button', { name: '核对提交', exact: true })).toBeEnabled();
  expect(sent).toHaveLength(1);
  await expect(page.getByText(body, { exact: true })).toBeVisible();
  await expect(page.getByText(`提交编号：${sent[0]!.commandId}`, { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '回复原文', exact: true })).toHaveCount(0);
  await page.unroute(commandURL(application, history.id), unknownResponse);
  await page.getByRole('button', { name: '核对提交', exact: true }).click();
  await expect(page.getByRole('button', { name: '核对提交', exact: true })).toHaveCount(0);
  await expect.poll(async () => (await result(page, application, history.id, sent[0]!.commandId)).status).toBe('sent');
  expect(sent).toHaveLength(1); expect(application.replyRequests).toHaveLength(1);
  expect(application.replyRequests[0]!.body).toEqual({ chat_id: history.threadId, text: body });
});
