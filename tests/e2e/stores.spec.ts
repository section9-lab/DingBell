import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';

type Application = Awaited<ReturnType<typeof startLocalApplication>>;
type Store = { id: string; status: string; revision: number; credentialVersion: number; hasCredentials: boolean; checkedAt: string | null; capabilities: { code: string; status: string; reason: string }[] };
const test = base.extend<{ application: Application; credentialsConfigured: boolean }>({
  credentialsConfigured: [true, { option: true }],
  application: async ({ credentialsConfigured }, use) => {
    const app = await startLocalApplication(true, { mail: true, team: 'roles', stores: credentialsConfigured ? 'configured' : 'unconfigured' });
    try { await use(app); } finally { await app.close(); }
  },
});

async function openStores(page: Page, application: Application, actor = 'owner') {
  await page.goto(`${application.baseURL}/login`);
  await page.getByLabel('邮箱', { exact: true }).fill(`${actor}@example.invalid`);
  await page.getByLabel('密码', { exact: true }).fill(application.password).catch(() => { throw new Error('Synthetic password input failed'); });
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '测试公司 A', exact: true }).click();
  await page.goto(`${application.baseURL}/workspace/stores`);
  await expect(page.getByRole('heading', { name: '店铺管理', exact: true })).toBeVisible();
}

async function prepareStore(page: Page, name = '测试家居店', clientId = '910001') {
  await page.getByRole('button', { name: '添加店铺', exact: true }).click();
  const platform = page.getByRole('dialog', { name: '选择店铺平台', exact: true });
  await expect(platform.getByText('一个公司可以连接多个店铺。', { exact: false })).toBeVisible();
  await platform.getByRole('button', { name: /Ozon/ }).click();
  const dialog = page.getByRole('dialog', { name: '添加 Ozon 店铺', exact: true });
  await dialog.getByLabel('店铺名称', { exact: true }).fill(name);
  await dialog.getByLabel('Client ID', { exact: true }).fill(clientId);
  await dialog.getByLabel('API Key', { exact: true }).fill(crypto.randomUUID()).catch(() => { throw new Error('Synthetic store credential input failed'); });
  return dialog;
}

async function submitStore(page: Page, dialog: Locator, name: string, double = false) {
  const response = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/companies/company-a/stores', { timeout: 10_000 });
  const save = dialog.getByRole('button', { name: '保存店铺', exact: true });
  const [result] = await Promise.all([response, double ? save.dblclick() : save.click()]);
  expect(result.ok()).toBe(true);
  const store = (await result.json()).store as Store;
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  return store;
}

async function addStore(page: Page, application: Application, name = '测试家居店', clientId = '910001', double = false) {
  const dialog = await prepareStore(page, name, clientId);
  return submitStore(page, dialog, name, double);
}

async function readStore(page: Page, application: Application, id: string) {
  const response = await page.request.get(`${application.baseURL}/api/companies/company-a/stores/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).store as Store;
}

async function checkStore(page: Page, id: string) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === `/api/companies/company-a/stores/${id}/check`);
  await page.getByRole('button', { name: '检查只读能力', exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(page.getByRole('button', { name: '访问权限', exact: true })).toBeVisible();
}

test('a new store persists without implicitly checking capabilities or granting member access', async ({ page, browser, application }) => {
  await openStores(page, application);
  let posts = 0;
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/companies/company-a/stores', async route => {
    if (route.request().method() === 'POST') { posts += 1; await gate; }
    await route.continue();
  });
  let store: Store;
  const dialog = await prepareStore(page);
  const created = submitStore(page, dialog, '测试家居店', true);
  const settled = created.then(() => {}, () => {});
  try {
    await expect.poll(() => posts).toBe(1);
    await expect(page.getByRole('button', { name: '保存店铺', exact: true })).toBeDisabled();
    release();
    store = await created;
  } finally { release(); await settled; }
  expect(posts).toBe(1);
  expect(store.status).toBe('unverified');
  expect(store.hasCredentials).toBe(true);
  expect(application.storeRequests).toEqual([]);
  await page.getByRole('button', { name: '返回店铺列表', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看 测试家居店', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '查看 测试家居店', exact: true })).toBeVisible();
  const memberContext = await browser.newContext();
  try {
    const member = await memberContext.newPage();
    await openStores(member, application, 'member');
    await expect(member.getByText('暂无可访问的店铺', { exact: true })).toBeVisible();
    expect((await member.request.get(`${application.baseURL}/api/companies/company-a/stores/${store.id}`)).status()).toBe(404);
  } finally { await memberContext.close(); }
});

test.describe('store credential configuration is absent', () => {
  test.use({ credentialsConfigured: false });
  test('the account stays usable while credential forms fail closed', async ({ page, application }) => {
    await openStores(page, application);
    await expect(page.getByText('店铺凭证加密尚未配置', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '添加店铺', exact: true })).toBeDisabled();
    await expect(page.getByLabel('API Key', { exact: true })).toHaveCount(0);
    expect((await page.request.get(`${application.baseURL}/api/auth/get-session`)).status()).toBe(200);
    const response = await page.request.post(`${application.baseURL}/api/companies/company-a/stores`, {
      headers: { origin: application.baseURL }, data: { id: crypto.randomUUID(), name: '不能创建的店铺', clientId: '910001', apiKey: crypto.randomUUID() },
    });
    expect(response.status()).toBe(503);
    expect((await response.json()).error.code).toBe('CREDENTIALS_NOT_CONFIGURED');
    expect(application.storeRequests).toEqual([]);
  });
});

test('read-only checks display partial access and keep temporary provider failures distinct from unsupported features', async ({ page, application }) => {
  await openStores(page, application);
  const store = await addStore(page, application);
  await checkStore(page, store.id);
  const checked = await readStore(page, application, store.id);
  const states = Object.fromEntries(checked.capabilities.map(item => [item.code, item.status]));
  expect(states).toMatchObject({ auth: 'available', products_read: 'available', chats_read: 'denied', orders_fbs_read: 'available', reply: 'unknown', proactive_chat: 'unknown' });
  await expect(page.getByText('部分能力可用', { exact: true })).toBeVisible();
  await expect(page.getByText('权限不足', { exact: true })).toBeVisible();
  expect(application.storeRequests.map(item => item.path).sort()).toEqual(['/v1/roles', '/v3/chat/list', '/v3/product/list', '/v4/posting/fbs/list']);
  expect(application.storeRequests.every(item => item.method === 'POST')).toBe(true);
  const evidence = fileURLToPath(new URL('../../test-results/stage2e-2026-10-09/', import.meta.url));
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}stores-desktop.png`, fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.screenshot({ path: `${evidence}stores-mobile.png`, fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const [behavior, name, clientId] of [['unavailable', '暂时不可用店铺', '910002'], ['rate-limited', '暂时限流店铺', '910003']] as const) {
    application.setStoreBehavior(behavior);
    const transient = await addStore(page, application, name, clientId);
    await checkStore(page, transient.id);
    const result = await readStore(page, application, transient.id);
    expect(result.capabilities.every(item => item.status !== 'unsupported' && item.status !== 'available')).toBe(true);
    expect(result.hasCredentials).toBe(true);
    expect(['unverified', 'attention']).toContain(result.status);
    await expect(page.getByText('只读验证通过', { exact: true })).toHaveCount(0);
  }
});

test('store grants become visible only after assignment and revocation rejects an already-open member session', async ({ page, browser, application }) => {
  await openStores(page, application);
  const store = await addStore(page, application);
  const memberContext = await browser.newContext();
  try {
    const member = await memberContext.newPage();
    await openStores(member, application, 'member');
    await expect(member.getByText('暂无可访问的店铺', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '访问权限', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '店铺访问权限', exact: true });
    await dialog.getByRole('button', { name: '授权给 Fixture Member', exact: true }).click();
    await expect(dialog).toBeHidden();
    await member.reload();
    await member.getByRole('button', { name: '查看 测试家居店', exact: true }).click();
    await expect(member.getByRole('heading', { name: '测试家居店', exact: true })).toBeVisible();
    await expect(member.getByRole('button', { name: '更新凭证', exact: true })).toHaveCount(0);
    const extra = await addStore(page, application, '未授权新店', '910002');
    expect((await member.request.get(`${application.baseURL}/api/companies/company-a/stores/${extra.id}`)).status()).toBe(404);
    await page.goto(`${application.baseURL}/workspace/stores?store=${store.id}`);
    await page.getByRole('button', { name: '访问权限', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '店铺访问权限', exact: true });
    await dialog.getByRole('button', { name: '撤销 Fixture Member 的访问权限', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect((await member.request.get(`${application.baseURL}/api/companies/company-a/stores/${store.id}`)).status()).toBe(404);
    const rechecked = member.waitForResponse(response => new URL(response.url()).pathname === `/api/companies/company-a/stores/${store.id}`);
    await member.evaluate(`(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    })()`);
    await rechecked;
    await expect(member.getByRole('heading', { name: '测试家居店', exact: true })).toHaveCount(0);
    await expect(member.getByRole('alert').filter({ hasText: '此内容不可访问' })).toBeVisible();
    const companies = await member.request.get(`${application.baseURL}/api/companies`);
    expect((await companies.json()).companies.map((company: { id: string }) => company.id).sort()).toEqual(['company-a', 'company-b']);
  } finally { await memberContext.close(); }
});

test('a committed credential change with a lost acknowledgement is reread without repeating the write', async ({ page, application }) => {
  await openStores(page, application);
  const store = await addStore(page, application);
  const replacement = crypto.randomUUID();
  let writes = 0;
  let reads = 0;
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname.includes('/stores')) reads += 1; });
  await page.route(`**/api/companies/company-a/stores/${store.id}/credentials`, async route => {
    writes += 1;
    const committed = await route.fetch();
    expect(committed.ok()).toBe(true);
    await route.fulfill({ response: committed, status: 503, contentType: 'application/json', body: JSON.stringify({
      error: { code: 'OPERATION_UNCONFIRMED', message: 'Synthetic completion interruption' }, requestId: crypto.randomUUID(),
    }) });
  });
  await page.getByRole('button', { name: '更新凭证', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '更新店铺凭证', exact: true });
  await expect(dialog.getByLabel('API Key', { exact: true })).toBeEmpty();
  await dialog.getByLabel('API Key', { exact: true }).fill(replacement).catch(() => { throw new Error('Synthetic store credential input failed'); });
  await dialog.getByRole('button', { name: '保存新凭证', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('alert').filter({ hasText: '操作结果暂未确认' })).toBeVisible();
  const current = await readStore(page, application, store.id);
  expect(current.credentialVersion).toBe(store.credentialVersion + 1);
  expect(current.status).toBe('unverified');
  expect(writes).toBe(1);
  expect(reads).toBeGreaterThan(0);
  expect(JSON.stringify(current).includes(replacement)).toBe(false);
  expect((await page.locator('body').innerText()).includes(replacement)).toBe(false);
  expect(await page.evaluate('localStorage.length + sessionStorage.length')).toBe(0);
  expect(application.storeRequests).toEqual([]);
});

test('pause and disconnect retain store history while suppressing checks and deleting saved credentials', async ({ page, application }) => {
  await openStores(page, application);
  const store = await addStore(page, application);
  for (const [label, status] of [['暂停连接', 'paused'], ['恢复连接', 'unverified'], ['断开连接', 'disconnected']] as const) {
    await page.getByRole('button', { name: label, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: label, exact: true });
    await dialog.getByRole('button', { name: `确认${label}`, exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { name: '测试家居店', exact: true })).toBeVisible();
    const current = await readStore(page, application, store.id);
    expect(current.status).toBe(status);
    expect(current.hasCredentials).toBe(status !== 'disconnected');
    if (status !== 'unverified') await expect(page.getByRole('button', { name: '检查只读能力', exact: true })).toBeDisabled();
  }
  expect(application.storeRequests).toEqual([]);
  await page.reload();
  await expect(page.getByText('已断开', { exact: true })).toBeVisible();
  await expect(page.getByText(/未保存凭证/)).toBeVisible();
});
