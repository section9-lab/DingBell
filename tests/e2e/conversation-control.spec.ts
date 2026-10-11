import { test as base, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';

type Application = Awaited<ReturnType<typeof startLocalApplication>>;
const test = base.extend<{ application: Application }>({
  application: async ({}, use) => {
    const application = await startLocalApplication(true, { mail: true, team: 'roles', stores: 'configured', sync: true, control: true });
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
    headers: { origin: application.baseURL }, data: { id: storeId, name: '人工处理测试店', clientId: '910001', apiKey: crypto.randomUUID() },
  });
  expect(response.ok()).toBe(true);
  return { storeId, ...await application.seedConversationHistory(storeId) };
}

const controlURL = (application: Application, id: string) => `${application.baseURL}/api/companies/company-a/conversations/${id}/control`;
const commandURL = (application: Application, id: string) => `${application.baseURL}/api/companies/company-a/conversations/${id}/commands`;
const messageURL = (application: Application, storeId: string, id: string) => `${application.baseURL}/workspace/messages?${new URLSearchParams({ store: storeId, conversation: id })}`;

async function readControl(page: Page, application: Application, id: string) {
  const response = await page.request.get(controlURL(application, id));
  expect(response.status()).toBe(200);
  return (await response.json()).control;
}

async function command(page: Page, application: Application, id: string, expectedVersion: number, action: 'claim' | 'takeover' | 'resolve') {
  return page.request.post(commandURL(application, id), {
    headers: { origin: application.baseURL }, data: { commandId: crypto.randomUUID(), expectedVersion, action },
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function screenshot(page: Page, name: string) {
  const directory = fileURLToPath(new URL('../../test-results/stage4b6-2026-10-09/', import.meta.url));
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}${name}.png`, fullPage: true, animations: 'disabled' });
}

test('real conversation control supports claim, takeover and resolution on desktop and mobile', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  // This preflight separates a missing UI from a broken local controller binding or HTTP route.
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 0, lifecycle: 'open', reception: 'paused', assignedMemberId: null });
  await page.goto(messageURL(application, history.storeId, history.id));
  await expect(page.getByRole('button', { name: '认领并接管', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '认领并接管', exact: true }).click();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('我负责', { exact: true })).toBeVisible();
  await expect(page.getByText('人工处理', { exact: true })).toBeVisible();
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 1, reception: 'human', assignedMemberId: 'owner-a' });
  await screenshot(page, 'control-desktop');
  await page.getByRole('button', { name: '标记已解决', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '标记会话已解决？', exact: true });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect((await readControl(page, application, history.id)).state.version).toBe(1);
  await page.getByRole('button', { name: '标记已解决', exact: true }).click();
  await dialog.getByRole('button', { name: '确认解决', exact: true }).click();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('已解决', { exact: true })).toBeVisible();
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 2, lifecycle: 'resolved', reception: 'human', assignedMemberId: 'owner-a' });
  await page.reload();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('已解决', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(messageURL(application, history.storeId, history.emptyId));
  await page.getByRole('button', { name: '接管会话', exact: true }).click();
  await expect(page.getByText('人工处理', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('未分配', { exact: true })).toBeVisible();
  expect((await readControl(page, application, history.emptyId)).state).toMatchObject({ version: 1, lifecycle: 'open', reception: 'human', assignedMemberId: null });
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await screenshot(page, 'control-mobile');
  expect(application.storeRequests).toEqual([]);
});

test('a stale claim reports the real version conflict and reloads the other member assignment', async ({ page, browser, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  const context = await browser.newContext();
  try {
    const teammate = await context.newPage();
    await login(teammate, application, 'admin');
    await page.goto(messageURL(application, history.storeId, history.id));
    await expect(page.getByRole('button', { name: '认领并接管', exact: true })).toBeEnabled();
    expect((await command(teammate, application, history.id, 0, 'claim')).status()).toBe(200);
    let submissions = 0;
    await page.route(commandURL(application, history.id), async route => { submissions++; await route.continue(); });
    const rejected = page.waitForResponse(response => response.url() === commandURL(application, history.id) && response.status() === 409);
    await page.getByRole('button', { name: '认领并接管', exact: true }).click();
    await rejected;
    await expect(page.getByText('会话状态已变化，请刷新确认后再操作。 已读取最新会话状态。', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('负责人：Fixture Admin', { exact: true })).toBeVisible();
    expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 1, assignedMemberId: 'admin-a' });
    expect(submissions).toBe(1);
    expect(application.storeRequests).toEqual([]);
  } finally { await context.close(); }
});

test('a lost accepted reply is reread without resubmission and a failed reread locks further actions', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  await page.goto(messageURL(application, history.storeId, history.id));
  await expect(page.getByRole('button', { name: '认领并接管', exact: true })).toBeEnabled();
  let submissions = 0, recoveryReads = 0;
  await page.route(commandURL(application, history.id), async route => {
    submissions++;
    const accepted = await route.fetch();
    expect(accepted.status()).toBe(200);
    // The native controller commits. Only the response to the browser is lost.
    await route.abort('failed');
  });
  await page.route(controlURL(application, history.id), async route => {
    recoveryReads++;
    if (recoveryReads === 1) await route.fulfill({ status: 503, json: { error: { code: 'CONTROL_UNAVAILABLE' } } });
    else await route.continue();
  });
  await page.getByRole('button', { name: '认领并接管', exact: true }).click();
  await expect(page.getByText('暂时无法读取会话处理状态，请重试。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(认领并接管|接管会话|标记已解决|等待消费者|等待内部|返回待回复|分配负责人|转交会话)$/ }).and(page.locator(':enabled'))).toHaveCount(0);
  expect(recoveryReads).toBe(1);
  await page.getByRole('button', { name: '刷新会话状态', exact: true }).click();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('我负责', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '标记已解决', exact: true })).toBeEnabled();
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 1, assignedMemberId: 'owner-a' });
  expect(submissions).toBe(1);
  expect(recoveryReads).toBeGreaterThanOrEqual(2);
  expect(application.storeRequests).toEqual([]);
});

test('a late command receipt cannot change the newly selected conversation', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  await page.goto(messageURL(application, history.storeId, history.id));
  await expect(page.getByRole('button', { name: '认领并接管', exact: true })).toBeEnabled();
  const committed = deferred(), release = deferred();
  let submissions = 0;
  await page.route(commandURL(application, history.id), async route => {
    submissions++;
    const accepted = await route.fetch();
    expect(accepted.status()).toBe(200);
    committed.resolve();
    await release.promise;
    await route.fulfill({ response: accepted });
  });
  try {
    await page.getByRole('button', { name: '认领并接管', exact: true }).dblclick();
    await committed.promise;
    await page.getByRole('button', { name: `打开会话 ${history.emptyThreadId}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: `会话 ${history.emptyThreadId}`, exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('未分配', { exact: true })).toBeVisible();
    const completed = page.waitForResponse(commandURL(application, history.id));
    release.resolve();
    await completed;
    await expect(page.getByRole('button', { name: '认领并接管', exact: true })).toBeEnabled();
    await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('未分配', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('我负责', { exact: true })).toHaveCount(0);
    expect((await readControl(page, application, history.emptyId)).state.version).toBe(0);
    expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 1, assignedMemberId: 'owner-a' });
    expect(submissions).toBe(1);
    expect(application.storeRequests).toEqual([]);
  } finally { release.resolve(); }
});

test('a resolution dialog keeps the version the user confirmed even after polling sees a newer state', async ({ page, application }) => {
  const failedReads: { path: string; status: number }[] = [];
  page.on('response', response => { if (response.status() >= 400 && response.url().startsWith(`${application.baseURL}/api/`)) failedReads.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  await login(page, application);
  const history = await seed(page, application);
  await page.goto(messageURL(application, history.storeId, history.id));
  await page.getByRole('button', { name: '标记已解决', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '标记会话已解决？', exact: true });
  await expect(dialog).toBeVisible();
  // Wait for the actual polling response while keeping the confirmation dialog open.
  const polled = page.waitForResponse(async response => response.url() === controlURL(application, history.id) && response.status() === 200 && (await response.json()).control.state.version === 1,
    { timeout: 15_000 });
  expect((await command(page, application, history.id, 0, 'takeover')).status()).toBe(200);
  try { await polled; } catch (error) { console.error('Concurrent read failure', failedReads, application.diagnostics()); throw error; }
  const sent: { expectedVersion: number; action: string }[] = [];
  await page.route(commandURL(application, history.id), async route => { sent.push(route.request().postDataJSON()); await route.continue(); });
  const rejected = page.waitForResponse(response => response.url() === commandURL(application, history.id) && response.status() === 409);
  await dialog.getByRole('button', { name: '确认解决', exact: true }).click();
  await rejected;
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('会话状态已变化，请刷新确认后再操作。 已读取最新会话状态。', { exact: true })).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ expectedVersion: 0, action: 'resolve' });
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 1, lifecycle: 'open', reception: 'human' });
});

test('a reported projection delay clears after the subsequent real control read confirms recovery', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  await page.goto(messageURL(application, history.storeId, history.id));
  await expect(page.getByRole('button', { name: '认领并接管', exact: true })).toBeEnabled();
  const release = deferred();
  await page.route(controlURL(application, history.id), async route => { await release.promise; await route.continue(); });
  await page.route(commandURL(application, history.id), async route => {
    const accepted = await route.fetch();
    expect(accepted.status()).toBe(200);
    const payload = await accepted.json();
    // Test the UI's delay indicator only. Native tests separately inject an actual D1 projection failure.
    payload.control.projectionPending = true;
    await route.fulfill({ response: accepted, json: payload });
  });
  try {
    await page.getByRole('button', { name: '认领并接管', exact: true }).click();
    await expect(page.getByText('处理状态已保存，日志同步中。', { exact: true })).toBeVisible();
    release.resolve();
    await expect(page.getByText('处理状态已保存。', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('处理状态已保存，日志同步中。', { exact: true })).toHaveCount(0);
    expect((await readControl(page, application, history.id)).projectionPending).toBe(false);
  } finally { release.resolve(); }
});

test('revoked store access prevents a pending action and clears its conversation', async ({ page, browser, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  const grantURL = `${application.baseURL}/api/companies/company-a/stores/${history.storeId}/grants/member-a`;
  expect((await page.request.post(grantURL, { headers: { origin: application.baseURL }, data: { expectedGranted: false, granted: true } })).status()).toBe(200);
  const context = await browser.newContext();
  try {
    const member = await context.newPage();
    await login(member, application, 'member');
    await member.goto(messageURL(application, history.storeId, history.id));
    await expect(member.getByRole('button', { name: '认领并接管', exact: true })).toBeEnabled();
    expect((await page.request.post(grantURL, { headers: { origin: application.baseURL }, data: { expectedGranted: true, granted: false } })).status()).toBe(200);
    const rejected = member.waitForResponse(response => response.url() === commandURL(application, history.id) && response.status() === 404);
    await member.getByRole('button', { name: '认领并接管', exact: true }).click();
    await rejected;
    await expect(member.getByRole('heading', { name: `会话 ${history.threadId}`, exact: true })).toHaveCount(0);
    await expect(member.getByRole('button', { name: '认领并接管', exact: true })).toHaveCount(0);
    await expect.poll(() => new URL(member.url()).searchParams.has('conversation')).toBe(false);
    expect((await member.request.get(controlURL(application, history.id))).status()).toBe(404);
    expect((await readControl(page, application, history.id)).state.version).toBe(0);
    expect(application.storeRequests).toEqual([]);
  } finally { await context.close(); }
});

test('a resolved conversation can be reopened without losing its human reception or assigned member', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  await page.goto(messageURL(application, history.storeId, history.id));
  await page.getByRole('button', { name: '认领并接管', exact: true }).click();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('我负责', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '标记已解决', exact: true }).click();
  await page.getByRole('dialog', { name: '标记会话已解决？', exact: true }).getByRole('button', { name: '确认解决', exact: true }).click();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('已解决', { exact: true })).toBeVisible();
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 2, controlEpoch: 2, sequence: 2, lifecycle: 'resolved', reception: 'human', assignedMemberId: 'owner-a' });
  await expect(page.getByRole('button', { name: '重新打开', exact: true })).toBeVisible();
  const submissions: { expectedVersion: number; action: string }[] = [];
  await page.route(commandURL(application, history.id), async route => { submissions.push(route.request().postDataJSON()); await route.continue(); });
  await page.getByRole('button', { name: '重新打开', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('待回复', { exact: true })).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({ expectedVersion: 2, action: 'reopen' });
  expect((await readControl(page, application, history.id)).state).toMatchObject({ schemaVersion: 2, version: 3, controlEpoch: 3, sequence: 3, lifecycle: 'open', workStatus: 'needs_reply', reception: 'human', assignedMemberId: 'owner-a' });
  await page.reload();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('待回复', { exact: true })).toBeVisible();
  await expect(page.getByText('人工处理', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('我负责', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新打开', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '标记已解决', exact: true })).toBeEnabled();
  await screenshot(page, 'reopened-conversation-desktop');
  expect(application.storeRequests).toEqual([]);
});

test('work status survives refresh and claim, clears on resolution and resets when reopened', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  await page.goto(messageURL(application, history.storeId, history.id));
  const status = page.getByLabel('当前处理状态', { exact: true });
  await expect(status.getByText('待回复', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '返回待回复', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '等待消费者', exact: true }).click();
  await expect(status.getByText('等待消费者', { exact: true })).toBeVisible();
  expect((await readControl(page, application, history.id)).state).toMatchObject({ schemaVersion: 2, version: 1, lifecycle: 'open', workStatus: 'waiting_customer', reception: 'paused', assignedMemberId: null });
  await page.reload();
  await expect(status.getByText('等待消费者', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '等待消费者', exact: true })).toHaveCount(0);
  await screenshot(page, 'waiting-customer-desktop');
  await page.getByRole('button', { name: '认领并接管', exact: true }).click();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('我负责', { exact: true })).toBeVisible();
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 2, workStatus: 'waiting_customer', reception: 'human', assignedMemberId: 'owner-a' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '等待内部', exact: true }).click();
  await expect(status.getByText('等待内部', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '等待内部', exact: true })).toHaveCount(0);
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 3, workStatus: 'waiting_internal', reception: 'human', assignedMemberId: 'owner-a' });
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await screenshot(page, 'waiting-internal-mobile');
  await page.getByRole('button', { name: '返回待回复', exact: true }).click();
  await expect(status.getByText('待回复', { exact: true })).toBeVisible();
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 4, workStatus: 'needs_reply' });
  await page.getByRole('button', { name: '标记已解决', exact: true }).click();
  await page.getByRole('dialog', { name: '标记会话已解决？', exact: true }).getByRole('button', { name: '确认解决', exact: true }).click();
  await expect(status.getByText('已解决', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(等待消费者|等待内部|返回待回复)$/ })).toHaveCount(0);
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 5, lifecycle: 'resolved', workStatus: null, reception: 'human', assignedMemberId: 'owner-a' });
  await page.getByRole('button', { name: '重新打开', exact: true }).click();
  await expect(status.getByText('待回复', { exact: true })).toBeVisible();
  expect((await readControl(page, application, history.id)).state).toMatchObject({ schemaVersion: 2, version: 6, controlEpoch: 6, sequence: 6, lifecycle: 'open', workStatus: 'needs_reply', reception: 'human', assignedMemberId: 'owner-a' });
  expect(application.storeRequests).toEqual([]);
});


test('transfer assigns an eligible teammate, cancels without writing and preserves work status on mobile', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  expect((await readControl(page, application, history.id)).state.version).toBe(0);
  await page.goto(messageURL(application, history.storeId, history.id));
  await expect(page.getByRole('button', { name: '分配负责人', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '等待内部', exact: true }).click();
  await expect(page.getByLabel('当前处理状态', { exact: true }).getByText('等待内部', { exact: true })).toBeVisible();
  let submissions = 0;
  await page.route(commandURL(application, history.id), async route => { submissions++; await route.continue(); });
  await page.getByRole('button', { name: '分配负责人', exact: true }).click();
  const assign = page.getByRole('dialog', { name: '分配负责人', exact: true });
  await expect(assign.getByLabel('接手成员', { exact: true }).locator('option[value="admin-a"]')).toHaveCount(1);
  await assign.getByLabel('接手成员', { exact: true }).selectOption('admin-a');
  await assign.getByLabel('转交原因', { exact: true }).fill('  请协助核实商品说明  ');
  await assign.getByRole('button', { name: '取消', exact: true }).click();
  expect(submissions).toBe(0);
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 1, assignedMemberId: null });
  await page.getByRole('button', { name: '分配负责人', exact: true }).click();
  await assign.getByLabel('接手成员', { exact: true }).selectOption('admin-a');
  await assign.getByLabel('转交原因', { exact: true }).fill('  请协助核实商品说明  ');
  await screenshot(page, 'transfer-dialog-desktop');
  await assign.getByRole('button', { name: '确认转交', exact: true }).click();
  await expect(assign).toHaveCount(0);
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('负责人：Fixture Admin', { exact: true })).toBeVisible();
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 2, workStatus: 'waiting_internal', reception: 'human', assignedMemberId: 'admin-a' });
  expect(submissions).toBe(1);
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '转交会话', exact: true }).click();
  const transfer = page.getByRole('dialog', { name: '转交会话', exact: true });
  await expect(transfer.getByLabel('接手成员', { exact: true }).locator('option[value="owner-a"]')).toHaveCount(1);
  await expect(transfer.getByLabel('接手成员', { exact: true }).locator('option[value="admin-a"]')).toHaveCount(0);
  await transfer.getByLabel('接手成员', { exact: true }).selectOption('owner-a');
  await transfer.getByLabel('转交原因', { exact: true }).fill('信息已确认，继续跟进');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await screenshot(page, 'transfer-dialog-mobile');
  await transfer.getByRole('button', { name: '确认转交', exact: true }).click();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('我负责', { exact: true })).toBeVisible();
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 3, workStatus: 'waiting_internal', reception: 'human', assignedMemberId: 'owner-a' });
  expect(submissions).toBe(2);
  expect(application.storeRequests).toEqual([]);
});

test('a revoked transfer target is rejected and disappears when eligible members are reloaded', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  const grantURL = `${application.baseURL}/api/companies/company-a/stores/${history.storeId}/grants/member-a`;
  expect((await page.request.post(grantURL, { headers: { origin: application.baseURL }, data: { expectedGranted: false, granted: true } })).status()).toBe(200);
  await page.goto(messageURL(application, history.storeId, history.id));
  await page.getByRole('button', { name: '分配负责人', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分配负责人', exact: true });
  await expect(dialog.getByLabel('接手成员', { exact: true }).locator('option[value="member-a"]')).toHaveCount(1);
  await dialog.getByLabel('接手成员', { exact: true }).selectOption('member-a');
  await dialog.getByLabel('转交原因', { exact: true }).fill('请协助跟进');
  expect((await page.request.post(grantURL, { headers: { origin: application.baseURL }, data: { expectedGranted: true, granted: false } })).status()).toBe(200);
  let submissions = 0;
  await page.route(commandURL(application, history.id), async route => { submissions++; await route.continue(); });
  const denied = page.waitForResponse(response => response.url() === commandURL(application, history.id) && response.status() === 409);
  await dialog.getByRole('button', { name: '确认转交', exact: true }).click();
  expect((await (await denied).json()).error.code).toBe('TRANSFER_TARGET_UNAVAILABLE');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('该成员当前无法接手此会话，请重新选择。 已读取最新会话状态。', { exact: true })).toBeVisible();
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 0, assignedMemberId: null });
  await page.getByRole('button', { name: '分配负责人', exact: true }).click();
  await expect(dialog.getByLabel('接手成员', { exact: true }).locator('option[value="admin-a"]')).toHaveCount(1);
  await expect(dialog.getByLabel('接手成员', { exact: true }).locator('option[value="member-a"]')).toHaveCount(0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(submissions).toBe(1);
  expect(application.storeRequests).toEqual([]);
});

test('transfer freezes its dialog version and a lost accepted reply never repeats the command', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  await page.goto(messageURL(application, history.storeId, history.id));
  await page.getByRole('button', { name: '分配负责人', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分配负责人', exact: true });
  await expect(dialog.getByLabel('接手成员', { exact: true }).locator('option[value="admin-a"]')).toHaveCount(1);
  await dialog.getByLabel('接手成员', { exact: true }).selectOption('admin-a');
  await dialog.getByLabel('转交原因', { exact: true }).fill('请核实规格');
  const polled = page.waitForResponse(async response => response.url() === controlURL(application, history.id) && response.status() === 200 && (await response.json()).control.state.version === 1, { timeout: 15_000 });
  expect((await command(page, application, history.id, 0, 'takeover')).status()).toBe(200);
  await polled;
  const submissions: { expectedVersion: number; action: string; reason: string; targetMemberId: string }[] = [];
  await page.route(commandURL(application, history.id), async route => { submissions.push(route.request().postDataJSON()); await route.continue(); });
  const conflict = page.waitForResponse(response => response.url() === commandURL(application, history.id) && response.status() === 409);
  await dialog.getByRole('button', { name: '确认转交', exact: true }).click();
  expect((await (await conflict).json()).error.code).toBe('CONVERSATION_CHANGED');
  await expect(dialog).toHaveCount(0);
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({ expectedVersion: 0, action: 'transfer', targetMemberId: 'admin-a', reason: '请核实规格' });
  await page.unroute(commandURL(application, history.id));
  await page.getByRole('button', { name: '分配负责人', exact: true }).click();
  await dialog.getByLabel('接手成员', { exact: true }).selectOption('admin-a');
  await dialog.getByLabel('转交原因', { exact: true }).fill('  请继续处理  ');
  await page.route(commandURL(application, history.id), async route => {
    submissions.push(route.request().postDataJSON());
    const accepted = await route.fetch();
    expect(accepted.status()).toBe(200);
    await route.abort('failed');
  });
  await dialog.getByRole('button', { name: '确认转交', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('提交结果尚未确认，已重新读取会话状态。请核对后再操作。', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('负责人：Fixture Admin', { exact: true })).toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toMatchObject({ expectedVersion: 1, action: 'transfer', targetMemberId: 'admin-a', reason: '请继续处理' });
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 2, reception: 'human', assignedMemberId: 'admin-a' });
  expect(application.storeRequests).toEqual([]);
});

test('transfer member pagination loads qualified store members and can assign someone from the next page', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  await application.seedTransferMembers(history.storeId);
  const candidatesURL = `${application.baseURL}/api/companies/company-a/conversations/${history.id}/transfer-targets`;
  const first = await page.request.get(`${candidatesURL}?offset=0`);
  expect(first.status()).toBe(200);
  const firstBody = await first.json();
  expect(firstBody.targets).toHaveLength(100);
  expect(firstBody.nextOffset).toBe(100);
  const next = await page.request.get(`${candidatesURL}?offset=100`);
  expect(next.status()).toBe(200);
  const nextBody = await next.json();
  expect(nextBody.targets).toHaveLength(3);
  expect(nextBody.nextOffset).toBeNull();
  const target = nextBody.targets[2].memberId;
  await page.goto(messageURL(application, history.storeId, history.id));
  await page.getByRole('button', { name: '分配负责人', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分配负责人', exact: true });
  await expect(dialog.getByRole('button', { name: '加载更多成员', exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('接手成员', { exact: true }).locator(`option[value="${target}"]`)).toHaveCount(0);
  await dialog.getByRole('button', { name: '加载更多成员', exact: true }).click();
  await expect(dialog.getByLabel('接手成员', { exact: true }).locator(`option[value="${target}"]`)).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: '加载更多成员', exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('接手成员', { exact: true }).locator('option[value="member-a"]')).toHaveCount(0);
  await dialog.getByLabel('接手成员', { exact: true }).selectOption(target);
  await dialog.getByLabel('转交原因', { exact: true }).fill('分页成员接手');
  await dialog.getByRole('button', { name: '确认转交', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 1, assignedMemberId: target, reception: 'human' });
  expect(application.storeRequests).toEqual([]);
});


test('assignee identity refreshes without changing control versions and removed membership is never reassociated', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  await page.goto(messageURL(application, history.storeId, history.id));
  await page.getByRole('button', { name: '认领并接管', exact: true }).click();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('我负责', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('负责人：Fixture Owner', { exact: true })).toBeVisible();
  const grantURL = `${application.baseURL}/api/companies/company-a/stores/${history.storeId}/grants/member-a`;
  expect((await page.request.post(grantURL, { headers: { origin: application.baseURL }, data: { expectedGranted: false, granted: true } })).status()).toBe(200);
  const assigned = await page.request.post(commandURL(application, history.id), {
    headers: { origin: application.baseURL }, data: { commandId: crypto.randomUUID(), expectedVersion: 1, action: 'transfer', targetMemberId: 'member-a', reason: '由同事继续跟进' },
  });
  expect(assigned.status()).toBe(200);
  const baseline = (await readControl(page, application, history.id)).state;
  expect(baseline).toMatchObject({ version: 2, assignedMemberId: 'member-a' });
  await page.reload();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('负责人：Fixture Member', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('我负责', { exact: true })).toHaveCount(0);
  await application.renameFixtureMember('   ');
  await page.reload();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('负责人：未填写姓名', { exact: true })).toBeVisible();
  expect((await readControl(page, application, history.id)).state).toEqual(baseline);
  const longName = '负责跨语言售后问题处理的电商客服同事'.repeat(6);
  await application.renameFixtureMember(longName);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText(`负责人：${longName}`, { exact: true })).toBeVisible();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  expect((await readControl(page, application, history.id)).state).toEqual(baseline);
  await screenshot(page, 'assignee-long-name-mobile');
  expect((await page.request.post(grantURL, { headers: { origin: application.baseURL }, data: { expectedGranted: true, granted: false } })).status()).toBe(200);
  // The polling response must refresh metadata even when the control version stays unchanged.
  await expect(page.getByText('当前无法接手', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText(`负责人：${longName}`, { exact: true })).toBeVisible();
  const ineligible = await readControl(page, application, history.id);
  expect(ineligible.state).toEqual(baseline);
  expect(ineligible.assignee).toEqual({ memberId: 'member-a', name: longName, status: 'ineligible' });
  await application.rejoinFixtureMember(history.storeId);
  await page.reload();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('负责人已移除', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText(`负责人：${longName}`, { exact: true })).toHaveCount(0);
  await expect(page.getByText('当前无法接手', { exact: true })).toHaveCount(0);
  const removed = await readControl(page, application, history.id);
  expect(removed.state).toEqual(baseline);
  expect(removed.assignee).toEqual({ memberId: 'member-a', name: null, status: 'removed' });
  await screenshot(page, 'assignee-removed-mobile');
  await page.getByRole('button', { name: '转交会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '转交会话', exact: true });
  await expect(dialog.getByLabel('接手成员', { exact: true }).locator('option[value="member-a-rejoined"]')).toHaveCount(1);
  await expect(dialog.getByLabel('接手成员', { exact: true }).locator('option[value="member-a"]')).toHaveCount(0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect((await readControl(page, application, history.id)).state).toEqual(baseline);
  expect(application.storeRequests).toEqual([]);
});

test('an accepted command followed by a presentation failure is reread without resubmitting', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  await page.goto(messageURL(application, history.storeId, history.id));
  await expect(page.getByRole('button', { name: '认领并接管', exact: true })).toBeEnabled();
  let submissions = 0;
  await page.route(commandURL(application, history.id), async route => {
    submissions++;
    const accepted = await route.fetch();
    expect(accepted.status()).toBe(200);
    // Exercise the UI's presentation-failure response after a real commit. HTTP tests inject the actual metadata read failure.
    await route.fulfill({ status: 503, json: { error: { code: 'OPERATION_UNCONFIRMED' } } });
  });
  await page.getByRole('button', { name: '认领并接管', exact: true }).click();
  await expect(page.getByText('提交结果尚未确认，已重新读取会话状态。请核对后再操作。', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('负责人：Fixture Owner', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('我负责', { exact: true })).toBeVisible();
  expect(submissions).toBe(1);
  const current = await readControl(page, application, history.id);
  expect(current.state).toMatchObject({ version: 1, assignedMemberId: 'owner-a' });
  expect(current.assignee).toEqual({ memberId: 'owner-a', name: 'Fixture Owner', status: 'eligible' });
  await page.reload();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('负责人：Fixture Owner', { exact: true })).toBeVisible();
  expect(submissions).toBe(1);
  expect(application.storeRequests).toEqual([]);
});


test('internal notes preserve plain text and author snapshots without reopening resolved conversations', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  expect((await readControl(page, application, history.id)).state.version).toBe(0);
  await page.goto(messageURL(application, history.storeId, history.id));
  await expect(page.getByRole('button', { name: '内部备注', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '内部备注', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '内部备注', exact: true });
  await expect(dialog.getByText('仅团队可见，记录处理线索与交接事项。备注不会发送给消费者。', { exact: true })).toBeVisible();
  const body = '<script>window.noteInjected = true</script>\n**内部讨论**：请核实商品说明。';
  await dialog.getByLabel('备注内容', { exact: true }).fill(body);
  await dialog.getByRole('button', { name: '保存内部备注', exact: true }).click();
  await expect(dialog.getByText(body, { exact: true })).toHaveCount(1);
  await expect(dialog.getByText('Fixture Owner', { exact: true })).toBeVisible();
  await expect(dialog.locator('script')).toHaveCount(0);
  expect(await page.evaluate('window.noteInjected')).toBeUndefined();
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 1, sequence: 1, controlEpoch: 0, lifecycle: 'open', reception: 'paused', assignedMemberId: null });
  await screenshot(page, 'notes-desktop');
  await application.renameFixtureMember('更名后的负责人', 'owner');
  await page.reload();
  await page.getByRole('button', { name: '内部备注', exact: true }).click();
  await expect(dialog.getByText(body, { exact: true })).toHaveCount(1);
  await expect(dialog.getByText('Fixture Owner', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '标记已解决', exact: true }).click();
  await page.getByRole('dialog', { name: '标记会话已解决？', exact: true }).getByRole('button', { name: '确认解决', exact: true }).click();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('已解决', { exact: true })).toBeVisible();
  const resolved = (await readControl(page, application, history.id)).state;
  expect(resolved).toMatchObject({ version: 2, sequence: 2, controlEpoch: 1, lifecycle: 'resolved' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '内部备注', exact: true }).click();
  await dialog.getByLabel('备注内容', { exact: true }).fill('已解决后的补充说明');
  await dialog.getByRole('button', { name: '保存内部备注', exact: true }).click();
  await expect(dialog.getByText('已解决后的补充说明', { exact: true })).toHaveCount(1);
  await expect(dialog.getByText('更名后的负责人', { exact: true })).toBeVisible();
  const latest = (await readControl(page, application, history.id)).state;
  expect(latest).toEqual({ ...resolved, version: 3, sequence: 3, updatedAt: latest.updatedAt });
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await screenshot(page, 'notes-mobile');
  await page.reload();
  await expect(page.getByRole('region', { name: '会话内容', exact: true }).getByText('已解决', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '内部备注', exact: true }).click();
  await expect(dialog.getByText(body, { exact: true })).toHaveCount(1);
  await expect(dialog.getByText('已解决后的补充说明', { exact: true })).toHaveCount(1);
  expect(application.storeRequests).toEqual([]);
});

test('an unconfirmed note preserves its original command and requires an explicit idempotent retry', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  await page.goto(messageURL(application, history.storeId, history.id));
  await page.getByRole('button', { name: '内部备注', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '内部备注', exact: true });
  const body = '  请保留原文\n响应丢失后只记录一次  ';
  await dialog.getByLabel('备注内容', { exact: true }).fill(body);
  const submissions: { commandId: string; expectedVersion: number; action: string; body: string }[] = [];
  await page.route(commandURL(application, history.id), async route => {
    submissions.push(route.request().postDataJSON());
    if (submissions.length === 1) {
      const accepted = await route.fetch();
      expect(accepted.status()).toBe(200);
      await route.abort('failed');
    } else await route.continue();
  });
  await dialog.getByRole('button', { name: '保存内部备注', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '重试保存', exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('备注内容', { exact: true })).toHaveValue(body);
  expect(submissions).toHaveLength(1);
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 1, sequence: 1, controlEpoch: 0 });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '内部备注', exact: true }).click();
  await expect(dialog.getByLabel('备注内容', { exact: true })).toHaveValue(body);
  await expect(dialog.getByRole('button', { name: '重试保存', exact: true })).toBeEnabled();
  expect(submissions).toHaveLength(1);
  await dialog.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '保存内部备注', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('备注内容', { exact: true })).toHaveValue('');
  await expect(dialog.getByText(body, { exact: true })).toHaveCount(1);
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[0]).toMatchObject({ action: 'add_note', expectedVersion: 0, body });
  const response = await page.request.get(`${application.baseURL}/api/companies/company-a/conversations/${history.id}/notes`);
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.notes).toHaveLength(1);
  expect(result.notes[0]).toMatchObject({ commandId: submissions[0].commandId, sequence: 1, body });
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 1, sequence: 1, controlEpoch: 0 });
  expect(application.storeRequests).toEqual([]);
});

test('revoked store access removes internal notes and rejects a pending note without disclosing another company', async ({ page, browser, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  const notesURL = `${application.baseURL}/api/companies/company-a/conversations/${history.id}/notes`;
  expect((await page.request.post(commandURL(application, history.id), {
    headers: { origin: application.baseURL }, data: { commandId: crypto.randomUUID(), expectedVersion: 0, action: 'add_note', body: '只有授权团队可见的说明' },
  })).status()).toBe(200);
  expect((await page.request.get(`${application.baseURL}/api/companies/company-b/conversations/${history.id}/notes`)).status()).toBe(404);
  const grantURL = `${application.baseURL}/api/companies/company-a/stores/${history.storeId}/grants/member-a`;
  expect((await page.request.post(grantURL, { headers: { origin: application.baseURL }, data: { expectedGranted: false, granted: true } })).status()).toBe(200);
  const context = await browser.newContext();
  try {
    const member = await context.newPage();
    await login(member, application, 'member');
    await member.goto(messageURL(application, history.storeId, history.id));
    await member.getByRole('button', { name: '内部备注', exact: true }).click();
    const dialog = member.getByRole('dialog', { name: '内部备注', exact: true });
    await expect(dialog.getByText('只有授权团队可见的说明', { exact: true })).toBeVisible();
    await dialog.getByLabel('备注内容', { exact: true }).fill('撤权后不应保存的正文');
    expect((await page.request.post(grantURL, { headers: { origin: application.baseURL }, data: { expectedGranted: true, granted: false } })).status()).toBe(200);
    const rejected = member.waitForResponse(response => response.url() === commandURL(application, history.id) && response.status() === 404);
    await dialog.getByRole('button', { name: '保存内部备注', exact: true }).click();
    await rejected;
    await expect(dialog).toHaveCount(0);
    await expect(member.getByText('只有授权团队可见的说明', { exact: true })).toHaveCount(0);
    await expect.poll(() => new URL(member.url()).searchParams.has('conversation')).toBe(false);
    expect((await member.request.get(notesURL)).status()).toBe(404);
    expect((await (await page.request.get(notesURL)).json()).notes).toHaveLength(1);
    expect(application.storeRequests).toEqual([]);
  } finally { await context.close(); }
});

test('internal notes use stable newest-first pages and can return to the latest notes', async ({ page, application }) => {
  await login(page, application);
  const history = await seed(page, application);
  for (let index = 1; index <= 21; index++) {
    const saved = await page.request.post(commandURL(application, history.id), {
      headers: { origin: application.baseURL }, data: { commandId: crypto.randomUUID(), expectedVersion: index - 1, action: 'add_note', body: `分页备注 ${index}` },
    });
    expect(saved.status()).toBe(200);
  }
  await page.goto(messageURL(application, history.storeId, history.id));
  await page.getByRole('button', { name: '内部备注', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '内部备注', exact: true });
  await expect(dialog.getByText('分页备注 21', { exact: true })).toBeVisible();
  await expect(dialog.getByText('分页备注 1', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '查看更早备注', exact: true }).click();
  await expect(dialog.getByText('分页备注 1', { exact: true })).toBeVisible();
  await expect(dialog.getByText('分页备注 21', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '返回较新备注', exact: true }).click();
  await expect(dialog.getByText('分页备注 21', { exact: true })).toBeVisible();
  await expect(dialog.getByText('分页备注 1', { exact: true })).toHaveCount(0);
  expect((await readControl(page, application, history.id)).state).toMatchObject({ version: 21, sequence: 21, controlEpoch: 0, lifecycle: 'open', assignedMemberId: null });
  expect(application.storeRequests).toEqual([]);
});
