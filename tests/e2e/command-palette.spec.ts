import { test as base, expect, type Page } from '@playwright/test';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';

type Application = Awaited<ReturnType<typeof startLocalApplication>>;

const test = base.extend<{ application: Application }>({
  application: async ({}, use) => {
    const app = await startLocalApplication(true, { team: 'roles' });
    try {
      await use(app);
    } finally {
      await app.close();
    }
  },
});

async function openWorkspace(page: Page, application: Application) {
  await page.goto(`${application.baseURL}/login`);
  await page.getByLabel('邮箱', { exact: true }).fill('owner@example.invalid');
  await page.getByLabel('密码', { exact: true }).fill(application.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '测试公司 A', exact: true }).click();
  await expect(page.getByRole('heading', { name: '公司工作区', exact: true })).toBeVisible();
}

test('command palette filters with the keyboard and navigates on Enter', async ({ page, application }) => {
  await openWorkspace(page, application);

  await page.keyboard.press('Meta+k');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const input = dialog.getByRole('combobox', { name: '搜索页面', exact: true });
  await expect(input).toBeFocused();
  await expect(dialog.getByRole('option')).toHaveCount(12);

  await input.fill('知识');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await expect(dialog.getByRole('option').first()).toContainText('知识库');

  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: '知识库', exact: true })).toBeVisible();
});

test('command palette reports an empty result instead of an empty list', async ({ page, application }) => {
  await openWorkspace(page, application);

  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: '搜索页面', exact: true }).fill('不存在的页面');
  await expect(dialog.getByText('没有匹配的页面', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('option')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: '公司工作区', exact: true })).toBeVisible();
});
