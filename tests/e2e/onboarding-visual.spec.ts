import { mkdir } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';

type Application = Awaited<ReturnType<typeof startLocalApplication>>;
const evidence = fileURLToPath(new URL('../../test-results/stage2c-2026-10-09/', import.meta.url));
const test = base.extend<{ application: Application; empty: boolean }>({
  empty: [false, { option: true }],
  application: async ({ empty }, use) => {
    const app = await startLocalApplication(true, { mail: true, empty });
    try { await use(app); } finally { await app.close(); }
  },
});

async function expectNoPageOverflow(page: Page) {
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
}

async function screenshot(page: Page, name: string) {
  await mkdir(evidence, { recursive: true });
  // Capture only authenticated pages or the empty installation form, never filled credentials.
  await page.screenshot({ path: `${evidence}${name}.png`, fullPage: true, animations: 'disabled' });
}

test('team invitation form stays usable at 390px and mobile navigation closes after choosing a page', async ({ page, application }) => {
  await page.goto(`${application.baseURL}/login`);
  await page.getByLabel('邮箱', { exact: true }).fill('owner@example.invalid');
  await page.getByLabel('密码', { exact: true }).fill(application.password).catch(() => { throw new Error('Synthetic password input failed'); });
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '测试公司 A', exact: true }).click();
  await page.getByRole('link', { name: '团队成员', exact: true }).click();
  await expect(page.getByRole('heading', { name: '团队成员', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '当前成员', exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
  await screenshot(page, 'team-desktop');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('成员邮箱', { exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '发送邀请', exact: true })).toBeInViewport();
  await expectNoPageOverflow(page);
  await page.getByLabel('成员邮箱', { exact: true }).fill('visual-colleague@example.invalid');
  await page.getByRole('button', { name: '发送邀请', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '邀请已提交邮件服务' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'visual-colleague@example.invalid', exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
  await screenshot(page, 'team-mobile');

  await page.getByRole('button', { name: '打开或收起导航', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('link', { name: '开始使用', exact: true }).click();
  await expect(page).toHaveURL(`${application.baseURL}/workspace`);
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('heading', { name: '公司工作区', exact: true })).toBeInViewport();
  await expectNoPageOverflow(page);
});

test.describe('empty installation layout', () => {
  test.use({ empty: true });
  test('installation entry has an empty token field and reachable primary action on desktop and phone', async ({ page, application }) => {
    await page.goto(`${application.baseURL}/setup`);
    await expect(page.getByRole('heading', { name: '首次安装 DingBell', exact: true })).toBeVisible();
    await expect(page.getByLabel('安装令牌', { exact: true })).toBeEmpty();
    await expect(page.getByRole('button', { name: '验证安装权限', exact: true })).toBeInViewport();
    await expectNoPageOverflow(page);
    await screenshot(page, 'setup-desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel('安装令牌', { exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: '验证安装权限', exact: true })).toBeInViewport();
    await expectNoPageOverflow(page);
    await screenshot(page, 'setup-mobile');
  });
});
