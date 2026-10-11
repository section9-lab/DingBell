import { test as base, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';

type Application = Awaited<ReturnType<typeof startLocalApplication>>;
type SyncState = { enabled: boolean; epoch: number; conversationCount: number; messageCount: number; lastError: string | null };
const test = base.extend<{ application: Application }>({
  application: async ({}, use) => {
    const app = await startLocalApplication(true, { mail: true, team: 'roles', stores: 'configured', sync: true });
    try { await use(app); } finally { await app.close(); }
  },
});

async function login(page: Page, application: Application, actor = 'owner') {
  await page.goto(`${application.baseURL}/login`);
  await page.getByLabel('邮箱', { exact: true }).fill(`${actor}@example.invalid`);
  await page.getByLabel('密码', { exact: true }).fill(application.password).catch(() => { throw new Error('Synthetic password input failed'); });
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '测试公司 A', exact: true }).click();
}
const syncURL = (application: Application, id: string) => `${application.baseURL}/api/companies/company-a/stores/${id}/sync`;
async function state(page: Page, application: Application, id: string): Promise<SyncState> {
  const response = await page.request.get(syncURL(application, id));
  expect(response.status()).toBe(200); return (await response.json()).sync;
}
async function store(page: Page, application: Application, name = '同步测试店', clientId = '910001') {
  const id = crypto.randomUUID();
  const response = await page.request.post(`${application.baseURL}/api/companies/company-a/stores`, { headers: { origin: application.baseURL }, data: { id, name, clientId, apiKey: crypto.randomUUID() } });
  expect(response.ok()).toBe(true);
  await page.goto(`${application.baseURL}/workspace/stores?store=${id}`);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '会话同步', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '启用会话同步', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '检查只读能力', exact: true }).click();
  await expect(page.getByRole('button', { name: '启用会话同步', exact: true })).toBeEnabled();
  return id;
}
async function toggle(page: Page, enabled: boolean) {
  const label = enabled ? '启用会话同步' : '停止会话同步';
  await page.getByRole('button', { name: label, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: label, exact: true });
  await dialog.getByRole('button', { name: enabled ? '确认启用' : '确认停止', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('the real coordinator imports paged buyer history exactly once and the manager can stop it', async ({ page, application }) => {
  await login(page, application); const id = await store(page, application);
  await toggle(page, true);
  await expect.poll(async () => { const current = await state(page, application, id); return [current.conversationCount, current.messageCount]; }, { timeout: 20_000 }).toEqual([2, 6]);
  await expect(page.getByText('已导入会话', { exact: true })).toBeVisible();
  await expect(page.getByText('已导入消息', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '会话同步', exact: true }).getByText('6', { exact: true })).toBeVisible();
  expect(application.storeRequests.some(request => request.path === '/v3/chat/history' && request.body?.chat_id === 'support-only')).toBe(false);
  expect(application.storeRequests.some(request => request.path === '/v3/chat/history' && request.body?.from_message_id === '3000000000817031941')).toBe(true);
  expect(application.storeRequests.every(request => ['/v1/roles', '/v3/product/list', '/v3/chat/list', '/v3/chat/history', '/v4/posting/fbs/list'].includes(request.path))).toBe(true);
  const evidence = fileURLToPath(new URL('../../test-results/stage3a-2026-10-09/', import.meta.url));
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}sync-desktop.png`, fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${evidence}sync-mobile.png`, fullPage: true, animations: 'disabled' });
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await toggle(page, false);
  await expect.poll(async () => (await state(page, application, id)).enabled).toBe(false);
  await page.reload();
  const stopped = await state(page, application, id);
  expect(stopped).toMatchObject({ enabled: false, conversationCount: 2, messageCount: 6 });
});

test('pausing a store and replacing its credentials stop synchronization without losing imported history', async ({ page, application }) => {
  await login(page, application); const id = await store(page, application);
  await toggle(page, true);
  await expect.poll(async () => (await state(page, application, id)).messageCount, { timeout: 20_000 }).toBe(6);
  await page.getByRole('button', { name: '暂停连接', exact: true }).click();
  await page.getByRole('dialog', { name: '暂停连接', exact: true }).getByRole('button', { name: '确认暂停连接', exact: true }).click();
  await expect.poll(async () => (await state(page, application, id)).enabled).toBe(false);
  await expect(page.getByRole('button', { name: '启用会话同步', exact: true })).toBeDisabled();
  expect(await state(page, application, id)).toMatchObject({ enabled: false, conversationCount: 2, messageCount: 6 });
  const replacementId = await store(page, application, '凭证更换测试店', '910002');
  await toggle(page, true);
  await expect.poll(async () => (await state(page, application, replacementId)).messageCount, { timeout: 20_000 }).toBe(6);
  await page.getByRole('button', { name: '更新凭证', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '更新店铺凭证', exact: true });
  await dialog.getByLabel('API Key', { exact: true }).fill(crypto.randomUUID());
  await dialog.getByRole('button', { name: '保存新凭证', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await state(page, application, replacementId)).toMatchObject({ enabled: false, conversationCount: 2, messageCount: 6 });
  await expect(page.getByRole('button', { name: '启用会话同步', exact: true })).toBeDisabled();
});

test('granted members can read sync progress but cannot change it and revocation removes their open view', async ({ page, browser, application }) => {
  await login(page, application); const id = await store(page, application);
  const grantURL = `${application.baseURL}/api/companies/company-a/stores/${id}/grants/member-a`;
  expect((await page.request.post(grantURL, { headers: { origin: application.baseURL }, data: { expectedGranted: false, granted: true } })).ok()).toBe(true);
  const memberContext = await browser.newContext();
  try {
    const member = await memberContext.newPage(); await login(member, application, 'member');
    await member.goto(`${application.baseURL}/workspace/stores?store=${id}`);
    await expect(member.getByRole('heading', { name: '会话同步', exact: true })).toBeVisible();
    await expect(member.getByRole('button', { name: '启用会话同步', exact: true })).toHaveCount(0);
    expect((await member.request.post(syncURL(application, id), { headers: { origin: application.baseURL }, data: { enabled: true, expectedEpoch: 0 } })).status()).toBe(403);
    expect((await page.request.post(grantURL, { headers: { origin: application.baseURL }, data: { expectedGranted: true, granted: false } })).ok()).toBe(true);
    expect((await member.request.get(syncURL(application, id))).status()).toBe(404);
    await member.evaluate(`(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); })()`);
    await expect(member.getByRole('heading', { name: '同步测试店', exact: true })).toHaveCount(0);
    await expect(member.getByRole('heading', { name: '会话同步', exact: true })).toHaveCount(0);
  } finally { await memberContext.close(); }
});

test('an open confirmation keeps its original epoch when background polling observes another manager change', async ({ page, application }) => {
  await login(page, application); const id = await store(page, application);
  await page.getByRole('button', { name: '启用会话同步', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '启用会话同步', exact: true });
  await expect(dialog).toBeVisible();
  const refreshed = page.waitForResponse(async response => response.request().method() === 'GET' && response.url() === syncURL(application, id) && response.ok() && (await response.json()).sync.epoch === 2);
  for (const [enabled, expectedEpoch] of [[true, 0], [false, 1]] as const) {
    const response = await page.request.post(syncURL(application, id), { headers: { origin: application.baseURL }, data: { enabled, expectedEpoch } });
    expect(response.status()).toBe(200);
  }
  await refreshed;
  await expect(dialog).toBeVisible();
  const attempted = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === syncURL(application, id));
  await dialog.getByRole('button', { name: '确认启用', exact: true }).click();
  const response = await attempted;
  expect(response.request().postDataJSON()).toEqual({ enabled: true, expectedEpoch: 0 });
  expect(response.status()).toBe(409);
  expect((await response.json()).error.code).toBe('SYNC_CHANGED');
  await expect(dialog).toBeHidden();
  expect(await state(page, application, id)).toMatchObject({ enabled: false, epoch: 2 });
});
