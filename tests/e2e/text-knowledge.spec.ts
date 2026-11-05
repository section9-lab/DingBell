import { test as base, expect, type Page } from '@playwright/test';
import { startNodeBrowserApplication } from '../fixtures/node-browser.ts';

type Application = Awaited<ReturnType<typeof startNodeBrowserApplication>>;
const test = base.extend<{ application: Application }>({ application: async ({}, use) => {
  const application = await startNodeBrowserApplication();
  try { await use(application); } finally { await application.close(); }
} });
async function login(page: Page, application: Application, email = 'owner@example.invalid') {
  await page.goto(application.baseURL + '/login');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(application.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '测试公司 A', exact: true }).click();
  await page.goto(application.baseURL + '/workspace/knowledge');
}

test('text knowledge publication is explicit, drafts stay separate, and withdrawal survives reload', async ({ page, application }) => {
  await login(page, application);
  await page.getByRole('button', { name: '新建知识', exact: true }).click();
  await page.getByLabel('知识标题', { exact: true }).fill('退款政策');
  await page.getByLabel('资料语言', { exact: true }).selectOption('zh-CN');
  await page.getByLabel('知识正文', { exact: true }).fill('退款需要核对原始订单。');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '草稿已保存' })).toBeVisible();
  await expect(page.getByTestId('knowledge-effective')).toContainText('尚未发布');
  const id = new URL(page.url()).searchParams.get('document');
  expect(id).toBeTruthy();
  const endpoint = application.baseURL + '/api/companies/company-a/knowledge/' + id;
  expect((await (await page.request.get(endpoint)).json()).document.activeRevision).toBeNull();

  await page.getByRole('button', { name: '让 AI 使用此版本', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认启用', exact: true }).click();
  await expect(page.getByTestId('knowledge-effective')).toContainText('生效版本 v1');
  await page.getByLabel('知识正文', { exact: true }).fill('退款还需要核对商品状态。');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '草稿已保存' })).toBeVisible();
  const saved = await (await page.request.get(endpoint)).json();
  expect(saved.document.activeRevision).toBe(1);
  expect(saved.draft.revision).toBe(2);
  expect(saved.active.source.content).toBe('退款需要核对原始订单。');

  await page.getByRole('button', { name: '撤回发布', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认撤回', exact: true }).click();
  await expect(page.getByTestId('knowledge-effective')).toContainText('尚未发布');
  await page.reload();
  await expect(page.getByTestId('knowledge-effective')).toContainText('尚未发布');
  await expect(page.getByLabel('知识正文', { exact: true })).toHaveValue('退款还需要核对商品状态。');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  expect(application.storeRequests).toHaveLength(0);
  expect(application.replyRequests).toHaveLength(0);
});

test('a regular company member cannot publish text knowledge from the UI or a direct request', async ({ page, application }) => {
  await login(page, application, 'member@example.invalid');
  await expect(page.getByText('需要管理员权限', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建知识', exact: true })).toHaveCount(0);
  const response = await page.request.post(application.baseURL + '/api/companies/company-a/knowledge/' + crypto.randomUUID() + '/text', {
    headers: { origin: application.baseURL }, data: { expectedVersion: 1 },
  });
  expect(response.status()).toBe(403);
  expect(application.replyRequests).toHaveLength(0);
});
