import { test as base, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';
import { fragmentedMessageParts, messageImageURL, unsafeMessageText } from '../fixtures/web-identity/conversation-history.ts';

type Application = Awaited<ReturnType<typeof startLocalApplication>>;
const test = base.extend<{ application: Application }>({
  application: [async ({}, use) => {
    const application = await startLocalApplication(true, { mail: true, team: 'roles', stores: 'configured', sync: true, control: true });
    try { await use(application); } finally { await application.close(); }
  }, { timeout: 90_000 }],
});

async function login(page: Page, application: Application, actor = 'owner') {
  await page.goto(`${application.baseURL}/login`);
  await page.getByLabel('邮箱', { exact: true }).fill(`${actor}@example.invalid`);
  await page.getByLabel('密码', { exact: true }).fill(application.password).catch(() => { throw new Error('Synthetic password input failed'); });
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '测试公司 A', exact: true }).click();
}

async function store(page: Page, application: Application, name = '消息测试店', clientId = '910001') {
  const id = crypto.randomUUID();
  const response = await page.request.post(`${application.baseURL}/api/companies/company-a/stores`, {
    headers: { origin: application.baseURL }, data: { id, name, clientId, apiKey: crypto.randomUUID() },
  });
  expect(response.ok()).toBe(true);
  return id;
}

const messagesURL = (application: Application, storeId?: string, conversationId?: string) => {
  const url = new URL('/workspace/messages', application.baseURL);
  if (storeId) url.searchParams.set('store', storeId);
  if (conversationId) url.searchParams.set('conversation', conversationId);
  return url.toString();
};
const original = (index: number) => `原始消息 ${String(index).padStart(3, '0')}\nОригинальное сообщение ${String(index).padStart(3, '0')}`;
async function screenshot(page: Page, name: string) {
  const directory = fileURLToPath(new URL('../../test-results/stage4b6-2026-10-09/', import.meta.url));
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}${name}.png`, fullPage: true, animations: 'disabled' });
}

test('the messages route presents a real empty message center rather than the workspace fallback', async ({ page, application }) => {
  await login(page, application);
  await page.goto(`${application.baseURL}/workspace/messages`);
  await expect(page.getByRole('heading', { name: '消息中心', exact: true })).toBeVisible();
  await expect(page.getByText('暂无已导入会话', { exact: true })).toBeVisible();
  await expect(page.getByText('选择一个会话', { exact: true })).toBeVisible();
  await page.getByLabel('精确标识', { exact: true }).fill('no-such-thread');
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await expect(page.getByText('没有匹配的会话', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await expect(page.getByText('暂无已导入会话', { exact: true })).toBeVisible();
});

test('the real coordinator imports originals that remain readable after the store is paused', async ({ page, application }) => {
  await login(page, application);
  const id = await store(page, application);
  await page.goto(`${application.baseURL}/workspace/stores?store=${id}`);
  await page.getByRole('button', { name: '检查只读能力', exact: true }).click();
  await expect(page.getByRole('button', { name: '启用会话同步', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '启用会话同步', exact: true }).click();
  await page.getByRole('dialog', { name: '启用会话同步', exact: true }).getByRole('button', { name: '确认启用', exact: true }).click();
  await expect.poll(async () => {
    const response = await page.request.get(`${application.baseURL}/api/companies/company-a/stores/${id}/sync`);
    const result = (await response.json()).sync;
    return [result.conversationCount, result.messageCount];
  }, { timeout: 20_000 }).toEqual([2, 6]);
  await page.goto(messagesURL(application, id));
  await expect(page.getByLabel('筛选店铺', { exact: true })).toHaveValue(id);
  await expect(page.getByRole('button', { name: '打开会话 buyer-a', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开会话 buyer-b', exact: true })).toBeVisible();
  await expect(page.getByText('support-only', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '打开会话 buyer-a', exact: true }).click();
  await expect(page.getByRole('region', { name: '消息记录', exact: true }).getByText('Синтетический вопрос о товаре', { exact: true })).toHaveCount(3);
  const selectedURL = page.url();
  expect(new URL(selectedURL).searchParams.get('conversation')).toBeTruthy();
  await page.getByLabel('精确标识', { exact: true }).fill('buyer-a');
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开会话 buyer-b', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开会话 buyer-a', exact: true })).toBeVisible();
  await page.goto(`${application.baseURL}/workspace/stores?store=${id}`);
  await page.getByRole('button', { name: '暂停连接', exact: true }).click();
  await page.getByRole('dialog', { name: '暂停连接', exact: true }).getByRole('button', { name: '确认暂停连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复连接', exact: true })).toBeVisible();
  await page.goto(selectedURL);
  await expect(page.getByRole('heading', { name: '会话 buyer-a', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '消息记录', exact: true }).getByText('Синтетический вопрос о товаре', { exact: true })).toHaveCount(3);
  expect(application.storeRequests.some(request => request.path === '/v3/chat/history')).toBe(true);
  expect(application.storeRequests.some(request => request.path === '/v3/chat/history' && request.body?.chat_id === 'support-only')).toBe(false);
});

test('original content is inert and bounded history pages survive equal timestamps and explicit refresh', async ({ page, application }) => {
  await login(page, application);
  const id = await store(page, application);
  const history = await application.seedConversationHistory(id, { unsafe: true });
  const imageRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('message-fixture.invalid')) imageRequests.push(request.url()); });
  await page.goto(messagesURL(application, id, history.id));
  const region = page.getByRole('region', { name: '消息记录', exact: true });
  await expect(region.getByText(unsafeMessageText, { exact: true })).toBeVisible();
  await expect(region.getByText(original(6), { exact: true })).toBeAttached();
  await expect(region.getByText(original(1), { exact: true })).toHaveCount(0);
  expect(await page.evaluate('window.__messageInjected === undefined')).toBe(true);
  await expect(region.locator(`img[src="${messageImageURL}"]`)).toHaveCount(0);
  await page.getByRole('button', { name: '查看更早消息', exact: true }).click();
  await expect(region.getByText(original(1), { exact: true })).toBeVisible();
  await expect(region.getByText(original(5), { exact: true })).toBeVisible();
  await expect(region.getByText(original(6), { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '查看更早消息', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '返回较新消息', exact: true }).click();
  await expect(region.getByText(unsafeMessageText, { exact: true })).toBeVisible();
  await history.appendMessage();
  await page.getByRole('button', { name: '刷新消息', exact: true }).click();
  await expect(region.getByText(original(56), { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '返回较新消息', exact: true })).toBeDisabled();
  expect(imageRequests).toEqual([]);
  expect(application.storeRequests).toEqual([]);
  await page.goto(messagesURL(application, id, history.emptyId));
  await expect(page.getByText('暂无已导入消息', { exact: true })).toBeVisible();
  await page.getByLabel('查找方式', { exact: true }).selectOption({ label: '订单号' });
  await page.getByLabel('精确标识', { exact: true }).fill('SYNTHETIC-ORDER-001');
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await expect(page.getByRole('button', { name: `打开会话 ${history.threadId}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `打开会话 ${history.emptyThreadId}`, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toHaveCount(0);
});

test('store grants isolate histories and revocation clears the open conversation', async ({ page, browser, application }) => {
  await login(page, application);
  const first = await store(page, application, '已授权消息店');
  const second = await store(page, application, '未授权消息店', '910002');
  const allowed = await application.seedConversationHistory(first);
  const denied = await application.seedConversationHistory(second);
  const grantURL = `${application.baseURL}/api/companies/company-a/stores/${first}/grants/member-a`;
  expect((await page.request.post(grantURL, { headers: { origin: application.baseURL }, data: { expectedGranted: false, granted: true } })).ok()).toBe(true);
  const context = await browser.newContext();
  try {
    const member = await context.newPage();
    await login(member, application, 'member');
    await member.goto(messagesURL(application, first, allowed.id));
    await expect(member.getByRole('heading', { name: `会话 ${allowed.threadId}`, exact: true })).toBeVisible();
    await expect(member.getByLabel('筛选店铺', { exact: true }).getByRole('option', { name: '未授权消息店', exact: true })).toHaveCount(0);
    expect((await member.request.get(`${application.baseURL}/api/companies/company-a/conversations/${denied.id}`)).status()).toBe(404);
    await expect(member.getByRole('region', { name: '消息记录', exact: true }).getByText(original(55), { exact: true })).toBeVisible();
    expect((await page.request.post(grantURL, { headers: { origin: application.baseURL }, data: { expectedGranted: true, granted: false } })).ok()).toBe(true);
    await member.getByRole('button', { name: '刷新消息', exact: true }).click();
    await expect(member.getByRole('heading', { name: `会话 ${allowed.threadId}`, exact: true })).toHaveCount(0);
    await expect(member.getByText(original(55), { exact: true })).toHaveCount(0);
    await expect(member.getByRole('button', { name: `打开会话 ${allowed.threadId}`, exact: true })).toHaveCount(0);
    expect((await member.request.get(`${application.baseURL}/api/companies/company-a/conversations/${allowed.id}/messages`)).status()).toBe(404);
  } finally { await context.close(); }
});

test('message fragments retain the entire original text with bounded DOM nodes', async ({ page, application }) => {
  await login(page, application);
  const id = await store(page, application);
  const history = await application.seedConversationHistory(id, { fragments: true });
  await page.goto(messagesURL(application, id, history.id));
  const bubble = page.getByRole('region', { name: '消息记录', exact: true }).locator('[data-slot="bubble-content"]').last();
  await expect(bubble).toContainText(fragmentedMessageParts.at(-1)!);
  expect(await bubble.locator('*').count()).toBeLessThan(10);
  expect(await bubble.textContent()).toBe(fragmentedMessageParts.join('\n'));
});

test('the read-only center has independent scrolling, keyboard details and usable desktop and mobile layouts', async ({ page, application }) => {
  await login(page, application);
  const id = await store(page, application);
  const history = await application.seedConversationHistory(id, { neighbors: 50 });
  await page.goto(messagesURL(application, id));
  const list = page.getByRole('complementary', { name: '会话列表', exact: true });
  const open = list.getByRole('button', { name: `打开会话 ${history.threadId}`, exact: true });
  await open.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: `会话 ${history.threadId}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '下一页会话', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '下一页会话', exact: true }).click();
  await expect(list.getByRole('button', { name: /^打开会话 / })).toHaveCount(2);
  await page.getByRole('button', { name: '上一页会话', exact: true }).click();
  await expect(list.getByRole('button', { name: /^打开会话 / })).toHaveCount(50);
  await open.click();
  const scroll = async (regionName: string) => page.getByRole(regionName === '会话列表' ? 'complementary' : 'region', { name: regionName, exact: true }).evaluate(region => {
    const candidate = [region, ...region.querySelectorAll('*')].find(element => /auto|scroll/.test(element.ownerDocument.defaultView!.getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight);
    if (!candidate) return false;
    candidate.scrollTop = 100;
    return candidate.scrollTop > 0;
  });
  expect(await scroll('会话列表')).toBe(true);
  expect(await scroll('消息记录')).toBe(true);
  expect(await page.evaluate('window.scrollY')).toBe(0);
  await screenshot(page, 'messages-desktop-1440');
  await page.setViewportSize({ width: 1366, height: 768 });
  await screenshot(page, 'messages-desktop-1366');
  const details = page.getByRole('button', { name: '会话详情', exact: true });
  await details.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '会话详情', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS('opacity', '1');
  await expect(dialog).toBeInViewport();
  await screenshot(page, 'messages-details-1366');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '会话详情', exact: true })).toBeHidden();
  await expect(details).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: `会话 ${history.threadId}`, exact: true })).toBeVisible();
  await screenshot(page, 'messages-mobile-thread');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await details.click();
  await expect(dialog).toHaveCSS('opacity', '1');
  await expect(dialog).toBeInViewport();
  await screenshot(page, 'messages-mobile-details');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '返回会话列表', exact: true }).click();
  await expect(open).toBeVisible();
  await expect(open).toBeFocused();
  await screenshot(page, 'messages-mobile-list');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
});


async function queueCounts(page: Page, all: number, mine: number, unassigned: number) {
  await expect(page.getByRole('button', { name: '全部会话', exact: true })).toHaveText(`全部${all}`);
  await expect(page.getByRole('button', { name: '我负责', exact: true })).toHaveText(`我负责${mine}`);
  await expect(page.getByRole('button', { name: '未分配', exact: true })).toHaveText(`未分配${unassigned}`);
}

async function applyCommand(page: Page, application: Application, id: string, expectedVersion: number, action: Record<string, string>) {
  const response = await page.request.post(`${application.baseURL}/api/companies/company-a/conversations/${id}/commands`, {
    headers: { origin: application.baseURL }, data: { commandId: crypto.randomUUID(), expectedVersion, ...action },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).control;
}

test('real commands move queue counts while an open conversation remains available', async ({ page, application }) => {
  await login(page, application);
  const id = await store(page, application);
  const first = await application.seedConversationHistory(id);
  const second = await application.seedConversationHistory(id);
  await applyCommand(page, application, first.id, 0, { action: 'claim' });
  await applyCommand(page, application, second.id, 0, { action: 'transfer', targetMemberId: 'admin-a', reason: '交给管理员跟进' });
  await applyCommand(page, application, second.id, 1, { action: 'set_work_status', workStatus: 'waiting_internal' });
  await page.goto(messagesURL(application, id));
  await queueCounts(page, 4, 1, 2);
  const list = page.getByRole('complementary', { name: '会话列表', exact: true });
  const content = page.getByRole('region', { name: '会话内容', exact: true });
  await expect(list.getByRole('button', { name: `打开会话 ${second.threadId}`, exact: true })).toContainText('负责人：Fixture Admin');
  await page.getByRole('button', { name: '未分配', exact: true }).click();
  await expect(page.getByRole('button', { name: '未分配', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await queueCounts(page, 4, 1, 2);
  await expect(list.getByRole('button', { name: /^打开会话 / })).toHaveCount(2);
  await list.getByRole('button', { name: `打开会话 ${first.emptyThreadId}`, exact: true }).click();
  await content.getByRole('button', { name: '认领并接管', exact: true }).click();
  await queueCounts(page, 4, 2, 1);
  await expect(list.getByRole('button', { name: `打开会话 ${first.emptyThreadId}`, exact: true })).toHaveCount(0);
  await expect(content.getByRole('heading', { name: `会话 ${first.emptyThreadId}`, exact: true })).toBeVisible();
  await expect(content.getByText('我负责', { exact: true })).toBeVisible();
  await content.getByRole('button', { name: '等待消费者', exact: true }).click();
  await expect(content.getByLabel('当前处理状态', { exact: true })).toContainText('等待消费者');
  await page.getByRole('button', { name: '我负责', exact: true }).click();
  await queueCounts(page, 4, 2, 1);
  await page.getByLabel('筛选处理状态', { exact: true }).selectOption('waiting_customer');
  await queueCounts(page, 1, 1, 0);
  await expect(list.getByRole('button', { name: /^打开会话 / })).toHaveCount(1);
  await list.getByRole('button', { name: `打开会话 ${first.emptyThreadId}`, exact: true }).click();
  await content.getByRole('button', { name: '标记已解决', exact: true }).click();
  await page.getByRole('dialog', { name: '标记会话已解决？', exact: true }).getByRole('button', { name: '确认解决', exact: true }).click();
  await queueCounts(page, 0, 0, 0);
  await expect(content.getByRole('button', { name: '重新打开', exact: true })).toBeVisible();
  await expect(content.getByRole('heading', { name: `会话 ${first.emptyThreadId}`, exact: true })).toBeVisible();
  await page.getByLabel('筛选处理状态', { exact: true }).selectOption('resolved');
  await queueCounts(page, 1, 1, 0);
  await list.getByRole('button', { name: `打开会话 ${first.emptyThreadId}`, exact: true }).click();
  await content.getByRole('button', { name: '重新打开', exact: true }).click();
  await queueCounts(page, 0, 0, 0);
  await expect(content.getByLabel('当前处理状态', { exact: true })).toContainText('待回复');
  await page.getByLabel('筛选处理状态', { exact: true }).selectOption('all');
  await queueCounts(page, 4, 2, 1);
  await page.reload();
  await queueCounts(page, 4, 2, 1);
  expect(new URL(page.url()).searchParams.get('queue')).toBe('mine');
  expect(application.storeRequests).toEqual([]);
});

test('queue filters reset pagination and recover invalid cursors without mixing search or store scopes', async ({ page, application }) => {
  await login(page, application);
  const firstStore = await store(page, application);
  const first = await application.seedConversationHistory(firstStore, { neighbors: 50 });
  const secondStore = await store(page, application, '第二消息店', '910002');
  await application.seedConversationHistory(secondStore);
  await applyCommand(page, application, first.id, 0, { action: 'claim' });
  const requests: URL[] = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname === '/api/companies/company-a/conversations') requests.push(url); });
  await page.goto(messagesURL(application, firstStore));
  const list = page.getByRole('complementary', { name: '会话列表', exact: true });
  await queueCounts(page, 52, 1, 51);
  await page.getByRole('button', { name: '下一页会话', exact: true }).click();
  await expect(list.getByText('第 2 页', { exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: /^打开会话 / })).toHaveCount(2);
  await queueCounts(page, 52, 1, 51);
  await page.getByRole('button', { name: '我负责', exact: true }).click();
  await expect(list.getByText('第 1 页', { exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: `打开会话 ${first.threadId}`, exact: true })).toBeVisible();
  expect(requests.at(-1)!.searchParams.has('cursor')).toBe(false);
  await queueCounts(page, 52, 1, 51);
  await page.getByLabel('筛选处理状态', { exact: true }).selectOption('waiting_internal');
  await queueCounts(page, 0, 0, 0);
  await page.goBack();
  await expect(page.getByLabel('筛选处理状态', { exact: true })).toHaveValue('all');
  await queueCounts(page, 52, 1, 51);
  await expect(list.getByText('第 1 页', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '全部会话', exact: true }).click();
  await page.getByRole('button', { name: '下一页会话', exact: true }).click();
  await expect(list.getByText('第 2 页', { exact: true })).toBeVisible();
  await page.getByLabel('精确标识', { exact: true }).fill(first.threadId);
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await queueCounts(page, 1, 1, 0);
  await expect(list.getByText('第 1 页', { exact: true })).toBeVisible();
  expect(requests.at(-1)!.searchParams.has('cursor')).toBe(false);
  await page.getByLabel('查找方式', { exact: true }).selectOption('order');
  await page.getByLabel('精确标识', { exact: true }).fill('SYNTHETIC-ORDER-001');
  const orderResult = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/companies/company-a/conversations' && url.searchParams.get('searchField') === 'order';
  });
  await page.getByRole('button', { name: '查找', exact: true }).click();
  expect((await orderResult).status()).toBe(200);
  await queueCounts(page, 1, 1, 0);
  expect(requests.at(-1)!.searchParams.get('searchField')).toBe('order');
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await expect(page.getByLabel('精确标识', { exact: true })).toHaveValue('');
  await queueCounts(page, 52, 1, 51);
  expect(new URL(page.url()).searchParams.has('search')).toBe(false);
  await page.getByLabel('筛选店铺', { exact: true }).selectOption(secondStore);
  await queueCounts(page, 2, 0, 2);
  await page.getByLabel('筛选店铺', { exact: true }).selectOption(firstStore);
  await queueCounts(page, 52, 1, 51);
  let rejected = false;
  await page.route('**/api/companies/company-a/conversations?**', async route => {
    if (!rejected && new URL(route.request().url()).searchParams.has('cursor')) {
      rejected = true; await route.fulfill({ status: 400, json: { error: { code: 'INVALID_REQUEST' } } });
    } else await route.continue();
  });
  await page.getByRole('button', { name: '下一页会话', exact: true }).click();
  await page.getByRole('button', { name: '返回第一页会话', exact: true }).click();
  await queueCounts(page, 52, 1, 51);
  await expect(list.getByText('第 1 页', { exact: true })).toBeVisible();
  expect(requests.at(-1)!.searchParams.has('cursor')).toBe(false);
  await page.setViewportSize({ width: 1366, height: 768 });
  await screenshot(page, 'queues-desktop-1366');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '我负责', exact: true }).click();
  await queueCounts(page, 52, 1, 51);
  await expect(page.getByLabel('筛选处理状态', { exact: true })).toBeInViewport();
  await expect(list.getByRole('button', { name: `打开会话 ${first.threadId}`, exact: true })).toBeVisible();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await screenshot(page, 'queues-mobile-390');
  expect(application.storeRequests).toEqual([]);
});

for (const firstCheck of ['list', 'identity'] as const) test(`queue counts and membership replacement remain scoped when ${firstCheck} checks first`, async ({ page, browser, application }) => {
  await login(page, application);
  const first = await store(page, application, '授权队列店');
  const history = await application.seedConversationHistory(first, { neighbors: 50 });
  const second = await store(page, application, '隐藏队列店', '910002');
  const hidden = await application.seedConversationHistory(second);
  const grantURL = (member: string) => `${application.baseURL}/api/companies/company-a/stores/${first}/grants/${member}`;
  expect((await page.request.post(grantURL('member-a'), { headers: { origin: application.baseURL }, data: { expectedGranted: false, granted: true } })).status()).toBe(200);
  const context = await browser.newContext();
  let releaseIdentity = () => {};
  const observation: { path: string; status: number; cursor: boolean; viewerMemberId?: string }[] = [];
  try {
    const member = await context.newPage();
    await member.clock.install();
    await login(member, application, 'member');
    await applyCommand(member, application, history.id, 0, { action: 'claim' });
    await member.goto(messagesURL(application));
    await queueCounts(member, 52, 1, 51);
    const list = member.getByRole('complementary', { name: '会话列表', exact: true });
    await expect(list.getByRole('button', { name: `打开会话 ${hidden.threadId}`, exact: true })).toHaveCount(0);
    expect((await member.request.get(`${application.baseURL}/api/companies/company-a/conversations?storeId=${second}`)).status()).toBe(404);
    await member.getByRole('button', { name: '下一页会话', exact: true }).click();
    await expect(list.getByText('第 2 页', { exact: true })).toBeVisible();
    await member.route('**/api/companies/company-a/conversations?**', async route => {
      const response = await route.fetch(), body = await response.json(), url = new URL(route.request().url());
      observation.push({ path: url.pathname, status: response.status(), cursor: url.searchParams.has('cursor'), viewerMemberId: body.viewerMemberId });
      await route.fulfill({ response });
    });
    // Advance only the list case; the identity case explicitly triggers foreground revalidation.
    await application.rejoinFixtureMember(first);
    if (firstCheck === 'identity') {
      const identityGate = new Promise<void>(resolve => { releaseIdentity = resolve; });
      await member.route('**/api/workspace-bootstrap', async route => { await identityGate; await route.continue(); });
      const revalidated = member.waitForResponse(response => new URL(response.url()).pathname === '/api/workspace-bootstrap');
      await member.evaluate("Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});window.dispatchEvent(new Event('visibilitychange'));Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});window.dispatchEvent(new Event('visibilitychange'));");
      await expect(member.getByRole('heading', { name: '消息中心', exact: true })).toHaveCount(0);
      releaseIdentity();
      await revalidated;
    } else {
      await member.clock.fastForward(10_000);
    }
    // Foreground identity checks hide the workspace with Activity and preserve its
    // page stack. Both request orders must reject the old member's cursor before
    // an explicit return to the first page can expose the new member's counts.
    await expect(member.getByRole('button', { name: '返回第一页会话', exact: true })).toBeVisible({ timeout: 15_000 });
    expect(observation.some(item => item.cursor && item.status === 400)).toBe(true);
    await expect(member.getByRole('button', { name: '全部会话', exact: true })).toHaveText('全部—');
    await member.getByRole('button', { name: '返回第一页会话', exact: true }).click();
    await queueCounts(member, 52, 0, 51);
    await expect(list.getByText('第 1 页', { exact: true })).toBeVisible();
    await expect(member.getByRole('button', { name: '返回第一页会话', exact: true })).toHaveCount(0);
    expect(observation.some(item => !item.cursor && item.status === 200 && item.viewerMemberId === 'member-a-rejoined')).toBe(true);
    await writeFile(test.info().outputPath('membership-order.json'), JSON.stringify({ firstCheck, observation }, null, 2));
    await expect(list.getByRole('button', { name: `打开会话 ${history.threadId}`, exact: true })).toContainText('负责人已移除');
    await member.getByRole('button', { name: '我负责', exact: true }).click();
    await queueCounts(member, 52, 0, 51);
    await expect(list.getByRole('button', { name: /^打开会话 / })).toHaveCount(0);
    await member.getByRole('button', { name: '未分配', exact: true }).click();
    await expect(list.getByRole('button', { name: `打开会话 ${history.threadId}`, exact: true })).toHaveCount(0);
    await member.getByRole('button', { name: '全部会话', exact: true }).click();
    await list.getByRole('button', { name: `打开会话 ${history.threadId}`, exact: true }).click();
    expect((await page.request.post(grantURL('member-a-rejoined'), { headers: { origin: application.baseURL }, data: { expectedGranted: true, granted: false } })).status()).toBe(200);
    await member.getByRole('button', { name: '刷新消息', exact: true }).click();
    await expect(member.getByRole('heading', { name: `会话 ${history.threadId}`, exact: true })).toHaveCount(0);
    await expect(list.getByRole('button', { name: `打开会话 ${history.threadId}`, exact: true })).toHaveCount(0);
    await queueCounts(member, 0, 0, 0);
    expect(application.storeRequests).toEqual([]);
  } finally { releaseIdentity(); await context.close(); }
});

test('rapid search clearing and store selection never restore the cleared filter', async ({ page, application }) => {
  await login(page, application);
  const firstStore = await store(page, application, '快速筛选第一店');
  await application.seedConversationHistory(firstStore);
  const secondStore = await store(page, application, '快速筛选第二店', '910002');
  await application.seedConversationHistory(secondStore);
  const observed: { kind: string; url: string; status?: number }[] = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname === '/api/companies/company-a/conversations') observed.push({ kind: 'request', url: url.pathname + url.search }); });
  page.on('response', response => { const url = new URL(response.url()); if (url.pathname === '/api/companies/company-a/conversations') observed.push({ kind: 'response', url: url.pathname + url.search, status: response.status() }); });
  try {
    const start = new URL(messagesURL(application, firstStore));
    start.searchParams.set('field', 'order'); start.searchParams.set('search', 'SYNTHETIC-ORDER-001');
    await page.goto(start.toString());
    await queueCounts(page, 1, 0, 1);
    await page.getByRole('button', { name: '清除搜索', exact: true }).click();
    // Consecutive user actions must compose even if navigation is still pending.
    await page.getByLabel('筛选店铺', { exact: true }).selectOption(secondStore);
    await expect(page.getByLabel('筛选店铺', { exact: true })).toHaveValue(secondStore);
    await expect(page.getByLabel('精确标识', { exact: true })).toHaveValue('');
    await queueCounts(page, 2, 0, 2);
    expect(new URL(page.url()).searchParams.has('search')).toBe(false);
  } finally {
    const current = new URL(page.url());
    const path = fileURLToPath(new URL('../../test-results/stage4b6-2026-10-09/queues-rapid-filter-observation.json', import.meta.url));
    await writeFile(path, JSON.stringify({ finalURL: current.pathname + current.search, observed }, null, 2));
  }
});
