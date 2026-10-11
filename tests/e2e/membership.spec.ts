import { test as base, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';

type Application = Awaited<ReturnType<typeof startLocalApplication>>;
const test = base.extend<{ application: Application }>({
  application: async ({}, use) => {
    const application = await startLocalApplication(true, { mail: true, team: 'roles' });
    try { await use(application); } finally { await application.close(); }
  },
});

async function signIn(page: Page, application: Application, actor: 'owner' | 'admin' | 'member', team = true) {
  await page.goto(`${application.baseURL}/login`);
  await page.getByLabel('邮箱', { exact: true }).fill(`${actor}@example.invalid`);
  await page.getByLabel('密码', { exact: true }).fill(application.password).catch(() => { throw new Error('Synthetic password input failed'); });
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '测试公司 A', exact: true }).click();
  await expect(page.getByRole('heading', { name: '公司工作区', exact: true })).toBeVisible();
  if (team) {
    await page.getByRole('link', { name: '团队成员', exact: true }).click();
    await expect(page.getByRole('heading', { name: '团队成员', exact: true })).toBeVisible();
  }
}

async function roleDialog(page: Page, name: string, role: 'owner' | 'admin' | 'member') {
  await page.getByRole('button', { name: `修改 ${name} 的角色`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改成员角色', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('公司角色', { exact: true }).selectOption(role);
  return dialog;
}

async function companies(page: Page, application: Application) {
  const response = await page.request.get(`${application.baseURL}/api/companies`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<{ companies: { id: string; role: string }[]; activeCompanyId: string | null }>;
}

async function expectMemberCannotManage(page: Page, application: Application) {
  await expect(page.getByRole('button', { name: /^修改 .* 的角色$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发送邀请', exact: true })).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'owner@example.invalid', exact: true })).toHaveCount(0);
  expect((await page.request.get(`${application.baseURL}/api/companies/company-a/members`)).status()).toBe(403);
  expect((await page.request.post(`${application.baseURL}/api/companies/company-a/invitations`, {
    headers: { origin: application.baseURL }, data: { email: 'not-created@example.invalid', role: 'member' },
  })).status()).toBe(403);
  expect((await companies(page, application)).companies.find(company => company.id === 'company-a')?.role).toBe('member');
}

test('owner changes a member role with cancel and pending-submit protection on a narrow screen', async ({ page, application }) => {
  await signIn(page, application, 'owner');
  await page.setViewportSize({ width: 390, height: 844 });
  let writes = 0;
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/companies/company-a/members/member-a/role', async route => {
    writes += 1;
    await gate;
    await route.continue();
  });
  try {
    const canceled = await roleDialog(page, 'Fixture Member', 'admin');
    await canceled.getByRole('button', { name: '取消', exact: true }).click();
    await expect(canceled).toBeHidden();
    expect(writes).toBe(0);
    const dialog = await roleDialog(page, 'Fixture Member', 'admin');
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
    await dialog.getByRole('button', { name: '保存角色', exact: true }).dblclick();
    await expect.poll(() => writes).toBe(1);
    await expect(dialog.getByRole('button', { name: /保存角色|保存中/ })).toBeDisabled();
    release();
    await expect(dialog).toBeHidden();
    const row = page.getByRole('row').filter({ hasText: 'member@example.invalid' });
    await expect(row.getByText('管理员', { exact: true })).toBeVisible();
    await page.reload();
    await expect(row.getByText('管理员', { exact: true })).toBeVisible();
    const revert = await roleDialog(page, 'Fixture Member', 'member');
    await revert.getByRole('button', { name: '保存角色', exact: true }).click();
    await expect(revert).toBeHidden();
    await expect(row.getByText('成员', { exact: true })).toBeVisible();
    expect(writes).toBe(2);
    const protectedOwner = await roleDialog(page, 'Fixture Owner', 'admin');
    await expect(protectedOwner.getByLabel('当前密码', { exact: true })).toBeEmpty();
    const evidence = fileURLToPath(new URL('../../test-results/stage2d-2026-10-09/', import.meta.url));
    await mkdir(evidence, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: `${evidence}member-dialog-desktop.png`, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
    await expect(protectedOwner.getByRole('button', { name: '保存角色', exact: true })).toBeInViewport();
    await page.screenshot({ path: `${evidence}member-dialog-mobile.png`, animations: 'disabled' });
    await protectedOwner.getByLabel('当前密码', { exact: true }).fill(application.password).catch(() => { throw new Error('Synthetic confirmation input failed'); });
    const ownerResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/companies/company-a/members/owner-a/role');
    await protectedOwner.getByRole('button', { name: '保存角色', exact: true }).click();
    const rejected = await ownerResponse;
    const rejection = await rejected.json();
    expect({ status: rejected.status(), code: rejection.error?.code }).toEqual({ status: 409, code: 'LAST_OWNER_REQUIRED' });
    await expect(protectedOwner).toBeHidden();
    await expect(page.getByRole('alert')).toContainText('至少一名所有者');
    expect((await companies(page, application)).companies.find(company => company.id === 'company-a')?.role).toBe('owner');
  } finally { release(); }
});

test('administrator self-demotion removes management controls without losing another company', async ({ page, application }) => {
  await signIn(page, application, 'admin');
  const dialog = await roleDialog(page, 'Fixture Admin', 'member');
  await dialog.getByRole('button', { name: '保存角色', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expectMemberCannotManage(page, application);
  expect((await companies(page, application)).companies.find(company => company.id === 'company-b')?.role).toBe('owner');
  expect((await page.request.get(`${application.baseURL}/api/auth/get-session`)).status()).toBe(200);
});

test('another session demotion clears an already-open administration page on revalidation', async ({ page, browser, application }) => {
  await signIn(page, application, 'owner');
  const context = await browser.newContext();
  try {
    const administrator = await context.newPage();
    await signIn(administrator, application, 'admin');
    await expect(administrator.getByRole('button', { name: '修改 Fixture Member 的角色', exact: true })).toBeVisible();
    const dialog = await roleDialog(page, 'Fixture Admin', 'member');
    await dialog.getByRole('button', { name: '保存角色', exact: true }).click();
    await expect(dialog).toBeHidden();
    const refreshed = administrator.waitForResponse(response => new URL(response.url()).pathname === '/api/companies');
    await administrator.evaluate(`(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    })()`);
    await refreshed;
    await expectMemberCannotManage(administrator, application);
  } finally { await context.close(); }
});

test('removing a member invalidates the old company session while preserving access to another company', async ({ page, browser, application }) => {
  await signIn(page, application, 'owner');
  const context = await browser.newContext();
  try {
    const member = await context.newPage();
    await signIn(member, application, 'member', false);
    await page.getByRole('button', { name: '移除 Fixture Member', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '移除成员', exact: true });
    await dialog.getByRole('button', { name: '确认移除', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('cell', { name: 'member@example.invalid', exact: true })).toHaveCount(0);
    expect((await member.request.get(`${application.baseURL}/api/companies/company-a`)).status()).toBe(404);
    const remaining = await companies(member, application);
    expect(remaining.activeCompanyId).toBe(null);
    expect(remaining.companies).toEqual([expect.objectContaining({ id: 'company-b', role: 'member' })]);
    await member.reload();
    await expect(member.getByRole('heading', { name: '选择公司', exact: true })).toBeVisible();
    await expect(member.getByRole('button', { name: '测试公司 A', exact: true })).toHaveCount(0);
    await member.getByRole('button', { name: '测试公司 B', exact: true }).click();
    await expect(member.getByRole('heading', { name: '公司工作区', exact: true })).toBeVisible();
    expect((await member.request.get(`${application.baseURL}/api/companies/company-b`)).status()).toBe(200);
  } finally { await context.close(); }
});

test('an uncertain self-demotion rereads identity without retrying its committed mutation', async ({ page, application }) => {
  await signIn(page, application, 'admin');
  let writes = 0;
  let companyReads = 0;
  page.on('request', request => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/companies') companyReads += 1;
  });
  await page.route('**/api/companies/company-a/members/admin-a/role', async route => {
    writes += 1;
    const committed = await route.fetch();
    expect(committed.status()).toBe(200);
    await route.fulfill({ response: committed, status: 503, contentType: 'application/json', body: JSON.stringify({
      error: { code: 'OPERATION_UNCONFIRMED', message: 'Synthetic completion interruption' }, requestId: crypto.randomUUID(),
    }) });
  });
  const dialog = await roleDialog(page, 'Fixture Admin', 'member');
  await dialog.getByRole('button', { name: '保存角色', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('操作结果暂未确认');
  await expectMemberCannotManage(page, application);
  expect(companyReads).toBeGreaterThanOrEqual(1);
  expect(writes).toBe(1);
});
